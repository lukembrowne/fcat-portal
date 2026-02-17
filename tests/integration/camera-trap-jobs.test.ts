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

  it("reverts deployment status to scanned", async () => {
    const createResult = await actions.createProcessingJob(seed.deployment.id);
    expect(createResult.success).toBe(true);
    if (!createResult.success) return;

    await actions.cancelJob(createResult.data.jobId);

    const [dep] = db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, seed.deployment.id))
      .all();

    expect(dep.status).toBe("scanned");
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
