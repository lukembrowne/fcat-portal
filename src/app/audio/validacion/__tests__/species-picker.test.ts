import { describe, it, expect } from "vitest";

import { filterSpecies, normalizeForSearch } from "../species-picker";
import type { ValidatableSpecies } from "../actions";

const sp = (over: Partial<ValidatableSpecies>): ValidatableSpecies => ({
  scientificName: "Aaa aaa",
  commonName: "Aaa Bird",
  spanishName: "Pájaro Aaa",
  detectionCount: 10,
  activeStatus: null,
  ...over,
});

const names = (rows: ValidatableSpecies[]) => rows.map((r) => r.scientificName);

describe("normalizeForSearch", () => {
  it("lowercases and strips diacritics", () => {
    expect(normalizeForSearch("Búho")).toBe("buho");
    expect(normalizeForSearch("  Tucán  ")).toBe("tucan");
  });
});

describe("filterSpecies", () => {
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
    }),
    sp({
      scientificName: "Cebus aequatorialis",
      commonName: "Capuchin",
      spanishName: null,
      detectionCount: 900,
    }),
  ];

  it("matches on scientific name", () => {
    expect(names(filterSpecies(catalog, "Ramphastos"))).toEqual([
      "Ramphastos ambiguus",
    ]);
  });

  it("matches on English common name", () => {
    expect(names(filterSpecies(catalog, "Screech"))).toEqual(["Megascops centralis"]);
  });

  it("matches on Spanish common name", () => {
    expect(names(filterSpecies(catalog, "Tucán"))).toEqual(["Ramphastos ambiguus"]);
  });

  it("matches without diacritics and regardless of case", () => {
    expect(names(filterSpecies(catalog, "buho"))).toEqual(["Megascops centralis"]);
    expect(names(filterSpecies(catalog, "BUHO"))).toEqual(["Megascops centralis"]);
  });

  it("tolerates a null Spanish name without matching everything", () => {
    expect(names(filterSpecies(catalog, "capuchin"))).toEqual(["Cebus aequatorialis"]);
  });

  it("ranks prefix matches above substring matches", () => {
    const rows = [
      sp({ scientificName: "Zzz zzz", commonName: "Great Owl", detectionCount: 1 }),
      sp({ scientificName: "Owl bird", commonName: "Something", detectionCount: 1 }),
    ];
    expect(names(filterSpecies(rows, "owl"))).toEqual(["Owl bird", "Zzz zzz"]);
  });

  it("sorts more-detected species first at equal match quality", () => {
    const rows = [
      sp({ scientificName: "Aaa one", commonName: "Quail A", detectionCount: 5 }),
      sp({ scientificName: "Bbb two", commonName: "Quail B", detectionCount: 50 }),
    ];
    expect(names(filterSpecies(rows, "quail"))).toEqual(["Bbb two", "Aaa one"]);
  });

  it("breaks ties on scientific name so the list is stable between keystrokes", () => {
    const rows = [
      sp({ scientificName: "Ccc", commonName: "Quail", detectionCount: 5 }),
      sp({ scientificName: "Aaa", commonName: "Quail", detectionCount: 5 }),
      sp({ scientificName: "Bbb", commonName: "Quail", detectionCount: 5 }),
    ];
    expect(names(filterSpecies(rows, "quail"))).toEqual(["Aaa", "Bbb", "Ccc"]);
  });

  it("keeps an already-validated species in the results", () => {
    // Filtering it out reads as "not in the catalog" rather than "already
    // being worked on" — the caller renders it disabled instead.
    const rows = [
      sp({ scientificName: "Ramphastos ambiguus", activeStatus: "reviewing" }),
    ];
    const [row] = filterSpecies(rows, "Ramphastos");
    expect(row).toBeDefined();
    expect(row.activeStatus).toBe("reviewing");
  });

  it("returns the whole catalog for an empty query, most-detected first", () => {
    expect(names(filterSpecies(catalog, ""))).toEqual([
      "Cebus aequatorialis",
      "Ramphastos ambiguus",
      "Megascops centralis",
    ]);
  });

  it("treats a whitespace-only query as empty", () => {
    expect(filterSpecies(catalog, "   ")).toHaveLength(3);
  });

  it("returns nothing when no name matches", () => {
    expect(filterSpecies(catalog, "zzzzz")).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const rows = [sp({ scientificName: "Bbb" }), sp({ scientificName: "Aaa" })];
    const before = names(rows);
    filterSpecies(rows, "");
    expect(names(rows)).toEqual(before);
  });
});
