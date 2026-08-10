import { describe, it, expect } from "vitest";

import {
  parseSpeciesList,
  resolveSpeciesRows,
  MAX_PASTE_ROWS,
} from "../species-import";
import type { ValidatableSpecies } from "../actions";

const sp = (over: Partial<ValidatableSpecies>): ValidatableSpecies => ({
  scientificName: "Aaa aaa",
  commonName: "Aaa Bird",
  spanishName: "Pájaro Aaa",
  detectionCount: 10,
  activeStatus: null,
  ...over,
});

describe("parseSpeciesList", () => {
  it("splits a newline-separated list", () => {
    const { names } = parseSpeciesList("Ramphastos ambiguus\nCebus aequatorialis");
    expect(names).toEqual(["Ramphastos ambiguus", "Cebus aequatorialis"]);
  });

  it("splits a single line on commas", () => {
    const { names } = parseSpeciesList("Ramphastos ambiguus, Cebus aequatorialis");
    expect(names).toEqual(["Ramphastos ambiguus", "Cebus aequatorialis"]);
  });

  it("splits a single line on tabs", () => {
    const { names } = parseSpeciesList("Ramphastos ambiguus\tCebus aequatorialis");
    expect(names).toEqual(["Ramphastos ambiguus", "Cebus aequatorialis"]);
  });

  it("takes the first column of a copied spreadsheet block", () => {
    // Excel puts a tab between columns and CRLF between rows. Only the first
    // column can be a species name; the rest is whatever else was selected.
    const pasted = "Ramphastos ambiguus\t500\r\nCebus aequatorialis\t900\r\n";
    expect(parseSpeciesList(pasted).names).toEqual([
      "Ramphastos ambiguus",
      "Cebus aequatorialis",
    ]);
  });

  it("takes the first column of a multi-row CSV", () => {
    const csv = "Ramphastos ambiguus,500\nCebus aequatorialis,900";
    expect(parseSpeciesList(csv).names).toEqual([
      "Ramphastos ambiguus",
      "Cebus aequatorialis",
    ]);
  });

  it("strips surrounding quotes", () => {
    expect(parseSpeciesList('"Ramphastos ambiguus"\n"Cebus aequatorialis"').names).toEqual([
      "Ramphastos ambiguus",
      "Cebus aequatorialis",
    ]);
  });

  it("drops blank and whitespace-only lines", () => {
    const { names } = parseSpeciesList("Ramphastos ambiguus\n\n   \n\nCebus aequatorialis\n");
    expect(names).toEqual(["Ramphastos ambiguus", "Cebus aequatorialis"]);
  });

  it("trims stray whitespace around each name", () => {
    expect(parseSpeciesList("  Ramphastos ambiguus  \n\tCebus aequatorialis ").names).toEqual([
      "Ramphastos ambiguus",
      "Cebus aequatorialis",
    ]);
  });

  it("drops a header row", () => {
    for (const header of ["Species", "especie", "scientific_name", "Nombre científico"]) {
      const { names } = parseSpeciesList(`${header}\nRamphastos ambiguus`);
      expect(names, `header "${header}" not dropped`).toEqual(["Ramphastos ambiguus"]);
    }
  });

  it("does not drop a first row that is a real species name", () => {
    const { names } = parseSpeciesList("Ramphastos ambiguus\nCebus aequatorialis");
    expect(names).toHaveLength(2);
    expect(names[0]).toBe("Ramphastos ambiguus");
  });

  it("drops purely numeric fields from a single-line paste", () => {
    // A one-row CSV like `Name,500` would otherwise import "500" as a species.
    expect(parseSpeciesList("Ramphastos ambiguus,500").names).toEqual([
      "Ramphastos ambiguus",
    ]);
  });

  it("keeps a list far longer than the old 50-row batch cap", () => {
    const many = Array.from({ length: 120 }, (_, i) => `Species ${i}`);
    const result = parseSpeciesList(many.join("\n"));
    expect(result.names).toHaveLength(120);
    expect(result.totalFound).toBe(120);
    expect(result.tooLarge).toBeNull();
  });

  it("accepts a paste exactly at the sanity ceiling", () => {
    const result = parseSpeciesList(
      Array.from({ length: MAX_PASTE_ROWS }, (_, i) => `Species ${i}`).join("\n")
    );
    expect(result.names).toHaveLength(MAX_PASTE_ROWS);
    expect(result.tooLarge).toBeNull();
  });

  it("refuses a paste past the ceiling instead of trimming it silently", () => {
    // A silent trim is the dangerous outcome: the preview would look like a
    // successful read of a list that is not the one the reader pasted.
    const result = parseSpeciesList(
      Array.from({ length: MAX_PASTE_ROWS + 500 }, (_, i) => `Species ${i}`).join("\n")
    );
    expect(result.names).toEqual([]);
    expect(result.totalFound).toBe(MAX_PASTE_ROWS + 500);
    expect(result.tooLarge).toContain(String(MAX_PASTE_ROWS + 500));
  });

  it("returns nothing for empty input", () => {
    expect(parseSpeciesList("").names).toEqual([]);
    expect(parseSpeciesList("   \n  \n").names).toEqual([]);
  });
});

describe("resolveSpeciesRows", () => {
  const catalog = [
    sp({
      scientificName: "Ramphastos ambiguus",
      commonName: "Yellow-throated Toucan",
      spanishName: "Tucán del Chocó",
      detectionCount: 500,
    }),
    sp({
      scientificName: "Megascops centralis",
      commonName: "Choco Screech Owl",
      spanishName: "Búho",
      detectionCount: 20,
      activeStatus: "reviewing",
    }),
    sp({
      scientificName: "Panthera onca",
      commonName: "Jaguar",
      spanishName: "Jaguar",
      detectionCount: 0,
    }),
  ];

  it("matches a scientific name", () => {
    const [row] = resolveSpeciesRows(["Ramphastos ambiguus"], catalog);
    expect(row.outcome).toBe("ready");
    expect(row.scientificName).toBe("Ramphastos ambiguus");
    expect(row.detectionCount).toBe(500);
  });

  it("matches an English common name", () => {
    const [row] = resolveSpeciesRows(["Yellow-throated Toucan"], catalog);
    expect(row.outcome).toBe("ready");
    expect(row.scientificName).toBe("Ramphastos ambiguus");
  });

  it("matches a Spanish common name", () => {
    const [row] = resolveSpeciesRows(["Tucán del Chocó"], catalog);
    expect(row.scientificName).toBe("Ramphastos ambiguus");
  });

  it("matches case- and diacritic-insensitively", () => {
    expect(resolveSpeciesRows(["tucan del choco"], catalog)[0].scientificName).toBe(
      "Ramphastos ambiguus"
    );
    expect(resolveSpeciesRows(["RAMPHASTOS AMBIGUUS"], catalog)[0].scientificName).toBe(
      "Ramphastos ambiguus"
    );
  });

  it("classifies an already-validated species as duplicate", () => {
    const [row] = resolveSpeciesRows(["Megascops centralis"], catalog);
    expect(row.outcome).toBe("duplicate");
    expect(row.scientificName).toBe("Megascops centralis");
  });

  it("classifies a known species with no detections", () => {
    const [row] = resolveSpeciesRows(["Panthera onca"], catalog);
    expect(row.outcome).toBe("no_detections");
  });

  it("classifies an unmatched string as unknown and keeps the original text", () => {
    const [row] = resolveSpeciesRows(["Ramphastos ambigus"], catalog);
    expect(row.outcome).toBe("unknown");
    expect(row.input).toBe("Ramphastos ambigus");
    expect(row.scientificName).toBeNull();
  });

  it("classifies the second occurrence of a name as repeated", () => {
    const rows = resolveSpeciesRows(
      ["Ramphastos ambiguus", "Ramphastos ambiguus"],
      catalog
    );
    expect(rows[0].outcome).toBe("ready");
    expect(rows[1].outcome).toBe("repeated");
  });

  it("treats a repeat through a different name for the same species as repeated", () => {
    const rows = resolveSpeciesRows(
      ["Ramphastos ambiguus", "Yellow-throated Toucan"],
      catalog
    );
    expect(rows[0].outcome).toBe("ready");
    expect(rows[1].outcome).toBe("repeated");
  });

  it("classifies an ambiguous name as unknown and names both candidates", () => {
    const ambiguous = [
      sp({ scientificName: "Aaa one", commonName: "Jaguar" }),
      sp({ scientificName: "Bbb two", commonName: "Jaguar" }),
    ];
    const [row] = resolveSpeciesRows(["Jaguar"], ambiguous);
    expect(row.outcome).toBe("unknown");
    expect(row.candidates).toEqual(["Aaa one", "Bbb two"]);
  });

  it("preserves input order so the preview lines up with the paste", () => {
    const rows = resolveSpeciesRows(
      ["Panthera onca", "Ramphastos ambiguus", "nope"],
      catalog
    );
    expect(rows.map((r) => r.input)).toEqual([
      "Panthera onca",
      "Ramphastos ambiguus",
      "nope",
    ]);
  });

  it("returns an empty array for no input", () => {
    expect(resolveSpeciesRows([], catalog)).toEqual([]);
  });
});
