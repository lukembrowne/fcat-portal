/**
 * Integration tests for camera-trap job lifecycle.
 *
 * Uses a real in-memory SQLite database to test:
 * - createProcessingJob initial state and image linking
 * - cancelJob status transitions
 * - deleteJob cascade behavior (detections, images reset)
 * - deleteJobs bulk deletion
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq, inArray } from "drizzle-orm";
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

vi.mock("@/lib/drive-client", () => ({
  uploadFramesToDrive: vi.fn(),
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

vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    readdir: vi.fn(() => []),
    mkdir: vi.fn(),
    rm: vi.fn(),
    stat: vi.fn(),
    access: vi.fn(),
  },
}));

const actions = await import("@/app/camera-trap/actions");

let seed: ReturnType<typeof seedTestData>;
let db: ReturnType<typeof createTestDb>;

beforeEach(() => {
  vi.clearAllMocks();
  db = createTestDb();
  testDbRef.current = db;
  seed = seedTestData(db);
  mockRequirePermission.mockResolvedValue(testUser);
});

// === Create Processing Job ===

describe("createProcessingJob", () => {
  it("creates job with correct initial state", async () => {
    const result = await actions.createProcessingJob(seed.deployment.id);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const [job] = db
      .select()
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.id, result.data.jobId))
      .all();

    expect(job.status).toBe("pending");
    expect(job.deploymentId).toBe(seed.deployment.id);
    expect(job.totalImages).toBe(3); // seed creates 3 images
    expect(job.processedImages).toBe(0);
    expect(job.failedImages).toBe(0);
    expect(job.createdBy).toBe(testUser.email);
    expect(job.detectorModel).toBe("MDV6-yolov9-c");
    expect(job.classifierModel).toBe("AI4GAmazonRainforest");
    // Download progress columns default to 0
    expect(job.downloadedImages).toBe(0);
    expect(job.downloadTotal).toBe(0);
    expect(job.cachedImages).toBe(0);
  });

  it("links existing images to the new job", async () => {
    const result = await actions.createProcessingJob(seed.deployment.id);
    expect(result.success).toBe(true);
    if (!result.success) return;

    // All deployment images should now reference the new job
    const imgs = db
      .select()
      .from(schema.images)
      .where(eq(schema.images.deploymentId, seed.deployment.id))
      .all();

    for (const img of imgs) {
      expect(img.jobId).toBe(result.data.jobId);
      expect(img.status).toBe("pending"); // reset to pending
    }
  });

  it("sets deployment status to processing", async () => {
    await actions.createProcessingJob(seed.deployment.id);

    const [dep] = db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, seed.deployment.id))
      .all();

    expect(dep.status).toBe("processing");
  });

  it("accepts custom model config", async () => {
    const result = await actions.createProcessingJob(seed.deployment.id, {
      detectorModel: "custom-v2",
      confidenceThreshold: 0.5,
      frameExtractionRate: 2.0,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const [job] = db
      .select()
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.id, result.data.jobId))
      .all();

    expect(job.detectorModel).toBe("custom-v2");
    expect(job.confidenceThreshold).toBe(0.5);
    expect(job.frameExtractionRate).toBe(2.0);
  });

  it("returns error for non-existent deployment", async () => {
    const result = await actions.createProcessingJob(99999);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("no encontrada");
    }
  });

  // === Stale data cleanup on re-run ===
  // Regression: previously, re-running ML on a deployment left old detections
  // (and any verified identifications) attached to the reused image rows,
  // contradicting the "Las verificaciones existentes se perderán" warning
  // and inflating the deployment-wide verified count after a fresh run.

  it("deletes ML detections from previous jobs when a new job is created", async () => {
    // Seed already created `seed.detections` (3 ML detections, jobId=seed.job.id)
    // Each has an identification cascading off it.
    const beforeDets = db
      .select()
      .from(schema.detections)
      .where(eq(schema.detections.imageId, seed.images[0].id))
      .all();
    expect(beforeDets.length).toBeGreaterThan(0);

    const result = await actions.createProcessingJob(seed.deployment.id);
    expect(result.success).toBe(true);

    // The previous job's detections should be gone — fresh slate for the new job
    const afterDets = db
      .select()
      .from(schema.detections)
      .where(eq(schema.detections.jobId, seed.job.id))
      .all();
    expect(afterDets).toHaveLength(0);
  });

  it("cascade-deletes identifications when previous detections are cleaned up", async () => {
    // Mark one of the seed identifications as verified to simulate the bug
    db.update(schema.identifications)
      .set({ verificationStatus: "verified" })
      .where(eq(schema.identifications.id, seed.identifications[0].id))
      .run();

    const result = await actions.createProcessingJob(seed.deployment.id);
    expect(result.success).toBe(true);

    // All identifications attached to the seed deployment's images should be gone
    const remainingIdents = db
      .select()
      .from(schema.identifications)
      .where(eq(schema.identifications.id, seed.identifications[0].id))
      .all();
    expect(remainingIdents).toHaveLength(0);
  });

  it("preserves manual detections (jobId IS NULL) across re-runs", async () => {
    // Insert a manual detection (no jobId — created by the user, not ML)
    const [manualDet] = db
      .insert(schema.detections)
      .values({
        imageId: seed.images[0].id,
        jobId: null,
        bboxX: 0.2,
        bboxY: 0.2,
        bboxWidth: 0.4,
        bboxHeight: 0.4,
        detectionConfidence: 1.0,
        detectionClass: 0,
        modelVersion: "manual",
      })
      .returning()
      .all();

    const result = await actions.createProcessingJob(seed.deployment.id);
    expect(result.success).toBe(true);

    // Manual detection must still exist
    const [stillThere] = db
      .select()
      .from(schema.detections)
      .where(eq(schema.detections.id, manualDet.id))
      .all();
    expect(stillThere).toBeDefined();
    expect(stillThere.jobId).toBeNull();
  });

  it("resets confirmed_blank on all images when a new job is created", async () => {
    // User had marked an image as blank during a previous review pass
    db.update(schema.images)
      .set({ confirmedBlank: true })
      .where(eq(schema.images.id, seed.images[0].id))
      .run();

    const result = await actions.createProcessingJob(seed.deployment.id);
    expect(result.success).toBe(true);

    const imgs = db
      .select()
      .from(schema.images)
      .where(eq(schema.images.deploymentId, seed.deployment.id))
      .all();
    for (const img of imgs) {
      expect(img.confirmedBlank).toBe(false);
    }
  });

  it("resets verification state on identifications attached to surviving manual detections", async () => {
    // Add a manual detection + identification, then mark the identification verified
    const [manualDet] = db
      .insert(schema.detections)
      .values({
        imageId: seed.images[0].id,
        jobId: null,
        bboxX: 0.1,
        bboxY: 0.1,
        bboxWidth: 0.3,
        bboxHeight: 0.3,
        detectionConfidence: 1.0,
        detectionClass: 0,
        modelVersion: "manual",
      })
      .returning()
      .all();

    const [manualIdent] = db
      .insert(schema.identifications)
      .values({
        detectionId: manualDet.id,
        species: "Tapirus bairdii",
        confidence: 1.0,
        verificationStatus: "verified",
        correctedSpecies: "Tapirus indicus",
        verifiedBy: "luke@example.com",
        verifiedAt: new Date(),
      })
      .returning()
      .all();

    const result = await actions.createProcessingJob(seed.deployment.id);
    expect(result.success).toBe(true);

    const [after] = db
      .select()
      .from(schema.identifications)
      .where(eq(schema.identifications.id, manualIdent.id))
      .all();
    expect(after).toBeDefined();
    expect(after.verificationStatus).toBe("unverified");
    expect(after.correctedSpecies).toBeNull();
    expect(after.verifiedBy).toBeNull();
    expect(after.verifiedAt).toBeNull();
  });

  it("preserves setup_tag and starred flags across re-runs", async () => {
    db.update(schema.images)
      .set({
        setupTag: "deployment",
        starred: true,
        starredBy: "luke@example.com",
        starredAt: new Date(),
      })
      .where(eq(schema.images.id, seed.images[0].id))
      .run();

    await actions.createProcessingJob(seed.deployment.id);

    const [img] = db
      .select()
      .from(schema.images)
      .where(eq(schema.images.id, seed.images[0].id))
      .all();
    expect(img.setupTag).toBe("deployment");
    expect(img.starred).toBe(true);
    expect(img.starredBy).toBe("luke@example.com");
  });

  it("is a no-op cleanup on first process (no existing detections)", async () => {
    // Create a fresh deployment with images but no prior detections
    const [freshDep] = db
      .insert(schema.deployments)
      .values({
        projectId: "camera-trap",
        name: "FRESH-DEPLOY-001",
        status: "scanned",
        cameraTrapProjectId: seed.ctProject.id,
      })
      .returning()
      .all();

    db.insert(schema.images)
      .values([
        { deploymentId: freshDep.id, jobId: null, filename: "FRESH_001.jpg", status: "pending" },
        { deploymentId: freshDep.id, jobId: null, filename: "FRESH_002.jpg", status: "pending" },
      ])
      .run();

    const result = await actions.createProcessingJob(freshDep.id);
    expect(result.success).toBe(true);

    // Job created successfully and images linked
    if (!result.success) return;
    const [job] = db
      .select()
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.id, result.data.jobId))
      .all();
    expect(job.totalImages).toBe(2);
  });
});

// === Incremental ML processing ===
//
// Incremental jobs process only newly-added pending images on a deployment
// while preserving every existing detection, identification, verification
// state, and confirmedBlank flag. The seed leaves the deployment in
// "processed" status with 3 ML detections + 3 unverified identifications
// linked to seed.job; each test below adds one new pending image to that
// deployment and asserts the surrounding state survives an incremental run.

describe("createProcessingJob (incremental)", () => {
  /**
   * Adds a fresh pending image to seed.deployment so the incremental input
   * set is non-empty. Returns the new image row.
   */
  function addPendingImage(filename = "NEW_001.jpg") {
    const [img] = db
      .insert(schema.images)
      .values({
        deploymentId: seed.deployment.id,
        jobId: null,
        filename,
        status: "pending",
      })
      .returning()
      .all();
    return img;
  }

  it("filters image input set to status='pending' only", async () => {
    const newImg = addPendingImage();

    const result = await actions.createProcessingJob(
      seed.deployment.id,
      undefined,
      { incremental: true },
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const [job] = db
      .select()
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.id, result.data.jobId))
      .all();
    expect(job.totalImages).toBe(1); // only the new pending image, not the 3 processed ones

    // Only the new image gets the new jobId; the 3 seeded processed images
    // keep their original jobId.
    const [newImgAfter] = db
      .select()
      .from(schema.images)
      .where(eq(schema.images.id, newImg.id))
      .all();
    expect(newImgAfter.jobId).toBe(result.data.jobId);

    for (const seedImg of seed.images) {
      const [after] = db
        .select()
        .from(schema.images)
        .where(eq(schema.images.id, seedImg.id))
        .all();
      expect(after.jobId).toBe(seed.job.id); // unchanged
      expect(after.status).toBe("processed"); // unchanged
    }
  });

  it("inserts the job with jobType='ml_incremental'", async () => {
    addPendingImage();

    const result = await actions.createProcessingJob(
      seed.deployment.id,
      undefined,
      { incremental: true },
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const [job] = db
      .select()
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.id, result.data.jobId))
      .all();
    expect(job.jobType).toBe("ml_incremental");
  });

  it("does NOT delete existing ML detections", async () => {
    addPendingImage();

    const detsBefore = db
      .select()
      .from(schema.detections)
      .where(inArray(schema.detections.imageId, seed.images.map((i) => i.id)))
      .all();
    expect(detsBefore.length).toBeGreaterThan(0);

    const result = await actions.createProcessingJob(
      seed.deployment.id,
      undefined,
      { incremental: true },
    );
    expect(result.success).toBe(true);

    const detsAfter = db
      .select()
      .from(schema.detections)
      .where(inArray(schema.detections.imageId, seed.images.map((i) => i.id)))
      .all();
    expect(detsAfter).toHaveLength(detsBefore.length);
    // Each surviving detection still references the original seed job.
    for (const det of detsAfter) {
      expect(det.jobId).toBe(seed.job.id);
    }
  });

  it("does NOT reset confirmedBlank on already-processed images", async () => {
    db.update(schema.images)
      .set({ confirmedBlank: true })
      .where(eq(schema.images.id, seed.images[0].id))
      .run();
    addPendingImage();

    await actions.createProcessingJob(seed.deployment.id, undefined, {
      incremental: true,
    });

    const [img] = db
      .select()
      .from(schema.images)
      .where(eq(schema.images.id, seed.images[0].id))
      .all();
    expect(img.confirmedBlank).toBe(true); // preserved
  });

  it("does NOT reset verification state on existing identifications", async () => {
    db.update(schema.identifications)
      .set({
        verificationStatus: "verified",
        correctedSpecies: "Tapirus indicus",
        verifiedBy: "luke@example.com",
        verifiedAt: new Date(),
      })
      .where(eq(schema.identifications.id, seed.identifications[0].id))
      .run();
    addPendingImage();

    await actions.createProcessingJob(seed.deployment.id, undefined, {
      incremental: true,
    });

    const [ident] = db
      .select()
      .from(schema.identifications)
      .where(eq(schema.identifications.id, seed.identifications[0].id))
      .all();
    expect(ident.verificationStatus).toBe("verified");
    expect(ident.correctedSpecies).toBe("Tapirus indicus");
    expect(ident.verifiedBy).toBe("luke@example.com");
    expect(ident.verifiedAt).toBeTruthy();
  });

  it("does NOT flip deployment.status to 'processing'", async () => {
    addPendingImage();

    await actions.createProcessingJob(seed.deployment.id, undefined, {
      incremental: true,
    });

    const [dep] = db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, seed.deployment.id))
      .all();
    // Stays in the prior 'processed' state — the active-jobs query is the
    // lock, not deployment.status.
    expect(dep.status).toBe("processed");
  });

  it("returns error when no pending images and no pending videos", async () => {
    // Seed has no pending images and no videos at all — incremental should reject.
    const result = await actions.createProcessingJob(
      seed.deployment.id,
      undefined,
      { incremental: true },
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("nuevas");
    }
  });

  it("treats unprocessed videos as work to do even with no pending images", async () => {
    // No new images, but a fresh pending video. Frame extraction (mocked away)
    // would normally pick this up; for the createProcessingJob unit, the job
    // should be created successfully rather than rejected.
    db.insert(schema.videos)
      .values({
        deploymentId: seed.deployment.id,
        filename: "NEW_VIDEO.mp4",
        status: "pending",
      })
      .run();

    const result = await actions.createProcessingJob(
      seed.deployment.id,
      undefined,
      { incremental: true },
    );
    expect(result.success).toBe(true);
    if (!result.success) return;

    const [job] = db
      .select()
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.id, result.data.jobId))
      .all();
    expect(job.jobType).toBe("ml_incremental");
    expect(job.totalImages).toBe(0);
    expect(job.totalVideos).toBe(1);
  });

  it("preserves confirmedBlank, starred, and setupTag across incremental runs", async () => {
    db.update(schema.images)
      .set({
        confirmedBlank: true,
        starred: true,
        starredBy: "luke@example.com",
        setupTag: "deployment",
      })
      .where(eq(schema.images.id, seed.images[0].id))
      .run();
    addPendingImage();

    await actions.createProcessingJob(seed.deployment.id, undefined, {
      incremental: true,
    });

    const [img] = db
      .select()
      .from(schema.images)
      .where(eq(schema.images.id, seed.images[0].id))
      .all();
    expect(img.confirmedBlank).toBe(true);
    expect(img.starred).toBe(true);
    expect(img.starredBy).toBe("luke@example.com");
    expect(img.setupTag).toBe("deployment");
  });

  it("rejects incremental when an active job already exists on the deployment", async () => {
    addPendingImage();

    // First incremental call succeeds, leaves a 'pending' job in the queue.
    const first = await actions.createProcessingJob(
      seed.deployment.id,
      undefined,
      { incremental: true },
    );
    expect(first.success).toBe(true);

    // Second incremental call must hit the active-jobs guard.
    addPendingImage("NEW_002.jpg");
    const second = await actions.createProcessingJob(
      seed.deployment.id,
      undefined,
      { incremental: true },
    );
    expect(second.success).toBe(false);
    if (!second.success) {
      expect(second.error).toMatch(/activo/i);
    }
  });
});

// === getDeploymentResultsData ===
//
// Sibling of getJobResultsData that returns the entire deployment's image
// set + detections + identifications, regardless of which job processed each
// image. Used by the deployment detail page so the embedded gallery doesn't
// shrink to "just the latest job" after an incremental ML run. The standalone
// /camera-trap/results/[id] page still uses the per-job query.

describe("getDeploymentResultsData", () => {
  /**
   * Adds a second completed job + new image + new ML detection on
   * seed.deployment, simulating the post-incremental state. Returns the
   * second-job context for assertions.
   */
  function addSecondCompletedJob() {
    const [secondJob] = db
      .insert(schema.processingJobs)
      .values({
        deploymentId: seed.deployment.id,
        status: "completed",
        jobType: "ml_incremental",
        totalImages: 1,
        processedImages: 1,
        completedAt: new Date(),
      })
      .returning()
      .all();

    const [newImg] = db
      .insert(schema.images)
      .values({
        deploymentId: seed.deployment.id,
        jobId: secondJob.id,
        filename: "INC_NEW.jpg",
        status: "processed",
      })
      .returning()
      .all();

    const [newDet] = db
      .insert(schema.detections)
      .values({
        imageId: newImg.id,
        jobId: secondJob.id,
        bboxX: 0.1,
        bboxY: 0.1,
        bboxWidth: 0.4,
        bboxHeight: 0.4,
        detectionConfidence: 0.92,
        detectionClass: 0,
        modelVersion: "test-v1",
      })
      .returning()
      .all();

    return { secondJob, newImg, newDet };
  }

  it("returns all images in the deployment regardless of which job processed them", async () => {
    const { newImg } = addSecondCompletedJob();

    const result = await actions.getDeploymentResultsData(seed.deployment.id);
    expect(result).not.toBeNull();
    if (!result) return;

    // 3 seed images + 1 new image = 4 total. The bug had us returning only 1
    // (the second job's image set).
    expect(result.gridImages).toHaveLength(4);
    const ids = result.gridImages.map((g) => g.id).sort();
    expect(ids).toEqual([...seed.images.map((i) => i.id), newImg.id].sort());
  });

  it("returns one gridImage entry per physical image even when an image has detections from multiple sources", async () => {
    // seed.images[0] already has an ML detection from seed.job. Add a manual
    // detection (jobId = null) on top of it.
    db.insert(schema.detections)
      .values({
        imageId: seed.images[0].id,
        jobId: null,
        bboxX: 0.5,
        bboxY: 0.5,
        bboxWidth: 0.3,
        bboxHeight: 0.3,
        detectionConfidence: 1.0,
        detectionClass: 0,
        modelVersion: "manual",
      })
      .run();

    const result = await actions.getDeploymentResultsData(seed.deployment.id);
    expect(result).not.toBeNull();
    if (!result) return;

    const matches = result.gridImages.filter((g) => g.id === seed.images[0].id);
    // Image must appear exactly once — the detectionsByImage grouping
    // collapses both detections into the same gridImage entry.
    expect(matches).toHaveLength(1);
    expect(matches[0].detections).toHaveLength(2);
  });

  it("includes manual detections (jobId IS NULL) in the deployment-wide counts", async () => {
    db.insert(schema.detections)
      .values({
        imageId: seed.images[0].id,
        jobId: null,
        bboxX: 0.2,
        bboxY: 0.2,
        bboxWidth: 0.4,
        bboxHeight: 0.4,
        detectionConfidence: 1.0,
        detectionClass: 0,
        modelVersion: "manual",
      })
      .run();

    const result = await actions.getDeploymentResultsData(seed.deployment.id);
    expect(result).not.toBeNull();
    if (!result) return;

    // Seed has 3 ML detections; we just added 1 manual = 4.
    expect(result.detectionCount).toBe(4);
  });

  it("counts detections from ALL jobs, not just the latest", async () => {
    addSecondCompletedJob();

    const result = await actions.getDeploymentResultsData(seed.deployment.id);
    expect(result).not.toBeNull();
    if (!result) return;

    // 3 from seed.job + 1 from secondJob = 4. The bug returned 1.
    expect(result.detectionCount).toBe(4);
  });

  it("uses the latest completed job (by completedAt) for the `job` header field", async () => {
    const { secondJob } = addSecondCompletedJob();

    const result = await actions.getDeploymentResultsData(seed.deployment.id);
    expect(result).not.toBeNull();
    if (!result) return;

    expect(result.job).not.toBeNull();
    expect(result.job!.id).toBe(secondJob.id);
  });

  it("returns null for non-existent deployment", async () => {
    const result = await actions.getDeploymentResultsData(99999);
    expect(result).toBeNull();
  });

  it("returns empty gridImages for a deployment with no images", async () => {
    const [emptyDep] = db
      .insert(schema.deployments)
      .values({
        projectId: "camera-trap",
        name: "EMPTY-DEPLOY",
        status: "scanned",
        cameraTrapProjectId: seed.ctProject.id,
      })
      .returning()
      .all();

    const result = await actions.getDeploymentResultsData(emptyDep.id);
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.gridImages).toHaveLength(0);
    expect(result.detectionCount).toBe(0);
    expect(result.job).toBeNull();
  });
});

// === getDeployment stats — deployment-scoped counts ===
//
// The detail page banner counts must reflect the entire deployment, not just
// the latest completed job's image set. These tests defend the same
// correctness guarantee added to getDeploymentsWithStats in Phase 1.

describe("getDeployment stats — deployment-scoped counts", () => {
  it("counts detections across all jobs on the deployment", async () => {
    // Simulate post-incremental: a second completed job adds 1 image + 1 detection.
    const [secondJob] = db
      .insert(schema.processingJobs)
      .values({
        deploymentId: seed.deployment.id,
        status: "completed",
        jobType: "ml_incremental",
        totalImages: 1,
        processedImages: 1,
        completedAt: new Date(),
      })
      .returning()
      .all();

    const [newImg] = db
      .insert(schema.images)
      .values({
        deploymentId: seed.deployment.id,
        jobId: secondJob.id,
        filename: "INC_STATS.jpg",
        status: "processed",
      })
      .returning()
      .all();

    db.insert(schema.detections)
      .values({
        imageId: newImg.id,
        jobId: secondJob.id,
        bboxX: 0.1,
        bboxY: 0.1,
        bboxWidth: 0.4,
        bboxHeight: 0.4,
        detectionConfidence: 0.92,
        detectionClass: 0,
        modelVersion: "test-v1",
      })
      .run();

    const result = await actions.getDeployment(seed.deployment.id);
    expect(result).not.toBeNull();
    if (!result) return;

    // 3 (from seed.job) + 1 (from secondJob) = 4. The bug returned 1.
    expect(result.stats.totalDetections).toBe(4);
  });

  it("counts species across all completed jobs", async () => {
    const [secondJob] = db
      .insert(schema.processingJobs)
      .values({
        deploymentId: seed.deployment.id,
        status: "completed",
        jobType: "ml_incremental",
        totalImages: 1,
        processedImages: 1,
        completedAt: new Date(),
      })
      .returning()
      .all();

    const [newImg] = db
      .insert(schema.images)
      .values({
        deploymentId: seed.deployment.id,
        jobId: secondJob.id,
        filename: "INC_SPECIES.jpg",
        status: "processed",
      })
      .returning()
      .all();

    const [newDet] = db
      .insert(schema.detections)
      .values({
        imageId: newImg.id,
        jobId: secondJob.id,
        bboxX: 0.1,
        bboxY: 0.1,
        bboxWidth: 0.4,
        bboxHeight: 0.4,
        detectionConfidence: 0.92,
        detectionClass: 0,
        modelVersion: "test-v1",
      })
      .returning()
      .all();

    db.insert(schema.identifications)
      .values({
        detectionId: newDet.id,
        species: "Panthera onca",
        confidence: 0.91,
        modelVersion: "test-v1",
        verificationStatus: "unverified",
      })
      .run();

    const result = await actions.getDeployment(seed.deployment.id);
    expect(result).not.toBeNull();
    if (!result) return;

    // Seed had Dasyprocta punctata; new job adds Panthera onca → 2 distinct.
    expect(result.stats.distinctSpeciesCount).toBe(2);
  });

  it("includes manual detections in totalDetections", async () => {
    db.insert(schema.detections)
      .values({
        imageId: seed.images[0].id,
        jobId: null,
        bboxX: 0.2,
        bboxY: 0.2,
        bboxWidth: 0.4,
        bboxHeight: 0.4,
        detectionConfidence: 1.0,
        detectionClass: 0,
        modelVersion: "manual",
      })
      .run();

    const result = await actions.getDeployment(seed.deployment.id);
    expect(result).not.toBeNull();
    if (!result) return;

    // Seed has 3 ML detections; manual one brings total to 4.
    expect(result.stats.totalDetections).toBe(4);
  });

  it("counts deployment-wide totals even when no job has ever completed", async () => {
    // Fresh deployment with no jobs but with a manual detection on a hand-loaded image.
    const [freshDep] = db
      .insert(schema.deployments)
      .values({
        projectId: "camera-trap",
        name: "FRESH-MANUAL",
        status: "scanned",
        cameraTrapProjectId: seed.ctProject.id,
      })
      .returning()
      .all();

    const [freshImg] = db
      .insert(schema.images)
      .values({
        deploymentId: freshDep.id,
        jobId: null,
        filename: "MANUAL.jpg",
        status: "pending",
      })
      .returning()
      .all();

    db.insert(schema.detections)
      .values({
        imageId: freshImg.id,
        jobId: null,
        bboxX: 0.1,
        bboxY: 0.1,
        bboxWidth: 0.4,
        bboxHeight: 0.4,
        detectionConfidence: 1.0,
        detectionClass: 0,
        modelVersion: "manual",
      })
      .run();

    const result = await actions.getDeployment(freshDep.id);
    expect(result).not.toBeNull();
    if (!result) return;

    // Old behaviour was 0 (no completed job → no count). New behaviour
    // counts the manual detection because the query is deployment-scoped.
    expect(result.stats.totalDetections).toBe(1);
    expect(result.stats.latestCompletedJobId).toBeNull();
  });
});

// === queueIncrementalProcessing ===

describe("queueIncrementalProcessing", () => {
  it("rejects deployments with no pending images", async () => {
    // Seed has all images in 'processed' state — nothing for incremental to do.
    const result = await actions.queueIncrementalProcessing(seed.deployment.id);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("nuevas");
    }
  });

  it("creates a job and returns its id when pending images exist", async () => {
    db.insert(schema.images)
      .values({
        deploymentId: seed.deployment.id,
        jobId: null,
        filename: "QUEUE_NEW.jpg",
        status: "pending",
      })
      .run();

    const result = await actions.queueIncrementalProcessing(seed.deployment.id);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(typeof result.data.jobId).toBe("number");

    const [job] = db
      .select()
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.id, result.data.jobId))
      .all();
    expect(job.jobType).toBe("ml_incremental");
    expect(job.deploymentId).toBe(seed.deployment.id);
  });

  it("returns error for non-existent deployment", async () => {
    const result = await actions.queueIncrementalProcessing(99999);
    expect(result.success).toBe(false);
  });
});

// === Cancel Job ===

describe("cancelJob", () => {
  it("marks job as cancelled", async () => {
    // Create a pending job
    const createResult = await actions.createProcessingJob(seed.deployment.id);
    expect(createResult.success).toBe(true);
    if (!createResult.success) return;

    const result = await actions.cancelJob(createResult.data.jobId);
    expect(result.success).toBe(true);

    const [job] = db
      .select()
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.id, createResult.data.jobId))
      .all();

    expect(job.status).toBe("cancelled");
    expect(job.completedAt).toBeTruthy();
  });

  it("restores deployment to processed when a previous completed job exists", async () => {
    // seed has a completed job, so cancelling a new job should restore to "processed"
    const createResult = await actions.createProcessingJob(seed.deployment.id);
    expect(createResult.success).toBe(true);
    if (!createResult.success) return;

    await actions.cancelJob(createResult.data.jobId);

    const [dep] = db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, seed.deployment.id))
      .all();

    expect(dep.status).toBe("processed");

    // Images should be reassigned back to the previous completed job
    const imgs = db
      .select()
      .from(schema.images)
      .where(eq(schema.images.deploymentId, seed.deployment.id))
      .all();

    for (const img of imgs) {
      expect(img.jobId).toBe(seed.job.id);
      expect(img.status).toBe("processed");
    }
  });

  it("returns error for non-existent job", async () => {
    const result = await actions.cancelJob(99999);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("no encontrado");
    }
  });
});

// === Delete Job ===

describe("deleteJob", () => {
  it("deletes job and cascades to ML detections", async () => {
    // The seeded job has detections/identifications from seedTestData
    const jobId = seed.job.id;

    const result = await actions.deleteJob(jobId);
    expect(result.success).toBe(true);

    // Job should be gone
    const jobs = db
      .select()
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.id, jobId))
      .all();
    expect(jobs).toHaveLength(0);

    // ML detections (those with jobId) should be gone
    const dets = db
      .select()
      .from(schema.detections)
      .where(eq(schema.detections.jobId, jobId))
      .all();
    expect(dets).toHaveLength(0);
  });

  it("resets images to pending with null jobId", async () => {
    const jobId = seed.job.id;

    await actions.deleteJob(jobId);

    const imgs = db
      .select()
      .from(schema.images)
      .where(eq(schema.images.deploymentId, seed.deployment.id))
      .all();

    for (const img of imgs) {
      expect(img.jobId).toBeNull();
      expect(img.status).toBe("pending");
    }
  });

  it("reverts deployment to scanned when no completed jobs remain", async () => {
    await actions.deleteJob(seed.job.id);

    const [dep] = db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, seed.deployment.id))
      .all();

    expect(dep.status).toBe("scanned");
  });

  it("logs activity on deletion", async () => {
    await actions.deleteJob(seed.job.id);

    const events = db.select().from(schema.systemEvents).all();
    const deleteEvent = events.find((e) => e.eventType === "delete_job");
    expect(deleteEvent).toBeDefined();
    expect(deleteEvent!.actorEmail).toBe(testUser.email);
    expect(deleteEvent!.targetId).toBe(String(seed.job.id));
  });

  it("returns error for non-existent job", async () => {
    const result = await actions.deleteJob(99999);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("no encontrado");
    }
  });

  it("preserves manual detections (jobId=null)", async () => {
    // Create a manual detection (no jobId)
    const manualResult = await actions.createManualDetection(seed.images[0].id, {
      x: 0.1, y: 0.1, width: 0.5, height: 0.5,
    });
    expect(manualResult.success).toBe(true);

    // Delete the seeded job
    await actions.deleteJob(seed.job.id);

    // Manual detection should still exist
    const dets = db.select().from(schema.detections).all();
    const manual = dets.find((d) => d.modelVersion === "manual");
    expect(manual).toBeDefined();
  });
});

// === compressFirst option ===

describe("createProcessingJob with compressFirst", () => {
  it("creates job with compressFirst=true when option passed", async () => {
    const result = await actions.createProcessingJob(seed.deployment.id, undefined, {
      compressFirst: true,
    });
    expect(result.success).toBe(true);
    if (!result.success) return;

    const [job] = db
      .select()
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.id, result.data.jobId))
      .all();

    expect(job.compressFirst).toBe(true);
  });

  it("creates job with compressFirst=false by default", async () => {
    const result = await actions.createProcessingJob(seed.deployment.id);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const [job] = db
      .select()
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.id, result.data.jobId))
      .all();

    expect(job.compressFirst).toBe(false);
  });
});

describe("queueProcessing with compressFirst", () => {
  it("passes compressFirst to created jobs", async () => {
    // Use an unscanned deployment with a drive folder so it goes through auto-scan
    const [dep] = db
      .insert(schema.deployments)
      .values({
        projectId: "camera-trap",
        name: "QUEUE-TEST-001",
        status: "scanned",
        cameraTrapProjectId: seed.ctProject.id,
      })
      .returning()
      .all();

    // Add an image so the job gets created
    db.insert(schema.images)
      .values({
        deploymentId: dep.id,
        filename: "IMG_001.jpg",
        status: "pending",
      })
      .run();

    const result = await actions.queueProcessing([dep.id], { compressFirst: true });
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.jobIds.length).toBe(1);

    const [job] = db
      .select()
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.id, result.data.jobIds[0]))
      .all();

    expect(job.compressFirst).toBe(true);
  });

  it("defaults to compressFirst=false when options omitted", async () => {
    const [dep] = db
      .insert(schema.deployments)
      .values({
        projectId: "camera-trap",
        name: "QUEUE-TEST-002",
        status: "scanned",
        cameraTrapProjectId: seed.ctProject.id,
      })
      .returning()
      .all();

    db.insert(schema.images)
      .values({
        deploymentId: dep.id,
        filename: "IMG_001.jpg",
        status: "pending",
      })
      .run();

    const result = await actions.queueProcessing([dep.id]);
    expect(result.success).toBe(true);
    if (!result.success) return;

    const [job] = db
      .select()
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.id, result.data.jobIds[0]))
      .all();

    expect(job.compressFirst).toBe(false);
  });
});

// === getImageAnnotationData with navigationIds ===

describe("getImageAnnotationData with navigationIds", () => {
  it("computes prev/next/totalImages from the supplied filtered list", async () => {
    const [a, b, c] = seed.images;
    // Pretend the user filtered the grid to images [c, a] in that order.
    const filtered = [c.id, a.id];

    const data = await actions.getImageAnnotationData(c.id, seed.job.id, filtered);
    expect(data).not.toBeNull();
    if (!data) return;

    expect(data.totalImages).toBe(2);
    expect(data.currentIndex).toBe(0);
    expect(data.prevImageId).toBeNull();
    expect(data.nextImageId).toBe(a.id);
    // Sanity: image b is excluded entirely
    expect(filtered).not.toContain(b.id);
  });

  it("computes prev/next from the middle of the filtered list", async () => {
    const [a, b, c] = seed.images;
    const filtered = [a.id, c.id, b.id];

    const data = await actions.getImageAnnotationData(c.id, seed.job.id, filtered);
    if (!data) return;

    expect(data.currentIndex).toBe(1);
    expect(data.prevImageId).toBe(a.id);
    expect(data.nextImageId).toBe(b.id);
    expect(data.totalImages).toBe(3);
  });

  it("returns null prev/next when current image is not in the filter", async () => {
    const [a, b, c] = seed.images;
    const filtered = [a.id, b.id]; // c not included

    const data = await actions.getImageAnnotationData(c.id, seed.job.id, filtered);
    if (!data) return;

    expect(data.currentIndex).toBe(-1);
    expect(data.prevImageId).toBeNull();
    expect(data.nextImageId).toBeNull();
    expect(data.totalImages).toBe(2);
  });

  it("falls back to the full job when navigationIds is omitted", async () => {
    const [a, b, c] = seed.images;

    const data = await actions.getImageAnnotationData(b.id, seed.job.id);
    if (!data) return;

    // seed creates 3 images; getJobImageIds orders by timestamp/filename.
    // All three filenames sort as IMG_001 < IMG_002 < IMG_003, so b is in the middle.
    expect(data.totalImages).toBe(3);
    expect(data.currentIndex).toBe(1);
    expect(data.prevImageId).toBe(a.id);
    expect(data.nextImageId).toBe(c.id);
  });

  it("treats an empty navigationIds array as 'no filter' (full job)", async () => {
    const [, b] = seed.images;

    const data = await actions.getImageAnnotationData(b.id, seed.job.id, []);
    if (!data) return;

    expect(data.totalImages).toBe(3);
  });
});

// === getImageAnnotationData verification stats ===
//
// Verification progress shown on the annotation header is intentionally
// deployment-scoped, not per-job. After an incremental ML run the latest job
// might only contain 2 newly added images — but the user reviewing the gallery
// expects "X/Y revisadas" to reflect the entire deployment, not "0/2".

describe("getImageAnnotationData verification stats are deployment-scoped", () => {
  it("returns deployment-wide identification totals on a single-job seed", async () => {
    const data = await actions.getImageAnnotationData(
      seed.images[0].id,
      seed.job.id,
    );
    expect(data).not.toBeNull();
    if (!data) return;

    // Seed has 3 identifications across 3 images. Stats should reflect that.
    expect(data.verificationStats.total).toBe(3);
    expect(data.verificationStats.unverified).toBe(3);
    expect(data.verificationStats.verified).toBe(0);
  });

  it("counts identifications from MORE THAN one job", async () => {
    // Add a second completed job with 1 image + 1 detection + 1 identification.
    const [secondJob] = db
      .insert(schema.processingJobs)
      .values({
        deploymentId: seed.deployment.id,
        status: "completed",
        jobType: "ml_incremental",
        totalImages: 1,
        processedImages: 1,
        completedAt: new Date(),
      })
      .returning()
      .all();

    const [newImg] = db
      .insert(schema.images)
      .values({
        deploymentId: seed.deployment.id,
        jobId: secondJob.id,
        filename: "INC_VS.jpg",
        status: "processed",
      })
      .returning()
      .all();

    const [newDet] = db
      .insert(schema.detections)
      .values({
        imageId: newImg.id,
        jobId: secondJob.id,
        bboxX: 0.1,
        bboxY: 0.1,
        bboxWidth: 0.4,
        bboxHeight: 0.4,
        detectionConfidence: 0.92,
        detectionClass: 0,
        modelVersion: "test-v1",
      })
      .returning()
      .all();

    db.insert(schema.identifications)
      .values({
        detectionId: newDet.id,
        species: "Panthera onca",
        confidence: 0.91,
        modelVersion: "test-v1",
        verificationStatus: "unverified",
      })
      .run();

    // Call against the NEW (small) job — this is what would happen if a user
    // navigated through the latest incremental job's image. Pre-fix, this
    // would have returned total=1 (only the new image's identification).
    const data = await actions.getImageAnnotationData(newImg.id, secondJob.id);
    expect(data).not.toBeNull();
    if (!data) return;

    // 3 from seed.job + 1 from secondJob = 4.
    expect(data.verificationStats.total).toBe(4);
  });

  it("returns deployment-wide stats even when navigationIds scopes navigation", async () => {
    // Reproduces the exact bug the user hit: deployment overlay snapshots a
    // filtered list as navigationIds, but verification stats need to keep
    // reflecting the full deployment.
    const [secondJob] = db
      .insert(schema.processingJobs)
      .values({
        deploymentId: seed.deployment.id,
        status: "completed",
        jobType: "ml_incremental",
        totalImages: 1,
        processedImages: 1,
        completedAt: new Date(),
      })
      .returning()
      .all();

    const [newImg] = db
      .insert(schema.images)
      .values({
        deploymentId: seed.deployment.id,
        jobId: secondJob.id,
        filename: "INC_NAV.jpg",
        status: "processed",
      })
      .returning()
      .all();

    const [newDet] = db
      .insert(schema.detections)
      .values({
        imageId: newImg.id,
        jobId: secondJob.id,
        bboxX: 0.1,
        bboxY: 0.1,
        bboxWidth: 0.4,
        bboxHeight: 0.4,
        detectionConfidence: 0.92,
        detectionClass: 0,
        modelVersion: "test-v1",
      })
      .returning()
      .all();

    db.insert(schema.identifications)
      .values({
        detectionId: newDet.id,
        species: "Panthera onca",
        confidence: 0.91,
        verificationStatus: "unverified",
      })
      .run();

    // Simulate the deployment-gallery snapshot: user is navigating all 4
    // images (3 seed + 1 new), passes them as navigationIds, calls with the
    // jobId of the small incremental job.
    const filtered = [...seed.images.map((i) => i.id), newImg.id];
    const data = await actions.getImageAnnotationData(
      newImg.id,
      secondJob.id,
      filtered,
    );
    expect(data).not.toBeNull();
    if (!data) return;

    // Navigation respects the filter snapshot (4 images).
    expect(data.totalImages).toBe(4);
    // Verification stats are deployment-scoped (4 identifications).
    // Pre-fix this would have been 1 (only the latest job's identification).
    expect(data.verificationStats.total).toBe(4);
  });

  it("includes manual identifications (jobId IS NULL on detection) in stats", async () => {
    // Add a manual detection + manual identification on a seed image.
    const [manualDet] = db
      .insert(schema.detections)
      .values({
        imageId: seed.images[0].id,
        jobId: null,
        bboxX: 0.5,
        bboxY: 0.5,
        bboxWidth: 0.3,
        bboxHeight: 0.3,
        detectionConfidence: 1.0,
        detectionClass: 0,
        modelVersion: "manual",
      })
      .returning()
      .all();

    db.insert(schema.identifications)
      .values({
        detectionId: manualDet.id,
        species: "Tapirus bairdii",
        confidence: 1.0,
        verificationStatus: "unverified",
      })
      .run();

    const data = await actions.getImageAnnotationData(
      seed.images[0].id,
      seed.job.id,
    );
    expect(data).not.toBeNull();
    if (!data) return;

    // 3 ML identifications (seed) + 1 manual = 4.
    expect(data.verificationStats.total).toBe(4);
  });

  it("reflects newly verified identifications in the reviewed count", async () => {
    // Mark one seed identification as verified.
    db.update(schema.identifications)
      .set({ verificationStatus: "verified" })
      .where(eq(schema.identifications.id, seed.identifications[0].id))
      .run();

    const data = await actions.getImageAnnotationData(
      seed.images[0].id,
      seed.job.id,
    );
    expect(data).not.toBeNull();
    if (!data) return;

    expect(data.verificationStats.total).toBe(3);
    expect(data.verificationStats.verified).toBe(1);
    expect(data.verificationStats.unverified).toBe(2);
    // The reviewed count the UI displays = total - unverified = 1.
    expect(
      data.verificationStats.total - data.verificationStats.unverified,
    ).toBe(1);
  });
});

// === verifyAndAdvance with candidateImageIds ===

describe("verifyAndAdvance with candidateImageIds", () => {
  it("advances within the filtered subset in list order", async () => {
    const [a, b, c] = seed.images;
    // Filtered list orders images c first, then a, then b.
    const filtered = [c.id, a.id, b.id];

    // Verify nothing on the current image; just ask "what's next from c?"
    const result = await actions.verifyAndAdvance([], seed.job.id, c.id, filtered);
    expect(result.success).toBe(true);
    if (!result.success) return;

    // Next unverified after c in filtered order is a.
    expect(result.data.nextImageId).toBe(a.id);
    expect(result.data.deploymentCompleted).toBeFalsy();
  });

  it("wraps around inside the filtered subset", async () => {
    const [a, b, c] = seed.images;
    const filtered = [a.id, b.id, c.id];

    // From c (last in list), wrap to a.
    const result = await actions.verifyAndAdvance([], seed.job.id, c.id, filtered);
    if (!result.success) return;

    expect(result.data.nextImageId).toBe(a.id);
  });

  it("returns null when all images in the filtered subset are verified", async () => {
    const [a, b] = seed.images;
    const [identA, identB] = seed.identifications;
    const filtered = [a.id, b.id];

    // Mark all identifications inside the filtered subset as verified up front.
    db
      .update(schema.identifications)
      .set({ verificationStatus: "verified" })
      .where(eq(schema.identifications.id, identA.id))
      .run();
    db
      .update(schema.identifications)
      .set({ verificationStatus: "verified" })
      .where(eq(schema.identifications.id, identB.id))
      .run();

    const result = await actions.verifyAndAdvance([], seed.job.id, a.id, filtered);
    if (!result.success) return;

    expect(result.data.nextImageId).toBeNull();
    // Critically: finishing a filtered subset must NOT mark the deployment complete.
    expect(result.data.deploymentCompleted).toBeFalsy();

    const [dep] = db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, seed.deployment.id))
      .all();
    expect(dep.status).toBe("processed"); // unchanged
  });

  it("preserves unfiltered behavior when candidateImageIds is omitted", async () => {
    const [a, b] = seed.images;

    // Three unverified identifications exist (one per image). From a, the next
    // forward in id order should be b.
    const result = await actions.verifyAndAdvance([], seed.job.id, a.id);
    if (!result.success) return;

    expect(result.data.nextImageId).toBe(b.id);
  });

  it("treats an empty candidateImageIds array as 'no filter' (unfiltered behavior)", async () => {
    const [a, b] = seed.images;

    const result = await actions.verifyAndAdvance([], seed.job.id, a.id, []);
    if (!result.success) return;

    expect(result.data.nextImageId).toBe(b.id);
  });
});
