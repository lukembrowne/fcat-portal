/**
 * Integration tests for bulk delete blank images.
 *
 * Uses a real in-memory SQLite database to test:
 * - countDeletableImages scope filtering and deduplication
 * - bulkDeleteBlankImages deletion, cascade, Drive trashing, and error handling
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, seedTestData, testDbRef, setupIntegrationDbMock, type TestDb } from "../helpers/test-db";
import {
  mockRequirePermission,
  setupAuthMocks,
  testUser,
} from "../helpers/mock-auth";

setupAuthMocks();
setupIntegrationDbMock();

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

const mockTrashFile = vi.fn();
vi.mock("@/lib/drive-client", () => ({
  uploadFramesToDrive: vi.fn(),
  trashFile: (...args: unknown[]) => mockTrashFile(...args),
}));

vi.mock("fs", () => ({
  promises: {
    unlink: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    readdir: vi.fn(() => []),
    mkdir: vi.fn(),
    rm: vi.fn(),
    stat: vi.fn(),
    access: vi.fn(),
  },
}));

vi.mock("@/lib/ml-runner", () => ({
  runMLPredictions: vi.fn(),
  checkPytorchWildlife: vi.fn(),
  cancelModelServerJob: vi.fn(),
}));

vi.mock("@/lib/drive-downloader", () => ({
  downloadDeploymentForProcessing: vi.fn(),
  downloadVideosForProcessing: vi.fn(),
  cleanupJobTempDir: vi.fn(),
}));

vi.mock("@/lib/frame-extractor", () => ({
  extractFrames: vi.fn(),
  cancelFrameExtraction: vi.fn(),
}));

vi.mock("@/lib/ml-defaults", () => ({
  ML_DEFAULTS: {
    detectorModel: "MDV6-yolov9-c",
    classifierModel: "AI4GAmazonRainforest",
    confidenceThreshold: 0.1,
  },
}));

const actions = await import("@/app/camera-trap/actions");

let db: ReturnType<typeof createTestDb>;
let seed: ReturnType<typeof seedTestData>;

/**
 * Seed 6 images covering all edge cases for bulk delete:
 * 1. confirmedBlank + no detections + driveFileId → deletable by both scopes
 * 2. not blank + no detections + driveFileId → deletable by noDetections only
 * 3. confirmedBlank + all-rejected detections + driveFileId → deletable by confirmedBlank
 * 4. confirmedBlank + non-rejected detection + driveFileId → NOT deletable
 * 5. confirmedBlank + setupTag → excluded
 * 6. confirmedBlank + no driveFileId → excluded
 */
function seedDeletableImages(db: TestDb, deploymentId: number, jobId: number) {
  const imgs = db
    .insert(schema.images)
    .values([
      // 1: blank, no detections, has driveFileId
      {
        deploymentId,
        jobId,
        filename: "BLANK_001.jpg",
        status: "processed" as const,
        confirmedBlank: true,
        driveFileId: "drive-blank-001",
      },
      // 2: not blank, no detections, has driveFileId
      {
        deploymentId,
        jobId,
        filename: "NODET_002.jpg",
        status: "processed" as const,
        confirmedBlank: false,
        driveFileId: "drive-nodet-002",
      },
      // 3: blank, has detections (all rejected), has driveFileId
      {
        deploymentId,
        jobId,
        filename: "BLANK_REJ_003.jpg",
        status: "processed" as const,
        confirmedBlank: true,
        driveFileId: "drive-blank-rej-003",
      },
      // 4: blank, has non-rejected detection, has driveFileId → NOT deletable
      {
        deploymentId,
        jobId,
        filename: "BLANK_KEEP_004.jpg",
        status: "processed" as const,
        confirmedBlank: true,
        driveFileId: "drive-blank-keep-004",
      },
      // 5: blank, setupTag → excluded
      {
        deploymentId,
        jobId,
        filename: "SETUP_005.jpg",
        status: "processed" as const,
        confirmedBlank: true,
        driveFileId: "drive-setup-005",
        setupTag: "install",
      },
      // 6: blank, no driveFileId → excluded
      {
        deploymentId,
        jobId,
        filename: "NODRIVE_006.jpg",
        status: "processed" as const,
        confirmedBlank: true,
      },
    ])
    .returning()
    .all();

  // Image 3: detection with all-rejected identifications
  const [det3] = db
    .insert(schema.detections)
    .values({
      imageId: imgs[2].id,
      jobId,
      bboxX: 0.1,
      bboxY: 0.1,
      bboxWidth: 0.5,
      bboxHeight: 0.5,
      detectionConfidence: 0.3,
      detectionClass: 0,
    })
    .returning()
    .all();

  db.insert(schema.identifications)
    .values({
      detectionId: det3.id,
      species: "Dasyprocta punctata",
      confidence: 0.3,
      verificationStatus: "rejected",
    })
    .run();

  // Image 4: detection with unverified identification → NOT deletable
  const [det4] = db
    .insert(schema.detections)
    .values({
      imageId: imgs[3].id,
      jobId,
      bboxX: 0.2,
      bboxY: 0.2,
      bboxWidth: 0.4,
      bboxHeight: 0.4,
      detectionConfidence: 0.9,
      detectionClass: 0,
    })
    .returning()
    .all();

  db.insert(schema.identifications)
    .values({
      detectionId: det4.id,
      species: "Panthera onca",
      confidence: 0.85,
      verificationStatus: "unverified",
    })
    .run();

  return { images: imgs, detections: [det3, det4] };
}

beforeEach(() => {
  vi.clearAllMocks();
  db = createTestDb();
  testDbRef.current = db;
  seed = seedTestData(db);
  mockRequirePermission.mockResolvedValue(testUser);
});

// === countDeletableImages ===

describe("countDeletableImages", () => {
  it("counts confirmedBlank images correctly", async () => {
    seedDeletableImages(db, seed.deployment.id, seed.job.id);

    const result = await actions.countDeletableImages(seed.job.id, {
      confirmedBlank: true,
      noDetections: false,
      unverifiedDetections: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    // Images 1 (blank+no dets) and 3 (blank+all rejected) are deletable
    expect(result.data.confirmedBlankCount).toBe(2);
    expect(result.data.totalCount).toBe(2);
  });

  it("counts noDetections images correctly", async () => {
    seedDeletableImages(db, seed.deployment.id, seed.job.id);

    const result = await actions.countDeletableImages(seed.job.id, {
      confirmedBlank: false,
      noDetections: true,
      unverifiedDetections: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    // Images 1 and 2 have no detections
    expect(result.data.noDetectionsCount).toBe(2);
    expect(result.data.totalCount).toBe(2);
  });

  it("deduplicates union of both scopes", async () => {
    seedDeletableImages(db, seed.deployment.id, seed.job.id);

    const result = await actions.countDeletableImages(seed.job.id, {
      confirmedBlank: true,
      noDetections: true,
      unverifiedDetections: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    // Image 1 is in both scopes but counted once in total
    // confirmedBlank: 1, 3. noDetections: 1, 2. Union: 1, 2, 3
    expect(result.data.confirmedBlankCount).toBe(2);
    expect(result.data.noDetectionsCount).toBe(2);
    expect(result.data.totalCount).toBe(3);
  });

  it("excludes images with setupTag", async () => {
    seedDeletableImages(db, seed.deployment.id, seed.job.id);

    const result = await actions.countDeletableImages(seed.job.id, {
      confirmedBlank: true,
      noDetections: true,
      unverifiedDetections: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    // Image 5 (setupTag) should NOT be in counts
    expect(result.data.totalCount).toBe(3); // not 4
  });

  it("excludes images without driveFileId", async () => {
    seedDeletableImages(db, seed.deployment.id, seed.job.id);

    const result = await actions.countDeletableImages(seed.job.id, {
      confirmedBlank: true,
      noDetections: true,
      unverifiedDetections: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    // Image 6 (no driveFileId) should NOT be in counts
    expect(result.data.totalCount).toBe(3); // not 4+
  });

  it("counts unverifiedDetections images correctly", async () => {
    seedDeletableImages(db, seed.deployment.id, seed.job.id);

    const result = await actions.countDeletableImages(seed.job.id, {
      confirmedBlank: false,
      noDetections: false,
      unverifiedDetections: true,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    // Image 4 has detections with all-unverified identifications
    // Image 3 has rejected identifications (not unverified) → excluded
    expect(result.data.unverifiedDetectionsCount).toBe(1);
    expect(result.data.totalCount).toBe(1);
  });

  it("excludes images with verified identifications from unverifiedDetections", async () => {
    const seeded = seedDeletableImages(db, seed.deployment.id, seed.job.id);

    // Image 4 (index 3) has unverified detection — mark it as verified
    const img4 = seeded.images[3];
    const dets = db
      .select()
      .from(schema.detections)
      .where(eq(schema.detections.imageId, img4.id))
      .all();
    db.update(schema.identifications)
      .set({ verificationStatus: "verified" })
      .where(eq(schema.identifications.detectionId, dets[0].id))
      .run();

    const result = await actions.countDeletableImages(seed.job.id, {
      confirmedBlank: false,
      noDetections: false,
      unverifiedDetections: true,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    // Image 4 now has a verified identification → excluded
    expect(result.data.unverifiedDetectionsCount).toBe(0);
  });

  it("returns zeros when no scope selected", async () => {
    seedDeletableImages(db, seed.deployment.id, seed.job.id);

    const result = await actions.countDeletableImages(seed.job.id, {
      confirmedBlank: false,
      noDetections: false,
      unverifiedDetections: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.confirmedBlankCount).toBe(0);
    expect(result.data.noDetectionsCount).toBe(0);
    expect(result.data.totalCount).toBe(0);
  });
});

// === bulkDeleteBlankImages ===

describe("bulkDeleteBlankImages", () => {
  it("deletes confirmedBlank images and removes from DB", async () => {
    seedDeletableImages(db, seed.deployment.id, seed.job.id);

    const result = await actions.bulkDeleteBlankImages(seed.job.id, {
      confirmedBlank: true,
      noDetections: false,
      unverifiedDetections: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.deleted).toBe(2); // images 1 and 3

    // Verify deleted from DB
    const remaining = db
      .select()
      .from(schema.images)
      .where(eq(schema.images.jobId, seed.job.id))
      .all();

    const remainingFilenames = remaining.map((i) => i.filename);
    expect(remainingFilenames).not.toContain("BLANK_001.jpg");
    expect(remainingFilenames).not.toContain("BLANK_REJ_003.jpg");
    // Non-deletable images should remain
    expect(remainingFilenames).toContain("NODET_002.jpg");
    expect(remainingFilenames).toContain("BLANK_KEEP_004.jpg");
  });

  it("deletes noDetections images", async () => {
    seedDeletableImages(db, seed.deployment.id, seed.job.id);

    const result = await actions.bulkDeleteBlankImages(seed.job.id, {
      confirmedBlank: false,
      noDetections: true,
      unverifiedDetections: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.deleted).toBe(2); // images 1 and 2
  });

  it("calls trashFile for each deleted image with correct Drive file IDs", async () => {
    seedDeletableImages(db, seed.deployment.id, seed.job.id);

    await actions.bulkDeleteBlankImages(seed.job.id, {
      confirmedBlank: true,
      noDetections: false,
      unverifiedDetections: false,
    });

    expect(mockTrashFile).toHaveBeenCalledTimes(2);
    const trashedIds = mockTrashFile.mock.calls.map((c: unknown[]) => c[0]);
    expect(trashedIds).toContain("drive-blank-001");
    expect(trashedIds).toContain("drive-blank-rej-003");
  });

  it("cascades deletion to detections and identifications", async () => {
    const seeded = seedDeletableImages(db, seed.deployment.id, seed.job.id);

    await actions.bulkDeleteBlankImages(seed.job.id, {
      confirmedBlank: true,
      noDetections: false,
      unverifiedDetections: false,
    });

    // Image 3's detection + identification should be deleted
    const det3Rows = db
      .select()
      .from(schema.detections)
      .where(eq(schema.detections.id, seeded.detections[0].id))
      .all();
    expect(det3Rows).toHaveLength(0);

    // Image 4's detection + identification should remain
    const det4Rows = db
      .select()
      .from(schema.detections)
      .where(eq(schema.detections.id, seeded.detections[1].id))
      .all();
    expect(det4Rows).toHaveLength(1);
  });

  it("preserves non-deletable images (setupTag, no driveFileId, non-rejected)", async () => {
    seedDeletableImages(db, seed.deployment.id, seed.job.id);

    await actions.bulkDeleteBlankImages(seed.job.id, {
      confirmedBlank: true,
      noDetections: true,
      unverifiedDetections: false,
    });

    const remaining = db
      .select()
      .from(schema.images)
      .where(eq(schema.images.jobId, seed.job.id))
      .all();

    const remainingFilenames = remaining.map((i) => i.filename);
    // Image 4 (non-rejected detection), 5 (setupTag), 6 (no driveFileId) should remain
    expect(remainingFilenames).toContain("BLANK_KEEP_004.jpg");
    expect(remainingFilenames).toContain("SETUP_005.jpg");
    expect(remainingFilenames).toContain("NODRIVE_006.jpg");
  });

  it("updates deployment totalImages after deletion", async () => {
    seedDeletableImages(db, seed.deployment.id, seed.job.id);

    await actions.bulkDeleteBlankImages(seed.job.id, {
      confirmedBlank: true,
      noDetections: true,
      unverifiedDetections: false,
    });

    const [dep] = db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, seed.deployment.id))
      .all();

    // Seed creates 3 images + seedDeletableImages adds 6 = 9 total
    // Deleted: images 1, 2, 3 (3 images) → 6 remaining
    expect(dep.totalImages).toBe(6);
  });

  it("creates activity log entry with correct details", async () => {
    seedDeletableImages(db, seed.deployment.id, seed.job.id);

    await actions.bulkDeleteBlankImages(seed.job.id, {
      confirmedBlank: true,
      noDetections: false,
      unverifiedDetections: false,
    });

    const logs = db
      .select()
      .from(schema.activityLog)
      .all();

    const deleteLog = logs.find(
      (l) => l.action === "bulk_delete_blanks"
    );
    expect(deleteLog).toBeDefined();
    expect(deleteLog!.userEmail).toBe(testUser.email);
    expect(deleteLog!.projectId).toBe("camera-trap");

    const details = JSON.parse(deleteLog!.details!);
    expect(details.jobId).toBe(seed.job.id);
    expect(details.deleted).toBe(2);
    expect(details.scope).toEqual({ confirmedBlank: true, noDetections: false, unverifiedDetections: false });
  });

  it("deletes unverifiedDetections images (all identifications unverified)", async () => {
    seedDeletableImages(db, seed.deployment.id, seed.job.id);

    const result = await actions.bulkDeleteBlankImages(seed.job.id, {
      confirmedBlank: false,
      noDetections: false,
      unverifiedDetections: true,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    // Only image 4 has detections with all-unverified identifications
    expect(result.data.deleted).toBe(1);

    const remaining = db
      .select()
      .from(schema.images)
      .where(eq(schema.images.jobId, seed.job.id))
      .all();
    const filenames = remaining.map((i) => i.filename);
    expect(filenames).not.toContain("BLANK_KEEP_004.jpg");
    // Image 3 has rejected identifications, not unverified → stays
    expect(filenames).toContain("BLANK_REJ_003.jpg");
  });

  it("handles Drive trashFile failures gracefully", async () => {
    seedDeletableImages(db, seed.deployment.id, seed.job.id);

    // First call succeeds, second fails
    mockTrashFile
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Drive API error"));

    const result = await actions.bulkDeleteBlankImages(seed.job.id, {
      confirmedBlank: true,
      noDetections: false,
      unverifiedDetections: false,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.deleted).toBe(1);
    expect(result.data.failed).toBe(1);
  });
});

// === checkSetupRetrievalTags ===

describe("checkSetupRetrievalTags", () => {
  it("returns false for both when no tags set", async () => {
    seedDeletableImages(db, seed.deployment.id, seed.job.id);

    // Remove the setupTag from image 5 so there are none
    db.update(schema.images)
      .set({ setupTag: null })
      .where(eq(schema.images.jobId, seed.job.id))
      .run();

    const result = await actions.checkSetupRetrievalTags(seed.job.id);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.hasDeployment).toBe(false);
    expect(result.data.hasRetrieval).toBe(false);
  });

  it("detects deployment tag", async () => {
    seedDeletableImages(db, seed.deployment.id, seed.job.id);

    // Set one image as deployment
    const imgs = db.select().from(schema.images).where(eq(schema.images.jobId, seed.job.id)).all();
    db.update(schema.images)
      .set({ setupTag: "deployment" })
      .where(eq(schema.images.id, imgs[0].id))
      .run();

    const result = await actions.checkSetupRetrievalTags(seed.job.id);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.hasDeployment).toBe(true);
    expect(result.data.hasRetrieval).toBe(false);
  });

  it("detects both tags when set", async () => {
    seedDeletableImages(db, seed.deployment.id, seed.job.id);

    const imgs = db.select().from(schema.images).where(eq(schema.images.jobId, seed.job.id)).all();
    db.update(schema.images)
      .set({ setupTag: "deployment" })
      .where(eq(schema.images.id, imgs[0].id))
      .run();
    db.update(schema.images)
      .set({ setupTag: "retrieval" })
      .where(eq(schema.images.id, imgs[1].id))
      .run();

    const result = await actions.checkSetupRetrievalTags(seed.job.id);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.hasDeployment).toBe(true);
    expect(result.data.hasRetrieval).toBe(true);
  });
});
