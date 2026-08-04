/**
 * Filter/sort logic for the fichas de especies card list (U1, plus U4's
 * dirty-card pinning).
 *
 * Pure module, no React — the repo runs vitest in a node environment with no
 * jsdom, so this is where the interesting list behaviour actually gets covered.
 */

import { describe, it, expect } from "vitest";
import {
  matchesSearch,
  compareSpecies,
  buildVisibleList,
  buildVisibleSections,
  displayName,
  stripDiacritics,
} from "@/app/biochoco/fichas-especies/list-view";
import type { SpeciesContentRow } from "@/app/biochoco/fichas-especies/content-types";

let nextId = 1;

function makeRow(overrides: Partial<SpeciesContentRow> = {}): SpeciesContentRow {
  return {
    id: nextId++,
    scientificName: "Dasyprocta punctata",
    commonName: "Agouti",
    spanishName: "Guatusa",
    type: "mammal",
    publicContent: null,
    detectionCount: 10,
    hasContent: false,
    representativeImageId: null,
    ...overrides,
  };
}

const DEFAULTS = {
  search: "",
  scope: "all",
  sortKey: "name",
  sortDir: "asc",
} as const;

describe("stripDiacritics", () => {
  it("lowercases and removes combining marks", () => {
    expect(stripDiacritics("Guatusó")).toBe("guatuso");
    expect(stripDiacritics("ARMADILLO")).toBe("armadillo");
  });
});

describe("displayName", () => {
  it("prefers spanishName, then commonName, then scientificName", () => {
    expect(
      displayName(makeRow({ spanishName: "Guatusa", commonName: "Agouti" }))
    ).toBe("Guatusa");
    expect(
      displayName(makeRow({ spanishName: null, commonName: "Agouti" }))
    ).toBe("Agouti");
    expect(
      displayName(
        makeRow({
          spanishName: null,
          commonName: "",
          scientificName: "Dasyprocta punctata",
        })
      )
    ).toBe("Dasyprocta punctata");
  });
});

describe("matchesSearch", () => {
  const row = makeRow({
    scientificName: "Dasypus novemcinctus",
    commonName: "Nine-banded armadillo",
    spanishName: "Armadillo",
  });

  it("matches on scientific name", () => {
    expect(matchesSearch(row, "novemcinctus")).toBe(true);
  });

  it("matches on common name", () => {
    expect(matchesSearch(row, "nine-banded")).toBe(true);
  });

  it("matches on Spanish name", () => {
    expect(matchesSearch(row, "armadi")).toBe(true);
  });

  it("is diacritic-insensitive in both directions", () => {
    const accented = makeRow({
      scientificName: "Dasyprocta punctata",
      commonName: "Agouti",
      spanishName: "Guatusó",
    });
    // Unaccented query finds accented data.
    expect(matchesSearch(accented, "guatuso")).toBe(true);
    // Accented query finds unaccented data.
    const plain = makeRow({ spanishName: "guatuso" });
    expect(matchesSearch(plain, "Guatusó")).toBe(true);
  });

  it("returns true for every row on an empty or whitespace query", () => {
    expect(matchesSearch(row, "")).toBe(true);
    expect(matchesSearch(row, "   ")).toBe(true);
  });

  it("returns false when nothing matches", () => {
    expect(matchesSearch(row, "jaguar")).toBe(false);
  });
});

describe("buildVisibleList — scope", () => {
  const seen = makeRow({ spanishName: "Guatusa", detectionCount: 42 });
  const unseen = makeRow({ spanishName: "Tangara", detectionCount: 0 });
  const rows = [seen, unseen];

  it("excludes zero-detection rows under scope 'withRecords'", () => {
    const out = buildVisibleList(rows, { ...DEFAULTS, scope: "withRecords" });
    expect(out.map((r) => r.id)).toEqual([seen.id]);
  });

  it("returns every row under scope 'all'", () => {
    const out = buildVisibleList(rows, { ...DEFAULTS, scope: "all" });
    expect(out).toHaveLength(2);
  });

  it("composes search and scope — an audio-only match is dropped by scope", () => {
    const out = buildVisibleList(rows, {
      ...DEFAULTS,
      scope: "withRecords",
      search: "Tangara",
    });
    expect(out).toHaveLength(0);
  });
});

describe("compareSpecies", () => {
  it("puts the highest record count first when sorting records desc", () => {
    const few = makeRow({ spanishName: "Armadillo", detectionCount: 5 });
    const many = makeRow({ spanishName: "Guatusa", detectionCount: 500 });
    const out = buildVisibleList([few, many], {
      ...DEFAULTS,
      sortKey: "records",
      sortDir: "desc",
    });
    expect(out.map((r) => r.id)).toEqual([many.id, few.id]);
  });

  it("breaks record ties by name ASCENDING in both directions", () => {
    const b = makeRow({ spanishName: "Zorro", detectionCount: 7 });
    const a = makeRow({ spanishName: "Armadillo", detectionCount: 7 });

    for (const sortDir of ["asc", "desc"] as const) {
      const out = buildVisibleList([b, a], {
        ...DEFAULTS,
        sortKey: "records",
        sortDir,
      });
      expect(out.map((r) => r.spanishName)).toEqual(["Armadillo", "Zorro"]);
    }
  });

  it("puts species with a ficha first when sorting status asc", () => {
    const without = makeRow({ spanishName: "Armadillo", hasContent: false });
    const with_ = makeRow({ spanishName: "Zorro", hasContent: true });
    const out = buildVisibleList([without, with_], {
      ...DEFAULTS,
      sortKey: "status",
      sortDir: "asc",
    });
    expect(out.map((r) => r.id)).toEqual([with_.id, without.id]);
  });

  it("sorts by the Spanish type label, not the raw enum", () => {
    // Raw: "bird" < "mammal". Labels: "Mamífero" < "Ave" is false, so label
    // ordering must put Ave first — proving the label is what's compared.
    const mammal = makeRow({ type: "mammal", spanishName: "Guatusa" });
    const bird = makeRow({ type: "bird", spanishName: "Tangara" });
    const out = buildVisibleList([mammal, bird], {
      ...DEFAULTS,
      sortKey: "type",
      sortDir: "asc",
    });
    expect(out.map((r) => r.type)).toEqual(["bird", "mammal"]);
  });

  it("is a stable total order — equal names fall back to id", () => {
    const first = makeRow({ spanishName: "Igual", detectionCount: 1 });
    const second = makeRow({ spanishName: "Igual", detectionCount: 1 });
    expect(compareSpecies(first, second, "records", "asc")).toBeLessThan(0);
    expect(compareSpecies(second, first, "records", "asc")).toBeGreaterThan(0);
  });
});

describe("buildVisibleSections — dirty-card pinning (U4)", () => {
  const dirty = makeRow({ spanishName: "Guatusa", detectionCount: 3 });
  const other = makeRow({ spanishName: "Armadillo", detectionCount: 9 });
  const rows = [dirty, other];

  it("keeps a pinned card that fails the search", () => {
    const out = buildVisibleList(rows, {
      ...DEFAULTS,
      search: "Armadillo",
      alwaysInclude: new Set([dirty.id]),
    });
    expect(out.map((r) => r.id)).toContain(dirty.id);
  });

  it("keeps a pinned card that the scope filter would exclude", () => {
    const audioOnly = makeRow({ spanishName: "Tangara", detectionCount: 0 });
    const out = buildVisibleList([...rows, audioOnly], {
      ...DEFAULTS,
      scope: "withRecords",
      alwaysInclude: new Set([audioOnly.id]),
    });
    expect(out.map((r) => r.id)).toContain(audioOnly.id);
  });

  it("lists a pinned card that also matches exactly once", () => {
    const out = buildVisibleList(rows, {
      ...DEFAULTS,
      search: "Guatusa",
      alwaysInclude: new Set([dirty.id]),
    });
    expect(out.filter((r) => r.id === dirty.id)).toHaveLength(1);
  });

  it("treats an empty alwaysInclude the same as omitting it", () => {
    const withEmpty = buildVisibleList(rows, {
      ...DEFAULTS,
      search: "Armadillo",
      alwaysInclude: new Set<number>(),
    });
    const without = buildVisibleList(rows, { ...DEFAULTS, search: "Armadillo" });
    expect(withEmpty.map((r) => r.id)).toEqual(without.map((r) => r.id));
  });

  it("separates pinned-but-non-matching rows so they render after (and outside the chunk cap)", () => {
    const { matching, pinned } = buildVisibleSections(rows, {
      ...DEFAULTS,
      search: "Armadillo",
      alwaysInclude: new Set([dirty.id]),
    });
    expect(matching.map((r) => r.id)).toEqual([other.id]);
    expect(pinned.map((r) => r.id)).toEqual([dirty.id]);
  });
});
