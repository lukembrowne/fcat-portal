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

    const logs = db.select().from(schema.activityLog).all();
    const deleteLog = logs.find((l) => l.action === "delete_job");
    expect(deleteLog).toBeDefined();
    expect(deleteLog!.userEmail).toBe(testUser.email);
    expect(deleteLog!.targetId).toBe(String(seed.job.id));
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
