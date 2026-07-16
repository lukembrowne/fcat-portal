/**
 * U4 — auto-add newly-detected species on a BirdNET run.
 *
 * Tests the upsert step in isolation: new species land with type='bird' +
 * camera_selectable=0 + resolved names (fallback to scientific string),
 * non-species labels are skipped, and existing species are never clobbered.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  createTestDb,
  testDbRef,
  setupIntegrationDbMock,
  type TestDb,
} from "../helpers/test-db";

setupIntegrationDbMock();

// Keep isNonSpeciesLabel real; stub name resolution deterministically.
vi.mock("@/lib/birdnet-taxonomy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/birdnet-taxonomy")>();
  return {
    ...actual,
    resolveBirdnetName: (name: string) =>
      name === "Adelomyia melanogenys"
        ? { commonName: "Speckled Hummingbird", spanishName: "Colibrí Jaspeado" }
        : null,
  };
});

const { upsertNewBirdnetSpecies } = await import("@/lib/birdnet-runner");

let db: TestDb;

beforeEach(() => {
  db = createTestDb();
  testDbRef.current = db;
});

async function speciesByName(name: string) {
  const [row] = await db.select().from(schema.species).where(eq(schema.species.scientificName, name));
  return row;
}

describe("upsertNewBirdnetSpecies", () => {
  it("adds a new species with resolved names, type='bird', camera_selectable=0", async () => {
    const added = await upsertNewBirdnetSpecies(new Set(["Adelomyia melanogenys"]));
    expect(added).toBe(1);
    const row = await speciesByName("Adelomyia melanogenys");
    expect(row.commonName).toBe("Speckled Hummingbird");
    expect(row.spanishName).toBe("Colibrí Jaspeado");
    expect(row.type).toBe("bird");
    expect(row.cameraSelectable).toBe(false);
  });

  it("falls back to the scientific string when the name is unresolved (R10)", async () => {
    await upsertNewBirdnetSpecies(new Set(["Zonotrichia capensis"]));
    const row = await speciesByName("Zonotrichia capensis");
    expect(row.commonName).toBe("Zonotrichia capensis");
    expect(row.spanishName).toBeNull();
  });

  it("skips non-species labels", async () => {
    const added = await upsertNewBirdnetSpecies(new Set(["Homo sapiens", "Dog", "Unknown"]));
    expect(added).toBe(0);
  });

  it("leaves existing species untouched (no flag/status clobber)", async () => {
    db.insert(schema.species)
      .values({
        scientificName: "Adelomyia melanogenys",
        commonName: "Existing Name",
        type: "bird",
        iucnStatus: "LC",
        cameraSelectable: true, // manually promoted for camera
      })
      .run();

    const added = await upsertNewBirdnetSpecies(new Set(["Adelomyia melanogenys"]));
    expect(added).toBe(0);
    const row = await speciesByName("Adelomyia melanogenys");
    expect(row.commonName).toBe("Existing Name");
    expect(row.iucnStatus).toBe("LC");
    expect(row.cameraSelectable).toBe(true);
  });

  it("is idempotent across repeated runs", async () => {
    await upsertNewBirdnetSpecies(new Set(["Adelomyia melanogenys"]));
    const added2 = await upsertNewBirdnetSpecies(new Set(["Adelomyia melanogenys"]));
    expect(added2).toBe(0);
    const rows = await db
      .select()
      .from(schema.species)
      .where(eq(schema.species.scientificName, "Adelomyia melanogenys"));
    expect(rows).toHaveLength(1);
  });
});
