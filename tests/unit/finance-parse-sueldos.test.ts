/**
 * Parser tests for the Sueldos Excel file (src/app/finance/lib/parse-sueldos.ts).
 *
 * The workbook is built in-memory to the same shape as the real file, so the
 * cases below are the real defects: the thirteen dropped FCATeros, the pooled
 * aggregate masquerading as a person, and the two name spellings that used to
 * discard funding rows without a word.
 */

import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import {
  parseSueldosExcel,
  normalizeName,
  splitSourceName,
} from "@/app/finance/lib/parse-sueldos";

type TimelineRow = {
  person: string;
  source: string;
  "start date": string;
  "end date": string;
  amount: number;
  status: string;
  notes?: string;
};
type SalaryRow = {
  Person: string;
  "Figura en rol pagos": string;
  "COSTO AL PROYECTO ANUAL": number;
};

function build(
  timelines: TimelineRow[],
  salaries: SalaryRow[],
  salarySheetName = "2025 Sueldos"
): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(timelines), "Timelines");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(salaries), salarySheetName);
  const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
  return out as ArrayBuffer;
}

function fcatero(name: string, cost: number): SalaryRow {
  return { Person: name, "Figura en rol pagos": "FCATero", "COSTO AL PROYECTO ANUAL": cost };
}

/** The thirteen FCATeros and their aggregate, straight from the real sheet. */
const FCATERO_ROWS: SalaryRow[] = [
  fcatero("Carla Barreto", 16546.2),
  fcatero("Hugo Castro", 18865.38),
  fcatero("Diego Campos", 17570.38),
  fcatero("Damian Campos", 18865.38),
  fcatero("Alex Guerra", 15235.6),
  fcatero("Gloria Loor", 16546.2),
  fcatero("Jorge Viteri", 19452.88),
  fcatero("Cesar Molina", 16546.2),
  fcatero("Gregory Paladines", 17132.32),
  fcatero("Ramiro Nuñez", 16546.2),
  fcatero("Irene Robles", 17570.38),
  fcatero("Darwin Zambrano", 16546.2),
  fcatero("Luis Zambrano", 20810.62),
];
const FCATEROS_AGGREGATE: SalaryRow = {
  Person: "FCATeros",
  "Figura en rol pagos": "",
  "COSTO AL PROYECTO ANUAL": 228233.94,
};

describe("normalizeName", () => {
  it("matches across accents and case", () => {
    expect(normalizeName("Ramiro Nunez")).toBe(normalizeName("Ramiro Nuñez"));
    expect(normalizeName("  MELISA   LOAYZA ")).toBe("melisa loayza");
  });

  it("keeps genuinely different people apart", () => {
    const zambranos = ["Karla Zambrano", "Luis Zambrano", "Darwin Zambrano"].map(normalizeName);
    expect(new Set(zambranos).size).toBe(3);
  });

  it("does not collapse Lucia and Luzia", () => {
    expect(normalizeName("Lucia Mendez")).not.toBe(normalizeName("Luzia Mendez"));
  });
});

describe("splitSourceName", () => {
  it("strips a trailing status suffix", () => {
    expect(splitSourceName("NMBCA VII (funded)")).toEqual({
      name: "NMBCA VII",
      statusHint: "funded",
    });
  });

  it("leaves a plain name alone", () => {
    expect(splitSourceName("Wedgetail")).toEqual({ name: "Wedgetail", statusHint: null });
  });
});

describe("parseSueldosExcel — roster", () => {
  it("keeps all thirteen FCATeros as people in the group", () => {
    const buf = build([], [...FCATERO_ROWS, FCATEROS_AGGREGATE]);
    const r = parseSueldosExcel(buf);

    const fcateros = r.people.filter((p) => p.group === "FCATeros");
    expect(fcateros).toHaveLength(13);
    expect(fcateros.map((p) => p.name)).toContain("Gregory Paladines");
  });

  it("treats the aggregate row as the group, not a 22nd person", () => {
    const buf = build([], [...FCATERO_ROWS, FCATEROS_AGGREGATE]);
    const r = parseSueldosExcel(buf);

    expect(r.people.some((p) => p.name === "FCATeros")).toBe(false);
    // The members sum to the aggregate; it is not added on top of them.
    const sum = r.people.reduce((s, p) => s + p.annualCost, 0);
    expect(sum).toBeCloseTo(228233.94, 2);
  });

  it("warns but still imports when the aggregate disagrees with its members", () => {
    const buf = build([], [
      ...FCATERO_ROWS,
      { ...FCATEROS_AGGREGATE, "COSTO AL PROYECTO ANUAL": 120000 },
    ]);
    const r = parseSueldosExcel(buf);

    expect(r.people).toHaveLength(13);
    expect(r.errors).toHaveLength(0);
    expect(r.warnings.join(" ")).toMatch(/no coincide/);
  });

  it("leaves individually-named staff ungrouped", () => {
    const buf = build([], [
      {
        Person: "Luis Carrasco",
        "Figura en rol pagos": "Director reserva",
        "COSTO AL PROYECTO ANUAL": 66569.82,
      },
      ...FCATERO_ROWS,
      FCATEROS_AGGREGATE,
    ]);
    const r = parseSueldosExcel(buf);

    expect(r.people.find((p) => p.name === "Luis Carrasco")?.group).toBeNull();
  });

  it("reads the year from the salary sheet name", () => {
    expect(parseSueldosExcel(build([], FCATERO_ROWS, "2025 Sueldos")).detectedYear).toBe(2025);
    expect(parseSueldosExcel(build([], FCATERO_ROWS, "Sueldos")).detectedYear).toBeNull();
  });
});

describe("parseSueldosExcel — sources and lines", () => {
  const TIMELINES: TimelineRow[] = [
    {
      person: "Pedro Almeida",
      source: "GIZ (funded)",
      "start date": "11/1/24",
      "end date": "10/30/25",
      amount: 9042,
      status: "funded",
    },
    {
      person: "Luis Carrasco",
      source: "GIZ (funded)",
      "start date": "11/1/24",
      "end date": "6/30/26",
      amount: 19526.4,
      status: "funded",
    },
    {
      person: "FCATeros Ext.",
      source: "GIZ (funded)",
      "start date": "1/1/25",
      "end date": "1/30/26",
      amount: 44800,
      status: "funded",
      notes: "extensionists",
    },
  ];

  const SALARIES: SalaryRow[] = [
    {
      Person: "Pedro Almeida",
      "Figura en rol pagos": "Administrador restauracion",
      "COSTO AL PROYECTO ANUAL": 35972.5,
    },
    {
      Person: "Luis Carrasco",
      "Figura en rol pagos": "Director reserva",
      "COSTO AL PROYECTO ANUAL": 66569.82,
    },
  ];

  it("collapses repeated source names into one source", () => {
    const r = parseSueldosExcel(build(TIMELINES, SALARIES));
    expect(r.sources).toHaveLength(1);
    expect(r.sources[0].name).toBe("GIZ");
    expect(r.allocations).toHaveLength(3);
  });

  it("takes status off the name and out of the stored identifier", () => {
    const r = parseSueldosExcel(build(TIMELINES, SALARIES));
    expect(r.sources[0].name).not.toContain("funded");
    expect(r.sources[0].status).toBe("funded");
  });

  it("derives the default period as the widest span across its lines", () => {
    const r = parseSueldosExcel(build(TIMELINES, SALARIES));
    expect(r.sources[0].defaultStartDate).toBe("2024-11-01");
    expect(r.sources[0].defaultEndDate).toBe("2026-06-30");
  });

  it("keeps each line's own dates, which differ within one source", () => {
    const r = parseSueldosExcel(build(TIMELINES, SALARIES));
    const ends = new Set(r.allocations.map((a) => a.endDate));
    expect(ends.size).toBe(3);
  });

  it("marks a source with no funded status as pending", () => {
    const r = parseSueldosExcel(
      build(
        [{ ...TIMELINES[0], source: "NMBCA VIII", status: "pending" }],
        SALARIES
      )
    );
    expect(r.sources[0].status).toBe("pending");
  });

  it("treats 'paused' as funded — the money exists, the work is on hold", () => {
    const r = parseSueldosExcel(
      build([{ ...TIMELINES[0], source: "ICFC 2025", status: "paused" }], SALARIES)
    );
    expect(r.sources[0].status).toBe("funded");
  });

  it("skips a line whose end precedes its start, with a warning", () => {
    const r = parseSueldosExcel(
      build(
        [{ ...TIMELINES[0], "start date": "8/1/26", "end date": "3/1/26" }],
        SALARIES
      )
    );
    expect(r.allocations).toHaveLength(0);
    expect(r.warnings.join(" ")).toMatch(/precede/);
  });

  it("skips a line with an unreadable date, with a warning", () => {
    const r = parseSueldosExcel(
      build([{ ...TIMELINES[0], "end date": "no es fecha" }], SALARIES)
    );
    expect(r.allocations).toHaveLength(0);
    expect(r.warnings.join(" ")).toMatch(/fechas inválidas/);
  });

  it("carries the notes column through", () => {
    const r = parseSueldosExcel(build(TIMELINES, SALARIES));
    const ext = r.allocations.find((a) => a.rawTarget === "FCATeros Ext.");
    expect(ext?.notes).toBe("extensionists");
  });

  it("errors on a single-sheet workbook without writing anything", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(TIMELINES), "Timelines");
    const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;

    const r = parseSueldosExcel(buf);
    expect(r.errors).toHaveLength(1);
    expect(r.people).toHaveLength(0);
    expect(r.allocations).toHaveLength(0);
  });
});
