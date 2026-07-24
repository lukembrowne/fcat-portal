/**
 * Shared species content (fichas de especies) actions.
 *
 * Integration tests against a real in-memory SQLite, covering:
 *  - updateSpeciesContent persists role + tip and returns the row;
 *  - empty/whitespace fields are stored as NULL (the "no card" signal);
 *  - over-max content is rejected;
 *  - a missing species id returns a friendly error;
 *  - fetchSpeciesContentList marks hasContent and orders detected species first.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
import {
  createTestDb,
  testDbRef,
  setupIntegrationDbMock,
  type TestDb,
} from "../../../../../tests/helpers/test-db";
import {
  setupAuthMocks,
  mockRequirePermission,
  testUser,
} from "../../../../../tests/helpers/mock-auth";

setupIntegrationDbMock();
setupAuthMocks();

const { updateSpeciesContent, fetchSpeciesContentList } = await import(
  "../actions"
);
const { SPECIES_CONTENT_MAX } = await import("../content-types");

let db: TestDb;
let guatusaId: number;
let armadilloId: number;

beforeEach(() => {
  db = createTestDb();
  testDbRef.current = db;
  mockRequirePermission.mockResolvedValue(testUser);

  const sp = db
    .insert(schema.species)
    .values([
      { scientificName: "Dasyprocta punctata", commonName: "Agouti", spanishName: "Guatusa", type: "mammal" },
      { scientificName: "Dasypus novemcinctus", commonName: "Armadillo", spanishName: "Armadillo", type: "mammal" },
    ])
    .returning()
    .all();
  guatusaId = sp[0].id;
  armadilloId = sp[1].id;
});

describe("updateSpeciesContent", () => {
  it("persists the content (trimmed)", async () => {
    const res = await updateSpeciesContent(guatusaId, {
      publicContent: "  Dispersa semillas.\n- Vacunar\n- Esterilizar  ",
    });
    expect(res.success).toBe(true);
    const row = db.select().from(schema.species).where(eq(schema.species.id, guatusaId)).get();
    expect(row?.publicContent).toBe("Dispersa semillas.\n- Vacunar\n- Esterilizar");
  });

  it("stores empty/whitespace content as NULL", async () => {
    await updateSpeciesContent(guatusaId, { publicContent: "Algo" });
    let row = db.select().from(schema.species).where(eq(schema.species.id, guatusaId)).get();
    expect(row?.publicContent).toBe("Algo");

    await updateSpeciesContent(guatusaId, { publicContent: "   " });
    row = db.select().from(schema.species).where(eq(schema.species.id, guatusaId)).get();
    expect(row?.publicContent).toBeNull();
  });

  it("rejects content over the max length", async () => {
    const res = await updateSpeciesContent(guatusaId, {
      publicContent: "x".repeat(SPECIES_CONTENT_MAX + 1),
    });
    expect(res.success).toBe(false);
  });

  it("returns an error for a missing species id", async () => {
    const res = await updateSpeciesContent(999999, { publicContent: "x" });
    expect(res.success).toBe(false);
  });
});

describe("fetchSpeciesContentList", () => {
  it("marks hasContent and lists species", async () => {
    await updateSpeciesContent(guatusaId, {
      publicContent: "Dispersa semillas.",
    });
    const list = await fetchSpeciesContentList();
    const guatusa = list.find((s) => s.id === guatusaId);
    const armadillo = list.find((s) => s.id === armadilloId);
    expect(guatusa?.hasContent).toBe(true);
    expect(armadillo?.hasContent).toBe(false);
  });

  it("orders species with detections before those without", async () => {
    // Give the armadillo a verified detection so it should sort first.
    const [dep] = db
      .insert(schema.deployments)
      .values({ projectId: "camera-trap", name: "TST-001_V1", status: "processed" })
      .returning()
      .all();
    const [img] = db
      .insert(schema.images)
      .values({ deploymentId: dep.id, filename: "a.jpg", status: "processed" })
      .returning()
      .all();
    const [det] = db
      .insert(schema.detections)
      .values({ imageId: img.id, bboxX: 0, bboxY: 0, bboxWidth: 1, bboxHeight: 1, detectionConfidence: 0.9 })
      .returning()
      .all();
    db.insert(schema.identifications)
      .values({ detectionId: det.id, species: "Dasypus novemcinctus", confidence: 0.9, verificationStatus: "verified" })
      .run();

    const list = await fetchSpeciesContentList();
    expect(list[0].id).toBe(armadilloId);
    expect(list[0].detectionCount).toBeGreaterThan(0);
  });
});
