/**
 * Integration tests for the audio WAV→FLAC compression core.
 *
 * Covers the synchronous validation + single-flight + cancel + preview paths
 * in `audio-compression-core.ts` plus `compression-actions.ts`. The background
 * processor itself is fire-and-forget; we stub the FLAC runner so it does no
 * real work and the test does not depend on python-soundfile being installed.
 *
 * Uses the in-memory DB pattern (NOT setupDbMock — that helper's vi.mock("@/db")
 * hoists across the suite and breaks integration tests, per institutional
 * MEMORY.md learning).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as schema from "@/db/schema";
import { eq, and } from "drizzle-orm";
import {
  createTestDb,
  testDbRef,
  setupIntegrationDbMock,
  type TestDb,
} from "../helpers/test-db";
import {
  setupAuthMocks,
  mockRequirePermission,
  testUser,
} from "../helpers/mock-auth";

setupIntegrationDbMock();
setupAuthMocks();

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

// Stub the FLAC runner — the test should not require a real Python venv.
vi.mock("@/lib/flac-runner", () => ({
  runFlacEncoding: vi.fn(async () => ({
    success: true as const,
    totalProcessed: 0,
    totalSkipped: 0,
  })),
}));

// Stub the Drive client and audio cache; the core lib never reaches them in
// these tests because the processor either bails early or we never wait for
// the fire-and-forget worker.
vi.mock("@/lib/drive-client", () => ({
  getFileMetadataWithRevision: vi.fn(async () => null),
  replaceFileContentAndRename: vi.fn(async () => ({
    headRevisionId: "rev_new",
    size: 1000,
  })),
  pinFileRevision: vi.fn(async () => {}),
  downloadFileRevision: vi.fn(async () => Buffer.from("wav-bytes")),
}));
vi.mock("@/lib/audio-cache", () => ({
  ensureAudioCached: vi.fn(async (id: number) => `/tmp/audio-${id}.wav`),
}));

const compressionMod = await import("@/app/audio/compression-actions");
const core = await import("@/lib/audio-compression-core");

let db: TestDb;
let ctProjectId: number;
let deploymentId: number;

beforeEach(() => {
  vi.clearAllMocks();
  db = createTestDb();
  testDbRef.current = db;
  mockRequirePermission.mockResolvedValue(testUser);

  db.insert(schema.users)
    .values({ email: testUser.email, name: testUser.name })
    .onConflictDoNothing()
    .run();

  const [ctProject] = db
    .insert(schema.cameraTrapProjects)
    .values({ name: "FlacTestProject" })
    .returning()
    .all();
  ctProjectId = ctProject.id;

  db.insert(schema.cameraTrapProjectAccess)
    .values({ userEmail: testUser.email, cameraTrapProjectId: ctProjectId })
    .onConflictDoNothing()
    .run();

  const [dep] = db
    .insert(schema.deployments)
    .values({
      projectId: "camera-trap",
      name: "FLAC-001",
      status: "scanned",
      cameraTrapProjectId: ctProjectId,
      siteName: "FLAC-001",
      uploadAudioFolderId: "drive_xyz",
    })
    .returning()
    .all();
  deploymentId = dep.id;

  // Enable the feature for tests
  process.env.AUDIO_COMPRESSION_ENABLED = "true";
});

describe("getAudioCompressionPreview", () => {
  it("counts uncompressed WAV files with a Drive ID", async () => {
    db.insert(schema.audioFiles)
      .values([
        {
          deploymentId,
          filename: "a.wav",
          driveFileId: "drive_a",
          fileSize: 1_000_000,
          compressed: false,
        },
        {
          deploymentId,
          filename: "b.wav",
          driveFileId: "drive_b",
          fileSize: 2_000_000,
          compressed: false,
        },
        {
          deploymentId,
          filename: "already.flac",
          driveFileId: "drive_c",
          fileSize: 500_000,
          compressed: true,
        },
        {
          // no driveFileId — excluded
          deploymentId,
          filename: "orphan.wav",
          driveFileId: null,
          fileSize: 100,
          compressed: false,
        },
      ])
      .run();

    const result = await compressionMod.getAudioCompressionPreviewAction([
      deploymentId,
    ]);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.count).toBe(2);
    // 3 MB total (1+2)
    expect(result.data.totalSizeMB).toBeCloseTo(2.9, 0);
    expect(result.data.estimatedSavedMB).toBeGreaterThan(0);
  });

  it("returns zeros for empty input list", async () => {
    const r = await compressionMod.getAudioCompressionPreviewAction([]);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.count).toBe(0);
    expect(r.data.totalSizeMB).toBe(0);
  });
});

describe("enqueueAudioCompressionJob — validation", () => {
  it("refuses when AUDIO_COMPRESSION_ENABLED is not set", async () => {
    process.env.AUDIO_COMPRESSION_ENABLED = "false";
    db.insert(schema.audioFiles)
      .values({
        deploymentId,
        filename: "a.wav",
        driveFileId: "drive_a",
        fileSize: 1000,
        compressed: false,
      })
      .run();

    const r = await core.enqueueAudioCompressionJob({
      deploymentId,
      actorEmail: testUser.email,
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error).toContain("deshabilitada");
  });

  it("refuses when no uncompressed WAVs exist", async () => {
    const r = await core.enqueueAudioCompressionJob({
      deploymentId,
      actorEmail: testUser.email,
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error).toContain("WAV pendientes");
  });

  it("queues behind an in-flight compression on another deployment (no rejection)", async () => {
    db.insert(schema.audioFiles)
      .values({
        deploymentId,
        filename: "a.wav",
        driveFileId: "drive_a",
        fileSize: 1000,
        compressed: false,
      })
      .run();
    // Stand up a parallel deployment with an in-flight compression. Under the
    // unified queue this no longer rejects — the second compression is just
    // enqueued as `pending` and the queue picker will run it later.
    const [otherDep] = db
      .insert(schema.deployments)
      .values({
        projectId: "camera-trap",
        name: "OTHER",
        status: "scanned",
        cameraTrapProjectId: ctProjectId,
        uploadAudioFolderId: "drive_o",
      })
      .returning()
      .all();
    db.insert(schema.processingJobs)
      .values({
        deploymentId: otherDep.id,
        jobType: "audio_compression",
        status: "processing",
        totalImages: 1,
      })
      .run();

    const r = await core.enqueueAudioCompressionJob({
      deploymentId,
      actorEmail: testUser.email,
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    // The second compression is in the queue as pending — the picker won't
    // start it while the other deployment's row is still `processing`.
    const [row] = db
      .select()
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.id, r.data.jobId))
      .all();
    expect(row.status).toBe("pending");
  });

  it("blocks if any audio job is in flight on the same deployment", async () => {
    db.insert(schema.audioFiles)
      .values({
        deploymentId,
        filename: "a.wav",
        driveFileId: "drive_a",
        fileSize: 1000,
        compressed: false,
      })
      .run();
    db.insert(schema.processingJobs)
      .values({
        deploymentId,
        jobType: "birdnet",
        status: "processing",
        totalImages: 1,
      })
      .run();

    const r = await core.enqueueAudioCompressionJob({
      deploymentId,
      actorEmail: testUser.email,
    });
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error).toContain("trabajo activo");
  });
});

describe("cancelAudioCompressionJob", () => {
  it("marks an in-flight audio_compression job cancelled", async () => {
    const [job] = db
      .insert(schema.processingJobs)
      .values({
        deploymentId,
        jobType: "audio_compression",
        status: "processing",
        totalImages: 10,
      })
      .returning()
      .all();

    const r = await core.cancelAudioCompressionJob({
      jobId: job.id,
      actorEmail: testUser.email,
    });
    expect(r.success).toBe(true);

    const [after] = db
      .select()
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.id, job.id))
      .all();
    expect(after.status).toBe("cancelled");
  });

  it("refuses to cancel a non-audio-compression job", async () => {
    const [job] = db
      .insert(schema.processingJobs)
      .values({
        deploymentId,
        jobType: "birdnet",
        status: "processing",
        totalImages: 10,
      })
      .returning()
      .all();

    const r = await core.cancelAudioCompressionJob({
      jobId: job.id,
      actorEmail: testUser.email,
    });
    expect(r.success).toBe(false);
  });

  it("refuses to cancel a terminal job", async () => {
    const [job] = db
      .insert(schema.processingJobs)
      .values({
        deploymentId,
        jobType: "audio_compression",
        status: "completed",
        totalImages: 10,
      })
      .returning()
      .all();

    const r = await core.cancelAudioCompressionJob({
      jobId: job.id,
      actorEmail: testUser.email,
    });
    expect(r.success).toBe(false);
  });
});

describe("revertDeploymentAudioCompression", () => {
  it("refuses when no revertible files exist", async () => {
    db.insert(schema.audioFiles)
      .values({
        deploymentId,
        filename: "a.flac",
        driveFileId: "drive_a",
        compressed: true,
        // missing original_drive_revision_id → not revertible
      })
      .run();

    const r = await compressionMod.revertDeploymentAudioCompression(deploymentId);
    expect(r.success).toBe(false);
    if (r.success) return;
    expect(r.error).toContain("revertibles");
  });

  it("creates a revert_audio_compression job when files are revertible", async () => {
    db.insert(schema.audioFiles)
      .values({
        deploymentId,
        filename: "a.flac",
        driveFileId: "drive_a",
        fileSize: 500_000,
        originalFileSize: 1_000_000,
        originalDriveRevisionId: "rev_old",
        compressed: true,
      })
      .run();

    const r = await compressionMod.revertDeploymentAudioCompression(deploymentId);
    expect(r.success).toBe(true);
    if (!r.success) return;

    const [job] = db
      .select()
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.id, r.data.jobId))
      .all();
    expect(job).toBeTruthy();
    expect(job.jobType).toBe("revert_audio_compression");
    expect(["pending", "processing", "completed", "failed"]).toContain(
      job.status,
    );
  });
});

describe("getAudioRevertPreview", () => {
  it("only counts files with originalDriveRevisionId AND driveFileId", async () => {
    db.insert(schema.audioFiles)
      .values([
        {
          deploymentId,
          filename: "ok.flac",
          driveFileId: "drive_a",
          fileSize: 500_000,
          originalFileSize: 1_000_000,
          originalDriveRevisionId: "rev_ok",
          compressed: true,
        },
        {
          deploymentId,
          filename: "no_anchor.flac",
          driveFileId: "drive_b",
          fileSize: 400_000,
          originalFileSize: 800_000,
          originalDriveRevisionId: null,
          compressed: true,
        },
        {
          deploymentId,
          filename: "uncompressed.wav",
          driveFileId: "drive_c",
          fileSize: 100,
          compressed: false,
        },
      ])
      .run();

    const r = await compressionMod.getAudioRevertPreviewAction(deploymentId);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.count).toBe(1);
    expect(r.data.reclaimableMB).toBeCloseTo(0.5, 0);
  });
});

describe("cancelProcessingJob router", () => {
  it("routes audio_compression jobs through the new cancel path", async () => {
    const { cancelProcessingJob } = await import("@/app/audio/actions");
    const [job] = db
      .insert(schema.processingJobs)
      .values({
        deploymentId,
        jobType: "audio_compression",
        status: "processing",
        totalImages: 10,
      })
      .returning()
      .all();

    const r = await cancelProcessingJob(job.id);
    expect(r.success).toBe(true);

    const [after] = db
      .select()
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.id, job.id))
      .all();
    expect(after.status).toBe("cancelled");
  });
});

describe("audio_files schema has new columns", () => {
  it("inserts a row with compressed, originalFileSize, originalDriveRevisionId", async () => {
    db.insert(schema.audioFiles)
      .values({
        deploymentId,
        filename: "a.flac",
        driveFileId: "drive_a",
        fileSize: 500_000,
        originalFileSize: 1_000_000,
        originalDriveRevisionId: "rev_abc",
        compressed: true,
      })
      .run();

    const [row] = db
      .select()
      .from(schema.audioFiles)
      .where(and(eq(schema.audioFiles.deploymentId, deploymentId)))
      .all();
    expect(row.compressed).toBe(true);
    expect(row.originalFileSize).toBe(1_000_000);
    expect(row.originalDriveRevisionId).toBe("rev_abc");
  });
});
