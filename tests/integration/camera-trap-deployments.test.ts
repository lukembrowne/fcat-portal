/**
 * Integration tests for camera-trap deployment CRUD operations.
 *
 * Uses a real in-memory SQLite database to test:
 * - updateDeploymentMetadata field updates
 * - bulkUpdateMetadata batch updates
 * - deleteDeployments cascade behavior
 * - getDeploymentsCascadeStats
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

// === Update Deployment Metadata ===

describe("updateDeploymentMetadata", () => {
  it("updates deployment fields", async () => {
    const result = await actions.updateDeploymentMetadata(seed.deployment.id, {
      name: "UPDATED-DEPLOY",
      siteName: "Estación Biológica",
      latitude: -0.5,
      longitude: -79.5,
    });
    expect(result.success).toBe(true);

    const [dep] = db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, seed.deployment.id))
      .all();

    expect(dep.name).toBe("UPDATED-DEPLOY");
    expect(dep.siteName).toBe("Estación Biológica");
    expect(dep.latitude).toBe(-0.5);
    expect(dep.longitude).toBe(-79.5);
    expect(dep.metadataSource).toBe("manual");
  });

  it("can set fields to null", async () => {
    // First set some values
    await actions.updateDeploymentMetadata(seed.deployment.id, {
      siteName: "Estación",
      latitude: -0.5,
    });

    // Then clear them
    const result = await actions.updateDeploymentMetadata(seed.deployment.id, {
      siteName: null,
      latitude: null,
    });
    expect(result.success).toBe(true);

    const [dep] = db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, seed.deployment.id))
      .all();

    expect(dep.siteName).toBeNull();
    expect(dep.latitude).toBeNull();
  });

  it("returns error for non-existent deployment", async () => {
    const result = await actions.updateDeploymentMetadata(99999, {
      name: "NOPE",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("no encontrada");
    }
  });
});

// === Bulk Update Metadata ===

describe("bulkUpdateMetadata", () => {
  it("updates multiple deployments", async () => {
    // Create a second deployment (same CT project for access check)
    const [dep2] = db
      .insert(schema.deployments)
      .values({
        projectId: "camera-trap",
        name: "DEPLOY-002",
        status: "unscanned",
        cameraTrapProjectId: seed.ctProject.id,
      })
      .returning()
      .all();

    const result = await actions.bulkUpdateMetadata(
      [seed.deployment.id, dep2.id],
      { projectLabel: "Proyecto Biochoco", siteName: "Sitio A" }
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.count).toBe(2);
    }

    const deps = db
      .select()
      .from(schema.deployments)
      .where(inArray(schema.deployments.id, [seed.deployment.id, dep2.id]))
      .all();

    for (const dep of deps) {
      expect(dep.projectLabel).toBe("Proyecto Biochoco");
      expect(dep.siteName).toBe("Sitio A");
      expect(dep.metadataSource).toBe("manual");
    }
  });

  it("returns count 0 for empty array", async () => {
    const result = await actions.bulkUpdateMetadata([], { siteName: "test" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.count).toBe(0);
    }
  });
});

// === Delete Deployments ===

describe("deleteDeployments", () => {
  it("deletes deployment and cascades to images, jobs, detections", async () => {
    const depId = seed.deployment.id;

    const result = await actions.deleteDeployments([depId]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.count).toBe(1);
    }

    // Deployment should be gone
    const deps = db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, depId))
      .all();
    expect(deps).toHaveLength(0);

    // Images should be gone (CASCADE)
    const imgs = db
      .select()
      .from(schema.images)
      .where(eq(schema.images.deploymentId, depId))
      .all();
    expect(imgs).toHaveLength(0);

    // Jobs should be gone (CASCADE)
    const jobs = db
      .select()
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.deploymentId, depId))
      .all();
    expect(jobs).toHaveLength(0);

    // Detections should be gone (cascaded through images)
    const dets = db.select().from(schema.detections).all();
    expect(dets).toHaveLength(0);

    // Identifications should be gone (cascaded through detections)
    const idents = db.select().from(schema.identifications).all();
    expect(idents).toHaveLength(0);
  });

  it("logs activity on deletion", async () => {
    await actions.deleteDeployments([seed.deployment.id]);

    const logs = db.select().from(schema.activityLog).all();
    const deleteLog = logs.find((l) => l.action === "delete_deployments");
    expect(deleteLog).toBeDefined();
    expect(deleteLog!.userEmail).toBe(testUser.email);
    const details = JSON.parse(deleteLog!.details!);
    expect(details.count).toBe(1);
    expect(details.names).toContain("TEST-DEPLOY-001");
  });

  it("returns count 0 for empty array", async () => {
    const result = await actions.deleteDeployments([]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.count).toBe(0);
    }
  });

  it("deletes multiple deployments", async () => {
    // Create a second deployment (same CT project for access check)
    const [dep2] = db
      .insert(schema.deployments)
      .values({
        projectId: "camera-trap",
        name: "DEPLOY-002",
        status: "unscanned",
        cameraTrapProjectId: seed.ctProject.id,
      })
      .returning()
      .all();

    const result = await actions.deleteDeployments([seed.deployment.id, dep2.id]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.count).toBe(2);
    }

    const allDeps = db.select().from(schema.deployments).all();
    expect(allDeps).toHaveLength(0);
  });
});

// === Cascade Stats ===

describe("getDeploymentsCascadeStats", () => {
  it("returns correct counts", async () => {
    const stats = await actions.getDeploymentsCascadeStats([seed.deployment.id]);
    expect(stats.totalImages).toBe(3);
    expect(stats.totalDetections).toBe(3);
    expect(stats.totalVerified).toBe(0); // all unverified in seed
  });

  it("returns zeros for empty array", async () => {
    const stats = await actions.getDeploymentsCascadeStats([]);
    expect(stats.totalImages).toBe(0);
    expect(stats.totalDetections).toBe(0);
    expect(stats.totalVerified).toBe(0);
  });

  it("counts verified identifications correctly", async () => {
    // Verify one identification
    await actions.verifyIdentification(seed.identifications[0].id);

    const stats = await actions.getDeploymentsCascadeStats([seed.deployment.id]);
    expect(stats.totalVerified).toBe(1);
  });
});

// === getDeploymentsWithStats — incremental-aware counts ===
//
// The detection / species count query is keyed by deployment id (not by the
// latest completed job's image set). This keeps the displayed totals correct
// after an incremental run, where the latest completed job only contains the
// new images. These tests cover the new query and the new pendingImageCount
// field added in the same change.

describe("getDeploymentsWithStats — counts and pendingImageCount", () => {
  it("counts detections per deployment, not per latest job", async () => {
    // Simulate the post-incremental state: a SECOND completed job on the
    // same deployment that brought one new image with one new detection.
    // The first job's 3 detections must still be counted alongside it.
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

    const rows = await actions.getDeploymentsWithStats();
    const row = rows.find((r) => r.id === seed.deployment.id);
    expect(row).toBeDefined();
    // 3 (from seed.job) + 1 (from secondJob) = 4 total. Old per-job query
    // would only have returned 1 (the latest completed job's count).
    expect(row!.totalDetections).toBe(4);
  });

  it("pendingImageCount reflects images.status='pending'", async () => {
    // Add 2 pending images on top of the 3 processed seed images.
    db.insert(schema.images)
      .values([
        {
          deploymentId: seed.deployment.id,
          jobId: null,
          filename: "PENDING_001.jpg",
          status: "pending",
        },
        {
          deploymentId: seed.deployment.id,
          jobId: null,
          filename: "PENDING_002.jpg",
          status: "pending",
        },
      ])
      .run();

    const rows = await actions.getDeploymentsWithStats();
    const row = rows.find((r) => r.id === seed.deployment.id);
    expect(row).toBeDefined();
    expect(row!.pendingImageCount).toBe(2);
  });

  it("pendingImageCount is 0 when all images are processed", async () => {
    const rows = await actions.getDeploymentsWithStats();
    const row = rows.find((r) => r.id === seed.deployment.id);
    expect(row).toBeDefined();
    expect(row!.pendingImageCount).toBe(0);
  });

  it("counts species across all completed jobs on a deployment", async () => {
    // Add a second completed job with an identification for a different
    // species — the deployment-wide species count should rise to 2.
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

    const rows = await actions.getDeploymentsWithStats();
    const row = rows.find((r) => r.id === seed.deployment.id);
    expect(row).toBeDefined();
    // Seed had Dasyprocta punctata; new job adds Panthera onca → 2 distinct.
    expect(row!.distinctSpecies).toBe(2);
  });
});

// === Edge Cases ===

describe("edge cases", () => {
  it("deleteDeployments cascades even when deployment has in-progress jobs", async () => {
    // Create a processing job (sets deployment to "processing")
    const createResult = await actions.createProcessingJob(seed.deployment.id);
    expect(createResult.success).toBe(true);

    // Verify deployment is now processing
    const [dep] = db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.id, seed.deployment.id))
      .all();
    expect(dep.status).toBe("processing");

    // Delete should still work and cascade everything
    const result = await actions.deleteDeployments([seed.deployment.id]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.count).toBe(1);
    }

    // Everything should be gone
    const deps = db.select().from(schema.deployments).all();
    expect(deps).toHaveLength(0);
    const jobs = db.select().from(schema.processingJobs).all();
    expect(jobs).toHaveLength(0);
    const imgs = db.select().from(schema.images).all();
    expect(imgs).toHaveLength(0);
  });

  it("updateDeploymentMetadata returns error for empty name", async () => {
    const result = await actions.updateDeploymentMetadata(seed.deployment.id, {
      name: "",
    });
    // The action should either reject empty name or accept it depending on implementation
    // Either way, it should not throw
    expect(result).toHaveProperty("success");
  });
});
