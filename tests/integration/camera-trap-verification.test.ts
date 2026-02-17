/**
 * Integration tests for camera-trap verification workflow.
 *
 * Uses a real in-memory SQLite database to test:
 * - verify/reject/correct identifications
 * - bulk verify operations
 * - species CRUD with cascade updates
 * - manual detection creation with bbox validation
 * - detection deletion
 * - assignSpecies logic (match → verify, mismatch → correct)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, seedTestData, testDbRef, setupIntegrationDbMock } from "../helpers/test-db";
import {
  mockRequirePermission,
  setupAuthMocks,
  testUser,
} from "../helpers/mock-auth";

// Use proven mock patterns from helpers (vi.mock inside function, called at module level)
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
  ML_DEFAULTS: { minConfidence: 0.5, modelName: "test" },
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

// --- Import actions AFTER mocks ---
const actions = await import("@/app/camera-trap/actions");

// --- Test setup ---

let seed: ReturnType<typeof seedTestData>;
let db: ReturnType<typeof createTestDb>;

beforeEach(() => {
  vi.clearAllMocks();
  db = createTestDb();
  testDbRef.current = db;
  seed = seedTestData(db);
  mockRequirePermission.mockResolvedValue(testUser);
});

// === Verification Workflow ===

describe("verification workflow", () => {
  it("verifyIdentification sets status to verified", async () => {
    const identId = seed.identifications[0].id;

    const result = await actions.verifyIdentification(identId);
    expect(result.success).toBe(true);

    const [updated] = db
      .select()
      .from(schema.identifications)
      .where(eq(schema.identifications.id, identId))
      .all();

    expect(updated.verificationStatus).toBe("verified");
    expect(updated.verifiedBy).toBe(testUser.email);
    expect(updated.verifiedAt).toBeTruthy();
  });

  it("verifyIdentification only updates unverified identifications", async () => {
    const identId = seed.identifications[0].id;

    // First verify
    await actions.verifyIdentification(identId);

    // Try to verify again — should still be verified (no error, but no change either)
    const result = await actions.verifyIdentification(identId);
    expect(result.success).toBe(true);

    const [updated] = db
      .select()
      .from(schema.identifications)
      .where(eq(schema.identifications.id, identId))
      .all();

    expect(updated.verificationStatus).toBe("verified");
  });

  it("rejectIdentification sets status to rejected", async () => {
    const identId = seed.identifications[1].id;

    const result = await actions.rejectIdentification(identId);
    expect(result.success).toBe(true);

    const [updated] = db
      .select()
      .from(schema.identifications)
      .where(eq(schema.identifications.id, identId))
      .all();

    expect(updated.verificationStatus).toBe("rejected");
    expect(updated.verifiedBy).toBe(testUser.email);
  });

  it("correctIdentification sets correctedSpecies and status", async () => {
    const identId = seed.identifications[0].id;

    const result = await actions.correctIdentification(identId, "Panthera onca");
    expect(result.success).toBe(true);

    const [updated] = db
      .select()
      .from(schema.identifications)
      .where(eq(schema.identifications.id, identId))
      .all();

    expect(updated.verificationStatus).toBe("corrected");
    expect(updated.correctedSpecies).toBe("Panthera onca");
    expect(updated.verifiedBy).toBe(testUser.email);
  });

  it("correctIdentification can re-correct an already corrected identification", async () => {
    const identId = seed.identifications[0].id;

    await actions.correctIdentification(identId, "Panthera onca");
    const result = await actions.correctIdentification(identId, "Tapirus bairdii");
    expect(result.success).toBe(true);

    const [updated] = db
      .select()
      .from(schema.identifications)
      .where(eq(schema.identifications.id, identId))
      .all();

    expect(updated.correctedSpecies).toBe("Tapirus bairdii");
  });

  it("bulkVerify verifies multiple identifications", async () => {
    const ids = seed.identifications.map((i) => i.id);

    const result = await actions.bulkVerify(ids);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.count).toBe(3);
    }

    const all = db.select().from(schema.identifications).all();
    expect(all.every((i) => i.verificationStatus === "verified")).toBe(true);
  });

  it("bulkVerify with empty array returns count 0", async () => {
    const result = await actions.bulkVerify([]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.count).toBe(0);
    }
  });

  it("bulkVerify skips already verified identifications", async () => {
    // Verify first one manually
    await actions.verifyIdentification(seed.identifications[0].id);

    // Bulk verify all — should only update the remaining 2
    const ids = seed.identifications.map((i) => i.id);
    const result = await actions.bulkVerify(ids);
    expect(result.success).toBe(true);

    const all = db.select().from(schema.identifications).all();
    expect(all.every((i) => i.verificationStatus === "verified")).toBe(true);
  });
});

// === Species Assignment ===

describe("assignSpecies", () => {
  it("marks as verified when species matches ML prediction", async () => {
    const identId = seed.identifications[0].id;
    // Original species is "Dasyprocta punctata" — assigning the same
    const result = await actions.assignSpecies(identId, "Dasyprocta punctata");
    expect(result.success).toBe(true);

    const [updated] = db
      .select()
      .from(schema.identifications)
      .where(eq(schema.identifications.id, identId))
      .all();

    expect(updated.verificationStatus).toBe("verified");
    expect(updated.correctedSpecies).toBeNull();
  });

  it("marks as corrected when species differs from ML prediction", async () => {
    const identId = seed.identifications[0].id;
    const result = await actions.assignSpecies(identId, "Panthera onca");
    expect(result.success).toBe(true);

    const [updated] = db
      .select()
      .from(schema.identifications)
      .where(eq(schema.identifications.id, identId))
      .all();

    expect(updated.verificationStatus).toBe("corrected");
    expect(updated.correctedSpecies).toBe("Panthera onca");
  });

  it("rejects assigning species to a rejected identification", async () => {
    const identId = seed.identifications[0].id;
    await actions.rejectIdentification(identId);

    const result = await actions.assignSpecies(identId, "Panthera onca");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("rechazada");
    }
  });

  it("returns error for non-existent identification", async () => {
    const result = await actions.assignSpecies(99999, "Panthera onca");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("no encontrada");
    }
  });
});

// === Manual Detection ===

describe("createManualDetection", () => {
  it("creates detection + identification with manual marker", async () => {
    const imageId = seed.images[0].id;

    const result = await actions.createManualDetection(imageId, {
      x: 0.2,
      y: 0.3,
      width: 0.4,
      height: 0.5,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.detectionId).toBeGreaterThan(0);
      expect(result.data.identificationId).toBeGreaterThan(0);
    }

    // Verify detection was created with correct values
    const dets = db.select().from(schema.detections).all();
    const manual = dets.find((d) => d.modelVersion === "manual");
    expect(manual).toBeDefined();
    expect(manual!.bboxX).toBeCloseTo(0.2);
    expect(manual!.bboxY).toBeCloseTo(0.3);
    expect(manual!.detectionConfidence).toBe(1.0);

    // Verify identification was created as unverified
    if (result.success) {
      const [ident] = db
        .select()
        .from(schema.identifications)
        .where(eq(schema.identifications.id, result.data.identificationId))
        .all();
      expect(ident.species).toBe("unknown");
      expect(ident.verificationStatus).toBe("unverified");
      expect(ident.modelVersion).toBe("manual");
    }
  });

  it("rejects invalid bbox coordinates", async () => {
    const imageId = seed.images[0].id;

    // Negative coordinates
    let result = await actions.createManualDetection(imageId, {
      x: -0.1, y: 0, width: 0.5, height: 0.5,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("bbox");

    // Zero width
    result = await actions.createManualDetection(imageId, {
      x: 0, y: 0, width: 0, height: 0.5,
    });
    expect(result.success).toBe(false);

    // Exceeds bounds (x + width > 1.01)
    result = await actions.createManualDetection(imageId, {
      x: 0.8, y: 0, width: 0.3, height: 0.5,
    });
    expect(result.success).toBe(false);
  });

  it("clears confirmedBlank when adding manual detection", async () => {
    const imageId = seed.images[0].id;

    // Mark image as confirmed blank
    db
      .update(schema.images)
      .set({ confirmedBlank: true })
      .where(eq(schema.images.id, imageId))
      .run();

    await actions.createManualDetection(imageId, {
      x: 0.1, y: 0.1, width: 0.5, height: 0.5,
    });

    const [image] = db
      .select()
      .from(schema.images)
      .where(eq(schema.images.id, imageId))
      .all();

    expect(image.confirmedBlank).toBe(false);
  });

  it("returns error for non-existent image", async () => {
    const result = await actions.createManualDetection(99999, {
      x: 0.1, y: 0.1, width: 0.5, height: 0.5,
    });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("no encontrada");
  });
});

// === Delete Detection ===

describe("deleteDetection", () => {
  it("deletes detection and cascades to identification", async () => {
    const detId = seed.detections[0].id;

    const result = await actions.deleteDetection(detId);
    expect(result.success).toBe(true);

    // Detection should be gone
    const dets = db
      .select()
      .from(schema.detections)
      .where(eq(schema.detections.id, detId))
      .all();
    expect(dets).toHaveLength(0);

    // Identification should also be gone (CASCADE)
    const idents = db
      .select()
      .from(schema.identifications)
      .where(eq(schema.identifications.detectionId, detId))
      .all();
    expect(idents).toHaveLength(0);
  });

  it("logs activity on detection deletion", async () => {
    const detId = seed.detections[0].id;
    await actions.deleteDetection(detId);

    const logs = db.select().from(schema.activityLog).all();
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe("delete_detection");
    expect(logs[0].userEmail).toBe(testUser.email);
    expect(logs[0].targetId).toBe(String(detId));
  });

  it("returns error for non-existent detection", async () => {
    const result = await actions.deleteDetection(99999);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("no encontrada");
  });
});

// === Species CRUD ===

describe("species management", () => {
  it("createSpecies inserts a new species", async () => {
    const result = await actions.createSpecies({
      scientificName: "Tapirus bairdii",
      commonName: "Baird's Tapir",
      spanishName: "Danta",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scientificName).toBe("Tapirus bairdii");
      expect(result.data.commonName).toBe("Baird's Tapir");
      expect(result.data.type).toBe("mammal"); // default
    }
  });

  it("createSpecies trims whitespace", async () => {
    const result = await actions.createSpecies({
      scientificName: "  Tapirus bairdii  ",
      commonName: "  Baird's Tapir  ",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scientificName).toBe("Tapirus bairdii");
      expect(result.data.commonName).toBe("Baird's Tapir");
    }
  });

  it("createSpecies rejects duplicate scientificName", async () => {
    // "Dasyprocta punctata" already exists from seed
    const result = await actions.createSpecies({
      scientificName: "Dasyprocta punctata",
      commonName: "Duplicate Agouti",
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Ya existe");
    }
  });

  it("deleteSpecies removes species with no references", async () => {
    // Create unreferenced species
    const created = await actions.createSpecies({
      scientificName: "Tapirus bairdii",
      commonName: "Baird's Tapir",
    });
    expect(created.success).toBe(true);
    if (!created.success) return;

    const result = await actions.deleteSpecies(created.data.id);
    expect(result.success).toBe(true);

    const remaining = db
      .select()
      .from(schema.species)
      .where(eq(schema.species.scientificName, "Tapirus bairdii"))
      .all();
    expect(remaining).toHaveLength(0);
  });

  it("deleteSpecies blocks deletion when species is referenced in corrections", async () => {
    // Correct an identification to use "Dasyprocta punctata"
    await actions.correctIdentification(
      seed.identifications[0].id,
      "Dasyprocta punctata"
    );

    const result = await actions.deleteSpecies(seed.species[0].id);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("referenciada");
    }
  });

  it("deleteSpecies returns error for non-existent species", async () => {
    const result = await actions.deleteSpecies(99999);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("no encontrada");
    }
  });

  it("deleteSpecies logs activity", async () => {
    const created = await actions.createSpecies({
      scientificName: "Tapirus bairdii",
      commonName: "Baird's Tapir",
    });
    if (!created.success) return;

    await actions.deleteSpecies(created.data.id);

    const logs = db.select().from(schema.activityLog).all();
    const deleteLog = logs.find((l) => l.action === "delete_species");
    expect(deleteLog).toBeDefined();
    expect(deleteLog!.userEmail).toBe(testUser.email);
  });

  it("updateSpecies cascades scientificName change to identifications", async () => {
    // Set up: correct an identification to "Dasyprocta punctata"
    const identId = seed.identifications[0].id;
    db
      .update(schema.identifications)
      .set({ correctedSpecies: "Dasyprocta punctata" })
      .where(eq(schema.identifications.id, identId))
      .run();

    // Rename the species
    const result = await actions.updateSpecies(seed.species[0].id, {
      scientificName: "Dasyprocta leporina",
    });

    expect(result.success).toBe(true);

    // Check identification.species was cascaded
    const [ident] = db
      .select()
      .from(schema.identifications)
      .where(eq(schema.identifications.id, identId))
      .all();

    // Original species field should be updated
    expect(ident.species).toBe("Dasyprocta leporina");
    // correctedSpecies should also be updated
    expect(ident.correctedSpecies).toBe("Dasyprocta leporina");
  });

  it("updateSpecies without name change does not cascade", async () => {
    const result = await actions.updateSpecies(seed.species[0].id, {
      commonName: "Updated Agouti Name",
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.commonName).toBe("Updated Agouti Name");
      // scientificName unchanged
      expect(result.data.scientificName).toBe("Dasyprocta punctata");
    }
  });
});

// === Job Verification Stats ===

describe("verification stats", () => {
  it("getJobVerificationStats counts by status", async () => {
    // Verify first, reject second, leave third unverified
    await actions.verifyIdentification(seed.identifications[0].id);
    await actions.rejectIdentification(seed.identifications[1].id);

    const stats = await actions.getJobVerificationStats(seed.job.id);

    expect(stats.total).toBe(3);
    expect(stats.verified).toBe(1);
    expect(stats.rejected).toBe(1);
    expect(stats.unverified).toBe(1);
    expect(stats.corrected).toBe(0);
  });

  it("getJobVerificationStats returns zeros for job with no images", async () => {
    // Create an empty job
    const [emptyJob] = db
      .insert(schema.processingJobs)
      .values({
        deploymentId: seed.deployment.id,
        status: "completed",
        totalImages: 0,
        processedImages: 0,
      })
      .returning()
      .all();

    const stats = await actions.getJobVerificationStats(emptyJob.id);
    expect(stats.total).toBe(0);
    expect(stats.verified).toBe(0);
  });
});
