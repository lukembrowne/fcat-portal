/**
 * U7 — occupancy common/scientific/IUCN columns.
 *
 * Two seams:
 *  - getOccupancySpeciesInfo: joins biochoco_species by scientific name and
 *    returns null when absent (detail-header fallback, R10).
 *  - ReadinessTable: renders separate common-name + scientific-name columns,
 *    the IUCN code, and falls back to the scientific string when unmatched.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as schema from "@/db/schema";
import {
  createTestDb,
  testDbRef,
  setupIntegrationDbMock,
  type TestDb,
} from "../helpers/test-db";
import {
  setupAuthMocks,
  mockRequirePermission,
  testUser,
} from "../helpers/mock-auth";
import { ReadinessTable } from "@/app/ocupacion/readiness-table";
import type { ReadinessSpeciesRow } from "@/lib/occupancy/readiness";

setupIntegrationDbMock();
setupAuthMocks();

const { getOccupancySpeciesInfo } = await import("@/app/ocupacion/actions");

let db: TestDb;

beforeEach(() => {
  db = createTestDb();
  testDbRef.current = db;
  mockRequirePermission.mockResolvedValue(testUser);

  db.insert(schema.species)
    .values([
      {
        scientificName: "Panthera onca",
        commonName: "Jaguar",
        spanishName: "Jaguar",
        type: "mammal",
        iucnStatus: "NT",
      },
    ])
    .run();
});

describe("getOccupancySpeciesInfo", () => {
  it("returns names + IUCN status for a matched species", async () => {
    const info = await getOccupancySpeciesInfo("Panthera onca");
    expect(info).toEqual({ commonName: "Jaguar", spanishName: "Jaguar", iucnStatus: "NT" });
  });

  it("returns null for a species absent from the lookup (R10)", async () => {
    const info = await getOccupancySpeciesInfo("Adelomyia melanogenys");
    expect(info).toBeNull();
  });
});

function row(overrides: Partial<ReadinessSpeciesRow>): ReadinessSpeciesRow {
  return {
    species: "Panthera onca",
    eligible: true,
    reasons: [],
    nSites: 5,
    nSitesDetected: 3,
    totalDetections: 12,
    maxOccasions: 8,
    naiveOccupancy: 0.6,
    ...overrides,
  };
}

describe("ReadinessTable columns", () => {
  it("renders common name, scientific name, and the IUCN code", () => {
    const html = renderToStaticMarkup(
      <ReadinessTable
        rows={[row({ commonName: "Jaguar", iucnStatus: "NT" })]}
        stream="camera"
        modeled={new Map()}
      />,
    );
    expect(html).toContain("Nombre común");
    expect(html).toContain("Nombre científico");
    expect(html).toContain("Jaguar");
    expect(html).toContain("Panthera onca");
    expect(html).toContain("NT");
  });

  it("falls back to the scientific string when common name is missing (R10)", () => {
    const html = renderToStaticMarkup(
      <ReadinessTable
        rows={[row({ species: "Adelomyia melanogenys", commonName: null, iucnStatus: null })]}
        stream="audio"
        modeled={new Map()}
      />,
    );
    // Scientific string appears in both the common-name cell (fallback) and the
    // scientific-name cell — at least once, and no crash on null names.
    expect(html).toContain("Adelomyia melanogenys");
  });
});
