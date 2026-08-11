/**
 * Integration tests for the bulk species import commit.
 *
 * The load-bearing property is fault isolation: the commit creates and draws
 * each species in turn, and one species failing — ODK down, no accessible
 * detections — must not abort the batch or roll back the ones that worked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { mockRequirePermission, setupAuthMocks, testUser } from "../helpers/mock-auth";
import {
  createTestDb,
  setupIntegrationDbMock,
  testDbRef,
  type TestDb,
} from "../helpers/test-db";

setupAuthMocks();
setupIntegrationDbMock();

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const mockHabitatMap = vi.fn();
vi.mock("@/lib/habitat-lookup", () => ({
  loadSiteHabitatMap: () => mockHabitatMap(),
}));

vi.mock("@/lib/camera-trap-auth", () => ({
  getUserCameraTrapProjects: vi.fn(async () => "all"),
}));

let db: TestDb;
let deploymentId: number;

function seedDetections(species: string, count: number) {
  for (let i = 0; i < count; i++) {
    const [file] = db
      .insert(schema.audioFiles)
      .values({
        deploymentId,
        filename: `IMP_20260210_1200${String(i).padStart(2, "0")}.flac`,
        driveFileId: `drive-${species}-${i}`,
        duration: 60,
      })
      .returning()
      .all();
    const [detection] = db
      .insert(schema.audioDetections)
      .values({
        audioFileId: file.id,
        startTime: 10,
        endTime: 13,
        minFreq: 0,
        maxFreq: 15000,
        confidence: 0.5 + i / 1000,
      })
      .returning()
      .all();
    db.insert(schema.audioIdentifications)
      .values({
        audioDetectionId: detection.id,
        species,
        confidence: 0.5 + i / 1000,
      })
      .run();
  }
}

/** Commit plain names, for the cases that predate the notes column. */
async function commit(names: string[]) {
  const { commitSpeciesImport } = await import("@/app/audio/validacion/import-actions");
  return commitSpeciesImport(names.map((scientificName) => ({ scientificName, notes: null })));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequirePermission.mockResolvedValue(testUser);
  mockHabitatMap.mockResolvedValue(new Map([["IMP-000", "bosque maduro"]]));

  db = createTestDb();
  testDbRef.current = db;

  const [ctProject] = db
    .insert(schema.cameraTrapProjects)
    .values({ name: "ImportTestProject" })
    .returning()
    .all();
  const [deployment] = db
    .insert(schema.deployments)
    .values({
      projectId: "camera-trap",
      name: "IMP-000",
      siteName: "IMP-000",
      status: "scanned",
      cameraTrapProjectId: ctProject.id,
    })
    .returning()
    .all();
  deploymentId = deployment.id;
});

describe("commitSpeciesImport", () => {
  it("creates a validation row and draws a sample for each species", async () => {
    seedDetections("Ramphastos ambiguus", 30);
    seedDetections("Cebus aequatorialis", 30);

    const result = await commit(["Ramphastos ambiguus", "Cebus aequatorialis"]);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.every((r) => r.created)).toBe(true);
    expect(result.data.every((r) => (r.drawn ?? 0) > 0)).toBe(true);

    const campaigns = db.select().from(schema.birdnetValidationCampaigns).all();
    expect(campaigns).toHaveLength(2);
    // The draw moved both past draft.
    expect(campaigns.every((c) => c.status === "sampled")).toBe(true);
    expect(campaigns.every((c) => c.sampledAt != null)).toBe(true);

    const samples = db.select().from(schema.birdnetValidationSamples).all();
    expect(samples.length).toBeGreaterThan(0);
  });

  it("stores each species' note on its row", async () => {
    seedDetections("Ramphastos ambiguus", 30);
    seedDetections("Cebus aequatorialis", 30);

    const { commitSpeciesImport } = await import(
      "@/app/audio/validacion/import-actions"
    );
    const result = await commitSpeciesImport([
      { scientificName: "Ramphastos ambiguus", notes: "Not on JF list. CHECK" },
      // Whitespace-only is not a note; it collapses to null so the table shows
      // a dash rather than a blank cell that looks like a rendering bug.
      { scientificName: "Cebus aequatorialis", notes: "   " },
    ]);

    expect(result.success).toBe(true);
    const campaigns = db.select().from(schema.birdnetValidationCampaigns).all();
    const byName = new Map(campaigns.map((c) => [c.species, c.notes]));
    expect(byName.get("Ramphastos ambiguus")).toBe("Not on JF list. CHECK");
    expect(byName.get("Cebus aequatorialis")).toBeNull();
  });

  it("skips a species that is already being validated", async () => {
    seedDetections("Ramphastos ambiguus", 30);
    const { createCampaign } = await import("@/app/audio/validacion/actions");
    await createCampaign({ species: "Ramphastos ambiguus" });

    const result = await commit(["Ramphastos ambiguus"]);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data[0].created).toBe(false);
    expect(result.data[0].error).toContain("Ya se está validando");
    expect(db.select().from(schema.birdnetValidationCampaigns).all()).toHaveLength(1);
  });

  it("re-checks duplicates at commit time, not just at preview", async () => {
    // The preview the client holds can go stale — another editor may start the
    // same species in between.
    seedDetections("Ramphastos ambiguus", 30);
    seedDetections("Cebus aequatorialis", 30);
    const { createCampaign } = await import("@/app/audio/validacion/actions");
    await createCampaign({ species: "Cebus aequatorialis" });

    const result = await commit(["Ramphastos ambiguus", "Cebus aequatorialis"]);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.find((r) => r.scientificName === "Ramphastos ambiguus")!.created).toBe(true);
    expect(result.data.find((r) => r.scientificName === "Cebus aequatorialis")!.created).toBe(false);
  });

  it("reports a species with no detections without creating it", async () => {
    db.insert(schema.species)
      .values({
        scientificName: "Panthera onca",
        commonName: "Jaguar",
        spanishName: "Jaguar",
        type: "mammal",
      })
      .run();

    const result = await commit(["Panthera onca"]);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data[0].created).toBe(false);
    expect(result.data[0].error).toContain("Sin detecciones");
    expect(db.select().from(schema.birdnetValidationCampaigns).all()).toHaveLength(0);
  });

  it("keeps going when one species' draw fails", async () => {
    // `Solo detectus` has detections, so it is created — but its draw is
    // emptied. The batch must still create and draw the species that follows.
    seedDetections("Ramphastos ambiguus", 30);
    seedDetections("Cebus aequatorialis", 30);

    // Strip one species' detections after the catalog is built, so it resolves
    // as importable but finds nothing to draw.
    const { commitSpeciesImport } = await import(
      "@/app/audio/validacion/import-actions"
    );
    const originalDraw = await import("@/lib/birdnet-validation/sampling");
    const spy = vi
      .spyOn(originalDraw, "drawStratifiedSample")
      .mockImplementationOnce(async () => ({
        candidates: [],
        available: [],
        allocated: [],
      }));

    const result = await commitSpeciesImport([
      { scientificName: "Ramphastos ambiguus", notes: null },
      { scientificName: "Cebus aequatorialis", notes: null },
    ]);
    spy.mockRestore();

    expect(result.success).toBe(true);
    if (!result.success) return;

    const failed = result.data[0];
    const succeeded = result.data[1];

    // Created but not drawn — recoverable from its row.
    expect(failed.created).toBe(true);
    expect(failed.drawn).toBeNull();
    expect(failed.error).toBeTruthy();

    // The batch continued.
    expect(succeeded.created).toBe(true);
    expect(succeeded.drawn).toBeGreaterThan(0);
    expect(db.select().from(schema.birdnetValidationCampaigns).all()).toHaveLength(2);
  });

  it("refuses more species than one request may carry", async () => {
    // The bound is per REQUEST, not per import — the client walks a long list
    // in chunks of this size. Refusing rather than accepting is deliberate: a
    // request that runs for minutes gets killed part-way with no record of how
    // far it got.
    const { COMMIT_CHUNK_SIZE } = await import(
      "@/app/audio/validacion/species-import"
    );
    const many = Array.from({ length: COMMIT_CHUNK_SIZE + 1 }, (_, i) => `Species ${i}`);
    const result = await commit(many);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain(String(COMMIT_CHUNK_SIZE));
  });

  it("accepts a full chunk and creates every species in it", async () => {
    const { COMMIT_CHUNK_SIZE } = await import(
      "@/app/audio/validacion/species-import"
    );
    const names = Array.from({ length: COMMIT_CHUNK_SIZE }, (_, i) => `Chunkus specimen${i}`);
    for (const name of names) seedDetections(name, 12);

    const result = await commit(names);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toHaveLength(COMMIT_CHUNK_SIZE);
    expect(result.data.every((r) => r.created)).toBe(true);
    expect(db.select().from(schema.birdnetValidationCampaigns).all()).toHaveLength(
      COMMIT_CHUNK_SIZE
    );
  });

  it("isolates a mid-chunk failure without losing the names after it", async () => {
    // The property that makes chunking safe: a slice boundary is never a
    // rollback boundary, so a failure inside one chunk cannot strand the rest.
    const names = ["Aaa aaa", "Bbb bbb", "Ccc ccc", "Ddd ddd"];
    for (const name of names) seedDetections(name, 12);

    const sampling = await import("@/lib/birdnet-validation/sampling");
    // Captured BEFORE the spy replaces it, so the pass-through calls the real
    // draw rather than recursing into the mock.
    const realDraw = sampling.drawStratifiedSample;
    const spy = vi.spyOn(sampling, "drawStratifiedSample");
    let call = 0;
    spy.mockImplementation(async (opts) => {
      call++;
      if (call === 2) throw new Error("ODK caído");
      return realDraw(opts);
    });

    const { commitSpeciesImport } = await import(
      "@/app/audio/validacion/import-actions"
    );
    const result = await commitSpeciesImport(
      names.map((scientificName) => ({ scientificName, notes: null }))
    );
    spy.mockRestore();

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data).toHaveLength(4);
    // The failure is reported against its own species, created but undrawn.
    expect(result.data[1].created).toBe(true);
    expect(result.data[1].drawn).toBeNull();
    // Everything after it still ran.
    expect(result.data[2].drawn).toBeGreaterThan(0);
    expect(result.data[3].drawn).toBeGreaterThan(0);
  });

  it("refuses an empty batch", async () => {
    const result = await commit([]);
    expect(result.success).toBe(false);
  });

  it("assigns queue order that is not confidence order", async () => {
    // Guards the blinding fix at the integration level: the draw emits bin by
    // bin ascending, and `order_index` must not follow it.
    seedDetections("Ramphastos ambiguus", 30);
    await commit(["Ramphastos ambiguus"]);

    const samples = db
      .select()
      .from(schema.birdnetValidationSamples)
      .all()
      .sort((a, b) => a.orderIndex - b.orderIndex);

    expect(samples.length).toBeGreaterThan(2);
    const confidences = samples.map((s) => s.confidence);
    const ascending = [...confidences].sort((a, b) => a - b);
    expect(confidences).not.toEqual(ascending);
  });
});
