/**
 * Integration tests for the combined audio analysis pipeline.
 *
 * Focus is on the synchronous validation + single-flight + cancellation
 * paths in `createAudioAnalysisJob` / `cancelProcessingJob`, plus a direct
 * exercise of the new `releaseFiles` cache helper. The async orchestrator
 * itself (downloads → BirdNET → indices → evict) is fire-and-forget and is
 * covered by the existing patterns in processBirdNETJob / processAcousticIndicesJob.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { promises as fsp } from "fs";
import path from "path";
import os from "os";
import * as schema from "@/db/schema";
import { eq } from "drizzle-orm";
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

// revalidatePath needs the Next.js request context — neutralise it for tests.
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Keep the orchestrator from spawning Python — these only run if the
// fire-and-forget worker fires before the test ends, which we treat as a
// no-op for the purposes of the sync-path assertions below.
vi.mock("@/lib/birdnet-runner", () => ({
  runBirdNETAnalysis: vi.fn(async () => ({
    success: true as const,
    totalProcessed: 0,
    totalDetections: 0,
  })),
}));
vi.mock("@/lib/acoustic-indices-runner", () => ({
  runAcousticIndicesAnalysis: vi.fn(async () => ({
    success: true as const,
    totalProcessed: 0,
    totalSkipped: 0,
  })),
}));

const {
  createAudioAnalysisJob,
  batchCreateAudioAnalysisJobs,
  cancelProcessingJob,
} = await import("@/app/audio/actions");
const { releaseFiles } = await import("@/lib/audio-cache");

let db: TestDb;
let ctProjectId: number;
let deploymentId: number;

beforeEach(() => {
  vi.clearAllMocks();
  db = createTestDb();
  testDbRef.current = db;
  mockRequirePermission.mockResolvedValue(testUser);

  // requireDeploymentAccess uses the real DB — seed the user + access row.
  db.insert(schema.users)
    .values({ email: testUser.email, name: testUser.name })
    .onConflictDoNothing()
    .run();

  const [ctProject] = db
    .insert(schema.cameraTrapProjects)
    .values({ name: "AudioTestProject" })
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
      name: "AUDIO-001_V1",
      status: "scanned",
      cameraTrapProjectId: ctProjectId,
      siteName: "AUDIO-001",
      uploadAudioFolderId: "drive_xyz",
    })
    .returning()
    .all();
  deploymentId = dep.id;
});

describe("createAudioAnalysisJob — validation + single-flight", () => {
  it("rejects when both BirdNET and Indices are deselected", async () => {
    db.insert(schema.audioFiles)
      .values({
        deploymentId,
        filename: "a.wav",
        driveFileId: "drive_a",
      })
      .run();

    const result = await createAudioAnalysisJob({
      deploymentId,
      includeBirdnet: false,
      includeIndices: false,
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain("al menos un análisis");
  });

  it("rejects deployments with no audio files", async () => {
    const result = await createAudioAnalysisJob({ deploymentId });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain("No hay archivos");
  });

  it("rejects when a BirdNET job is already in flight for the deployment", async () => {
    db.insert(schema.audioFiles)
      .values({ deploymentId, filename: "a.wav", driveFileId: "drive_a" })
      .run();
    db.insert(schema.processingJobs)
      .values({
        deploymentId,
        jobType: "birdnet",
        status: "processing",
        totalImages: 1,
      })
      .run();

    const result = await createAudioAnalysisJob({ deploymentId });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain("activo");
  });

  it("rejects when an acoustic_indices job is already in flight", async () => {
    db.insert(schema.audioFiles)
      .values({ deploymentId, filename: "a.wav", driveFileId: "drive_a" })
      .run();
    db.insert(schema.processingJobs)
      .values({
        deploymentId,
        jobType: "acoustic_indices",
        status: "pending",
        totalImages: 1,
      })
      .run();

    const result = await createAudioAnalysisJob({ deploymentId });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain("activo");
  });

  it("creates a pending audio_analysis job row when valid", async () => {
    db.insert(schema.audioFiles)
      .values([
        { deploymentId, filename: "a.wav", driveFileId: "drive_a" },
        { deploymentId, filename: "b.wav", driveFileId: "drive_b" },
      ])
      .run();

    const result = await createAudioAnalysisJob({
      deploymentId,
      includeBirdnet: false,
      includeIndices: true,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const [row] = db
      .select()
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.id, result.data.jobId))
      .all();
    expect(row).toBeTruthy();
    expect(row.jobType).toBe("audio_analysis");
    // Status is either pending (orchestrator hasn't started) or processing
    // (orchestrator transitioned it). Either is correct.
    expect(["pending", "processing", "completed", "failed"]).toContain(row.status);
    expect(row.totalImages).toBe(2);
    expect(row.deploymentId).toBe(deploymentId);
  });
});

describe("releaseFiles", () => {
  it("nulls cachePath and unlinks files on disk (best-effort)", async () => {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "release-files-"));
    const realFile = path.join(tmpDir, "a.wav");
    await fsp.writeFile(realFile, "wav-bytes");

    const ghostPath = path.join(tmpDir, "ghost.wav"); // never created

    const inserted = db
      .insert(schema.audioFiles)
      .values([
        { deploymentId, filename: "a.wav", driveFileId: "drive_a", cachePath: realFile },
        { deploymentId, filename: "ghost.wav", driveFileId: "drive_g", cachePath: ghostPath },
        { deploymentId, filename: "untouched.wav", driveFileId: "drive_u", cachePath: "/tmp/keep-me" },
      ])
      .returning()
      .all();

    const releaseIds = [inserted[0].id, inserted[1].id];
    await releaseFiles(releaseIds);

    // The real file is unlinked.
    await expect(fsp.access(realFile)).rejects.toBeTruthy();

    // cachePath is nulled for the released rows; the third row is untouched.
    const rows = db.select().from(schema.audioFiles).all();
    const byFilename = Object.fromEntries(rows.map((r) => [r.filename, r]));
    expect(byFilename["a.wav"].cachePath).toBeNull();
    expect(byFilename["ghost.wav"].cachePath).toBeNull();
    expect(byFilename["untouched.wav"].cachePath).toBe("/tmp/keep-me");

    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("is a no-op on empty input", async () => {
    await expect(releaseFiles([])).resolves.toBeUndefined();
  });
});

describe("cancelProcessingJob — audio_analysis routing", () => {
  it("cancels a pending audio_analysis job via the unified router", async () => {
    const [job] = db
      .insert(schema.processingJobs)
      .values({
        deploymentId,
        jobType: "audio_analysis",
        status: "pending",
        totalImages: 5,
      })
      .returning()
      .all();

    const result = await cancelProcessingJob(job.id);
    expect(result.success).toBe(true);

    const [after] = db
      .select()
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.id, job.id))
      .all();
    expect(after.status).toBe("cancelled");
    expect(after.completedAt).toBeTruthy();
  });

  it("refuses to cancel an already-completed audio_analysis job", async () => {
    const [job] = db
      .insert(schema.processingJobs)
      .values({
        deploymentId,
        jobType: "audio_analysis",
        status: "completed",
        totalImages: 5,
        processedImages: 5,
      })
      .returning()
      .all();

    const result = await cancelProcessingJob(job.id);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain("ya finalizó");
  });
});

describe("batchCreateAudioAnalysisJobs", () => {
  it("classifies soft-failures into skipped / noFiles buckets", async () => {
    // Deployment 1 — has files
    db.insert(schema.audioFiles)
      .values({ deploymentId, filename: "a.wav", driveFileId: "drive_a" })
      .run();

    // Deployment 2 — no files (will trip the noFiles classifier)
    const [dep2] = db
      .insert(schema.deployments)
      .values({
        projectId: "camera-trap",
        name: "AUDIO-002_V1",
        status: "unscanned",
        cameraTrapProjectId: ctProjectId,
        uploadAudioFolderId: "drive_no_files",
      })
      .returning()
      .all();

    // Deployment 3 — has files AND an active job (will trip the skipped classifier)
    const [dep3] = db
      .insert(schema.deployments)
      .values({
        projectId: "camera-trap",
        name: "AUDIO-003_V1",
        status: "scanned",
        cameraTrapProjectId: ctProjectId,
        uploadAudioFolderId: "drive_busy",
      })
      .returning()
      .all();
    db.insert(schema.audioFiles)
      .values({ deploymentId: dep3.id, filename: "c.wav", driveFileId: "drive_c" })
      .run();
    db.insert(schema.processingJobs)
      .values({
        deploymentId: dep3.id,
        jobType: "audio_analysis",
        status: "processing",
        totalImages: 1,
      })
      .run();

    const result = await batchCreateAudioAnalysisJobs([deploymentId, dep2.id, dep3.id]);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.enqueued).toBe(1); // only deployment 1
    expect(result.data.noFiles).toBe(1); // deployment 2
    expect(result.data.skipped).toBe(1); // deployment 3
    expect(result.data.errorMessages).toEqual([]);
  });
});
