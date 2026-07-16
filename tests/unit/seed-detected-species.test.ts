/**
 * U3 — seed row-builder (pure diff logic in scripts/seed-detected-species.mjs).
 */

import { describe, it, expect } from "vitest";
import {
  buildSeedRows,
  parseReferenceCsv,
  EXCLUDED_SPECIES,
} from "../../scripts/seed-detected-species.mjs";

const nameMap = parseReferenceCsv(
  "scientific_name,common_name,spanish_name\n" +
    "Adelomyia melanogenys,Speckled Hummingbird,Colibrí Jaspeado\n",
);

describe("buildSeedRows", () => {
  it("inserts a detected species missing from the lookup with resolved names", () => {
    const rows = buildSeedRows(["Adelomyia melanogenys"], new Set(), nameMap);
    expect(rows).toEqual([
      {
        scientificName: "Adelomyia melanogenys",
        commonName: "Speckled Hummingbird",
        spanishName: "Colibrí Jaspeado",
      },
    ]);
  });

  it("skips species already present in the lookup", () => {
    const rows = buildSeedRows(
      ["Adelomyia melanogenys"],
      new Set(["Adelomyia melanogenys"]),
      nameMap,
    );
    expect(rows).toHaveLength(0);
  });

  it("falls back to the scientific string when absent from the reference (R10)", () => {
    const rows = buildSeedRows(["Zonotrichia capensis"], new Set(), nameMap);
    expect(rows[0]).toEqual({
      scientificName: "Zonotrichia capensis",
      commonName: "Zonotrichia capensis",
      spanishName: null,
    });
  });

  it("filters non-species labels (case-insensitive)", () => {
    expect(EXCLUDED_SPECIES.has("homo sapiens")).toBe(true);
    const rows = buildSeedRows(["Homo sapiens", "Unknown", "Dog"], new Set(), nameMap);
    expect(rows).toHaveLength(0);
  });

  it("ignores blank / whitespace names", () => {
    const rows = buildSeedRows(["", "   ", null as unknown as string], new Set(), nameMap);
    expect(rows).toHaveLength(0);
  });
});
