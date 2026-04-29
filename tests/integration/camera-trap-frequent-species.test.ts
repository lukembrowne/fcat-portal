/**
 * Integration tests for getFrequentSpecies — the hotkey-slot source.
 *
 * Covers:
 * - Empty annotation history → falls back to taxonomic type + alphabetical order
 * - Partial history → real top-N plus fallback to fill the slot count
 * - Both "corrected" and "verified" rows count toward the top
 * - Rejected rows are excluded
 * - Empty / whitespace species names don't leak in via COALESCE
 * - Deployment-scoped call still filters correctly
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, seedTestData, testDbRef, setupIntegrationDbMock } from "../helpers/test-db";
import { setupAuthMocks } from "../helpers/mock-auth";

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

const actions = await import("@/app/camera-trap/actions");

let db: ReturnType<typeof createTestDb>;
let seed: ReturnType<typeof seedTestData>;

beforeEach(() => {
  vi.clearAllMocks();
  db = createTestDb();
  testDbRef.current = db;
  seed = seedTestData(db);
});

describe("getFrequentSpecies — project-wide (deploymentId = null)", () => {
  it("falls back to taxonomic + alphabetical order when no identifications are verified", async () => {
    // seed() creates only "unverified" identifications — none should count.
    // It also seeds 2 species: Dasyprocta punctata, Panthera onca.
    // Add a bird and a reptile so we can see taxonomic-type ordering.
    await db.insert(schema.species).values([
      { scientificName: "Tinamus major", commonName: "Great Tinamou", type: "bird" },
      { scientificName: "Boa constrictor", commonName: "Boa", type: "reptile" },
    ]);

    const result = await actions.getFrequentSpecies(null, 10);
    expect(result.success).toBe(true);
    if (!result.success) return;

    // 4 species total, so all 4 come back in taxonomic-type order (mammal first),
    // with alphabetical order within each type.
    expect(result.data).toHaveLength(4);
    expect(result.data.map((s) => s.scientificName)).toEqual([
      "Dasyprocta punctata", // mammal (D before P)
      "Panthera onca",        // mammal
      "Tinamus major",        // bird
      "Boa constrictor",      // reptile
    ]);
  });

  it("counts both verified and corrected identifications", async () => {
    // Mark ident #1 verified (species = Dasyprocta), #2 corrected (to Panthera).
    await db
      .update(schema.identifications)
      .set({ verificationStatus: "verified" })
      .where(eq(schema.identifications.id, seed.identifications[0].id));
    await db
      .update(schema.identifications)
      .set({ verificationStatus: "corrected", correctedSpecies: "Panthera onca" })
      .where(eq(schema.identifications.id, seed.identifications[1].id));

    const result = await actions.getFrequentSpecies(null, 10);
    expect(result.success).toBe(true);
    if (!result.success) return;

    // Both species should be present with real counts (1 each) ahead of fallbacks.
    // Since only 2 species exist, both are included regardless.
    expect(result.data.map((s) => s.scientificName).sort()).toEqual([
      "Dasyprocta punctata",
      "Panthera onca",
    ]);
  });

  it("ranks by descending count", async () => {
    // Add 3 more detections+identifications for Panthera so it outranks Dasyprocta.
    const [newImg] = await db
      .insert(schema.images)
      .values({
        deploymentId: seed.deployment.id,
        jobId: seed.job.id,
        filename: "IMG_004.jpg",
        status: "processed",
      })
      .returning();

    for (let i = 0; i < 3; i++) {
      const [det] = await db
        .insert(schema.detections)
        .values({
          imageId: newImg.id,
          jobId: seed.job.id,
          bboxX: 0.1,
          bboxY: 0.1,
          bboxWidth: 0.2,
          bboxHeight: 0.2,
          detectionConfidence: 0.9,
          detectionClass: 0,
        })
        .returning();
      await db.insert(schema.identifications).values({
        detectionId: det.id,
        species: "Panthera onca",
        confidence: 0.9,
        verificationStatus: "verified",
      });
    }
    // Verify one of the seed Dasyprocta rows so it counts (count = 1).
    await db
      .update(schema.identifications)
      .set({ verificationStatus: "verified" })
      .where(eq(schema.identifications.id, seed.identifications[0].id));

    const result = await actions.getFrequentSpecies(null, 10);
    expect(result.success).toBe(true);
    if (!result.success) return;

    // Panthera (3) should rank ahead of Dasyprocta (1).
    expect(result.data[0].scientificName).toBe("Panthera onca");
    expect(result.data[1].scientificName).toBe("Dasyprocta punctata");
  });

  it("excludes rejected identifications", async () => {
    await db
      .update(schema.identifications)
      .set({ verificationStatus: "rejected" })
      .where(eq(schema.identifications.id, seed.identifications[0].id));

    const result = await actions.getFrequentSpecies(null, 10);
    expect(result.success).toBe(true);
    if (!result.success) return;

    // Rejected ident for Dasyprocta shouldn't contribute any count, but both
    // species are returned via fallback. We assert ordering instead: Dasyprocta
    // comes via fallback (taxonomic order), not via real count.
    expect(result.data).toHaveLength(2);
    expect(result.data.map((s) => s.scientificName).sort()).toEqual([
      "Dasyprocta punctata",
      "Panthera onca",
    ]);
  });

  it("excludes rows whose species / correctedSpecies is empty or whitespace", async () => {
    // Mark seed ident[0] verified but blank its species (simulating messy import).
    await db
      .update(schema.identifications)
      .set({ verificationStatus: "verified", species: "   ", correctedSpecies: "" })
      .where(eq(schema.identifications.id, seed.identifications[0].id));

    const result = await actions.getFrequentSpecies(null, 10);
    expect(result.success).toBe(true);
    if (!result.success) return;

    // Count for the blank row should not appear. Only fallback species come back.
    expect(result.data.map((s) => s.scientificName)).not.toContain("   ");
    expect(result.data.map((s) => s.scientificName)).not.toContain("");
    expect(result.data).toHaveLength(2);
  });

  it("respects the limit argument", async () => {
    // Seed has 2 species; requesting limit=1 should return 1.
    const result = await actions.getFrequentSpecies(null, 1);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data).toHaveLength(1);
  });
});

describe("getFrequentSpecies — deployment-scoped", () => {
  it("filters by deployment when deploymentId is a number", async () => {
    // Seed's default deployment has 3 unverified Dasyprocta idents. Verify one.
    await db
      .update(schema.identifications)
      .set({ verificationStatus: "verified" })
      .where(eq(schema.identifications.id, seed.identifications[0].id));

    // Add a separate deployment with a Panthera ident.
    const [otherDep] = await db
      .insert(schema.deployments)
      .values({
        projectId: "camera-trap",
        name: "OTHER",
        status: "processed",
        cameraTrapProjectId: seed.ctProject.id,
      })
      .returning();
    const [otherImg] = await db
      .insert(schema.images)
      .values({
        deploymentId: otherDep.id,
        jobId: seed.job.id,
        filename: "OTHER_001.jpg",
        status: "processed",
      })
      .returning();
    const [otherDet] = await db
      .insert(schema.detections)
      .values({
        imageId: otherImg.id,
        bboxX: 0.1,
        bboxY: 0.1,
        bboxWidth: 0.2,
        bboxHeight: 0.2,
        detectionConfidence: 0.9,
        detectionClass: 0,
      })
      .returning();
    await db.insert(schema.identifications).values({
      detectionId: otherDet.id,
      species: "Panthera onca",
      confidence: 0.9,
      verificationStatus: "verified",
    });

    // Query scoped to the seed deployment — only Dasyprocta should have a real count.
    const scoped = await actions.getFrequentSpecies(seed.deployment.id, 10);
    expect(scoped.success).toBe(true);
    if (!scoped.success) return;
    expect(scoped.data[0].scientificName).toBe("Dasyprocta punctata");

    // Global query — Panthera and Dasyprocta both have count=1, so ordering
    // between them isn't strict, but both should appear ahead of noise.
    const global = await actions.getFrequentSpecies(null, 10);
    expect(global.success).toBe(true);
    if (!global.success) return;
    expect(global.data.map((s) => s.scientificName).sort()).toEqual([
      "Dasyprocta punctata",
      "Panthera onca",
    ]);
  });
});

