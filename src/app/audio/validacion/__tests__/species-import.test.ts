import { describe, it, expect } from "vitest";

import {
  parseSpeciesGrid,
  parseSpeciesList,
  resolveSpeciesRows,
  MAX_PASTE_ROWS,
  type ParsedSpeciesRow,
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

/** Names only, for the many cases that predate the notes column. */
const namesOf = (text: string) => parseSpeciesList(text).rows.map((r) => r.name);

/** A plain name list as `resolveSpeciesRows` now takes it. */
const asRows = (names: string[]): ParsedSpeciesRow[] =>
  names.map((name) => ({ name, notes: null }));

describe("parseSpeciesList", () => {
  it("splits a newline-separated list", () => {
    expect(namesOf("Ramphastos ambiguus\nCebus aequatorialis")).toEqual([
      "Ramphastos ambiguus",
      "Cebus aequatorialis",
    ]);
  });

  it("splits a single line on commas", () => {
    expect(namesOf("Ramphastos ambiguus, Cebus aequatorialis")).toEqual([
      "Ramphastos ambiguus",
      "Cebus aequatorialis",
    ]);
  });

  it("splits a single line on tabs", () => {
    expect(namesOf("Ramphastos ambiguus\tCebus aequatorialis")).toEqual([
      "Ramphastos ambiguus",
      "Cebus aequatorialis",
    ]);
  });

  it("takes the first column of a copied spreadsheet block", () => {
    // Excel puts a tab between columns and CRLF between rows. Only the first
    // column can be a species name; the rest is whatever else was selected.
    const pasted = "Ramphastos ambiguus\t500\r\nCebus aequatorialis\t900\r\n";
    expect(namesOf(pasted)).toEqual(["Ramphastos ambiguus", "Cebus aequatorialis"]);
  });

  it("takes the first column of a multi-row CSV", () => {
    const csv = "Ramphastos ambiguus,500\nCebus aequatorialis,900";
    expect(namesOf(csv)).toEqual(["Ramphastos ambiguus", "Cebus aequatorialis"]);
  });

  it("strips surrounding quotes", () => {
    expect(namesOf('"Ramphastos ambiguus"\n"Cebus aequatorialis"')).toEqual([
      "Ramphastos ambiguus",
      "Cebus aequatorialis",
    ]);
  });

  it("drops blank and whitespace-only lines", () => {
    expect(namesOf("Ramphastos ambiguus\n\n   \n\nCebus aequatorialis\n")).toEqual([
      "Ramphastos ambiguus",
      "Cebus aequatorialis",
    ]);
  });

  it("trims stray whitespace around each name", () => {
    expect(namesOf("  Ramphastos ambiguus  \n\tCebus aequatorialis ")).toEqual([
      "Ramphastos ambiguus",
      "Cebus aequatorialis",
    ]);
  });

  it("drops a header row", () => {
    for (const header of ["Species", "especie", "scientific_name", "Nombre científico"]) {
      expect(
        namesOf(`${header}\nRamphastos ambiguus`),
        `header "${header}" not dropped`
      ).toEqual(["Ramphastos ambiguus"]);
    }
  });

  it("does not drop a first row that is a real species name", () => {
    const names = namesOf("Ramphastos ambiguus\nCebus aequatorialis");
    expect(names).toHaveLength(2);
    expect(names[0]).toBe("Ramphastos ambiguus");
  });

  it("drops purely numeric fields from a single-line paste", () => {
    // A one-row CSV like `Name,500` would otherwise import "500" as a species.
    expect(namesOf("Ramphastos ambiguus,500")).toEqual(["Ramphastos ambiguus"]);
  });

  it("keeps a list far longer than the old 50-row batch cap", () => {
    const many = Array.from({ length: 120 }, (_, i) => `Species ${i}`);
    const result = parseSpeciesList(many.join("\n"));
    expect(result.rows).toHaveLength(120);
    expect(result.totalFound).toBe(120);
    expect(result.tooLarge).toBeNull();
  });

  it("accepts a paste exactly at the sanity ceiling", () => {
    const result = parseSpeciesList(
      Array.from({ length: MAX_PASTE_ROWS }, (_, i) => `Species ${i}`).join("\n")
    );
    expect(result.rows).toHaveLength(MAX_PASTE_ROWS);
    expect(result.tooLarge).toBeNull();
  });

  it("refuses a paste past the ceiling instead of trimming it silently", () => {
    // A silent trim is the dangerous outcome: the preview would look like a
    // successful read of a list that is not the one the reader pasted.
    const result = parseSpeciesList(
      Array.from({ length: MAX_PASTE_ROWS + 500 }, (_, i) => `Species ${i}`).join("\n")
    );
    expect(result.rows).toEqual([]);
    expect(result.totalFound).toBe(MAX_PASTE_ROWS + 500);
    expect(result.tooLarge).toContain(String(MAX_PASTE_ROWS + 500));
  });

  it("returns nothing for empty input", () => {
    expect(namesOf("")).toEqual([]);
    expect(namesOf("   \n  \n")).toEqual([]);
  });
});

describe("parseSpeciesList notes", () => {
  it("reads notes from a two-column paste with no header", () => {
    const result = parseSpeciesList(
      "Ramphastos ambiguus\tFuera de rango. REVISAR\nCebus aequatorialis\tOK"
    );
    expect(result.notesColumn).toBe(1);
    expect(result.rows).toEqual([
      { name: "Ramphastos ambiguus", notes: "Fuera de rango. REVISAR" },
      { name: "Cebus aequatorialis", notes: "OK" },
    ]);
  });

  it("does not mistake a trailing count column for notes", () => {
    // The pre-notes behaviour that must survive: two columns of `name<TAB>500`
    // is the commonest paste there is, and its second column is a count.
    const result = parseSpeciesList("Ramphastos ambiguus\t500\nCebus aequatorialis\t900");
    expect(result.rows.map((r) => r.notes)).toEqual([null, null]);
  });

  it("reads notes from the column headed Notes, wherever it sits", () => {
    // The real sheet: Species | Common Name | Detections | Sites | Notes.
    const pasted = [
      "Species\tCommon Name\tDetections\tSites\tNotes",
      "Ampelioides tschudii\tScaled Fruiteater\t3\t2\tNot on JF list. CHECK",
      "Amazona farinosa\tMealy Parrot\t162\t26\t",
    ].join("\n");

    const result = parseSpeciesList(pasted);
    expect(result.notesColumn).toBe(4);
    expect(result.rows).toEqual([
      { name: "Ampelioides tschudii", notes: "Not on JF list. CHECK" },
      { name: "Amazona farinosa", notes: null },
    ]);
  });

  it("recognises Spanish notes headers", () => {
    for (const header of ["Notas", "notas", "Observaciones", "Comentarios"]) {
      const result = parseSpeciesList(`Especie\t${header}\nRamphastos ambiguus\tdudosa`);
      expect(result.notesColumn, `header "${header}" not found`).toBe(1);
      expect(result.rows[0].notes).toBe("dudosa");
    }
  });

  it("treats a row carrying a notes header as a header even with an odd first cell", () => {
    // Sheets label their first column all sorts of ways; "Ave" is not in
    // HEADER_PATTERN, but a cell reading "Notas" settles it.
    const result = parseSpeciesList("Ave\tNotas\nRamphastos ambiguus\tdudosa");
    expect(result.rows).toEqual([{ name: "Ramphastos ambiguus", notes: "dudosa" }]);
  });

  it("keeps a comma inside a tab-separated note", () => {
    // Splitting on every delimiter at once cut this at "list,".
    const result = parseSpeciesList(
      "Species\tNotes\nAramides cajaneus\tNot on JF list, could be confused with wolfi"
    );
    expect(result.rows[0].notes).toBe("Not on JF list, could be confused with wolfi");
  });

  it("reads no notes from a wide sheet with no notes header", () => {
    // Refuses to guess: column 2 here is the common name, column 3 a count.
    const result = parseSpeciesList(
      "Ramphastos ambiguus\tBlack-mandibled Toucan\t45721\nRamphastos brevis\tChoco toucan\t7971"
    );
    expect(result.notesColumn).toBeNull();
    expect(result.rows.map((r) => r.notes)).toEqual([null, null]);
  });

  it("reads no notes from a single pasted line", () => {
    const result = parseSpeciesList("Ramphastos ambiguus, Cebus aequatorialis");
    expect(result.notesColumn).toBeNull();
    expect(result.rows.map((r) => r.notes)).toEqual([null, null]);
  });
});

describe("parseSpeciesGrid", () => {
  it("keeps a comma inside a spreadsheet cell", () => {
    // The .xlsx path's whole reason for taking cells instead of text.
    const result = parseSpeciesGrid([
      ["Species", "Notes"],
      ["Aramides cajaneus", "Not on JF list, could be confused with wolfi"],
    ]);
    expect(result.rows[0].notes).toBe("Not on JF list, could be confused with wolfi");
  });

  it("ignores every column but the species and the notes", () => {
    const result = parseSpeciesGrid([
      ["Species", "Common Name", "Detections", "Sites", "Notes"],
      [
        "Andigena laminirostris",
        "Plate-billed Mountain-toucan",
        "1",
        "1",
        "Very rare. CHECK",
      ],
    ]);
    expect(result.rows).toEqual([
      { name: "Andigena laminirostris", notes: "Very rare. CHECK" },
    ]);
  });

  it("drops rows with no species name and keeps the rest", () => {
    // Spreadsheets carry stray rows — a note with no species is not a species.
    const result = parseSpeciesGrid([
      ["Species", "Notes"],
      ["Ramphastos ambiguus", "ok"],
      ["", "orphan note"],
      ["Ramphastos brevis", ""],
    ]);
    expect(result.rows).toEqual([
      { name: "Ramphastos ambiguus", notes: "ok" },
      { name: "Ramphastos brevis", notes: null },
    ]);
  });

  it("treats a single-row grid as one record, not a list of names", () => {
    // Opposite of a one-line paste: a sheet's columns are columns even when
    // there is only one data row.
    const result = parseSpeciesGrid([["Ramphastos ambiguus", "dudosa"]]);
    expect(result.rows).toEqual([{ name: "Ramphastos ambiguus", notes: "dudosa" }]);
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
    const [row] = resolveSpeciesRows(asRows(["Ramphastos ambiguus"]), catalog);
    expect(row.outcome).toBe("ready");
    expect(row.scientificName).toBe("Ramphastos ambiguus");
    expect(row.detectionCount).toBe(500);
  });

  it("matches an English common name", () => {
    const [row] = resolveSpeciesRows(asRows(["Yellow-throated Toucan"]), catalog);
    expect(row.outcome).toBe("ready");
    expect(row.scientificName).toBe("Ramphastos ambiguus");
  });

  it("matches a Spanish common name", () => {
    const [row] = resolveSpeciesRows(asRows(["Tucán del Chocó"]), catalog);
    expect(row.scientificName).toBe("Ramphastos ambiguus");
  });

  it("matches case- and diacritic-insensitively", () => {
    expect(
      resolveSpeciesRows(asRows(["tucan del choco"]), catalog)[0].scientificName
    ).toBe("Ramphastos ambiguus");
    expect(
      resolveSpeciesRows(asRows(["RAMPHASTOS AMBIGUUS"]), catalog)[0].scientificName
    ).toBe("Ramphastos ambiguus");
  });

  it("classifies an already-validated species as duplicate", () => {
    const [row] = resolveSpeciesRows(asRows(["Megascops centralis"]), catalog);
    expect(row.outcome).toBe("duplicate");
    expect(row.scientificName).toBe("Megascops centralis");
  });

  it("classifies a known species with no detections", () => {
    const [row] = resolveSpeciesRows(asRows(["Panthera onca"]), catalog);
    expect(row.outcome).toBe("no_detections");
  });

  it("classifies an unmatched string as unknown and keeps the original text", () => {
    const [row] = resolveSpeciesRows(asRows(["Ramphastos ambigus"]), catalog);
    expect(row.outcome).toBe("unknown");
    expect(row.input).toBe("Ramphastos ambigus");
    expect(row.scientificName).toBeNull();
  });

  it("classifies the second occurrence of a name as repeated", () => {
    const rows = resolveSpeciesRows(
      asRows(["Ramphastos ambiguus", "Ramphastos ambiguus"]),
      catalog
    );
    expect(rows[0].outcome).toBe("ready");
    expect(rows[1].outcome).toBe("repeated");
  });

  it("treats a repeat through a different name for the same species as repeated", () => {
    const rows = resolveSpeciesRows(
      asRows(["Ramphastos ambiguus", "Yellow-throated Toucan"]),
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
    const [row] = resolveSpeciesRows(asRows(["Jaguar"]), ambiguous);
    expect(row.outcome).toBe("unknown");
    expect(row.candidates).toEqual(["Aaa one", "Bbb two"]);
  });

  it("preserves input order so the preview lines up with the paste", () => {
    const rows = resolveSpeciesRows(
      asRows(["Panthera onca", "Ramphastos ambiguus", "nope"]),
      catalog
    );
    expect(rows.map((r) => r.input)).toEqual([
      "Panthera onca",
      "Ramphastos ambiguus",
      "nope",
    ]);
  });

  it("carries each row's note through to its resolved row", () => {
    const rows = resolveSpeciesRows(
      [
        { name: "Ramphastos ambiguus", notes: "Fuera de rango. REVISAR" },
        { name: "Panthera onca", notes: "sin detecciones esperadas" },
      ],
      catalog
    );
    expect(rows.map((r) => r.notes)).toEqual([
      "Fuera de rango. REVISAR",
      "sin detecciones esperadas",
    ]);
  });

  it("keeps the note on a row that did not resolve, so it is not lost on retry", () => {
    // The reader fixes the misspelling and re-imports; the note they wrote
    // against that line has to still be there.
    const [row] = resolveSpeciesRows(
      [{ name: "Ramphastos ambigus", notes: "typo aquí" }],
      catalog
    );
    expect(row.outcome).toBe("unknown");
    expect(row.notes).toBe("typo aquí");
  });

  it("returns an empty array for no input", () => {
    expect(resolveSpeciesRows([], catalog)).toEqual([]);
  });
});
