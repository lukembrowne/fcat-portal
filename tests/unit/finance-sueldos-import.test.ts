/**
 * Import tests for the Sueldos preview/commit actions
 * (src/app/finance/data/actions.ts), against a real in-memory SQLite DB.
 *
 * The behaviors that matter: the import UPSERTS (a second run changes nothing,
 * and hand-entered rows absent from the file survive), a name it cannot match
 * BLOCKS the commit instead of silently dropping the funding, and the salary
 * overwrite it can perform is listed in the preview first.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as XLSX from "xlsx";
import * as schema from "@/db/schema";

vi.mock("server-only", () => ({}));

const recordEventMock = vi.fn(async () => undefined);
vi.mock("@/lib/system-events", () => ({
  recordEvent: (...args: unknown[]) => recordEventMock(...args),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const mockRequirePermission = vi.fn(async () => undefined);
vi.mock("@/lib/auth", () => ({
  requirePermission: (...args: unknown[]) => mockRequirePermission(...args),
  getCurrentUser: async () => ({ email: "admin@fcat-ecuador.org" }),
}));

const testDbRef: { current: ReturnType<typeof drizzle> | null } = { current: null };
vi.mock("@/db", () => ({
  db: new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return undefined;
        const real = testDbRef.current as unknown as Record<string | symbol, unknown>;
        if (!real) throw new Error("test db not initialized");
        const val = real[prop];
        return typeof val === "function" ? (val as Function).bind(real) : val;
      },
    }
  ),
}));

const DDL = `
  CREATE TABLE finance_people_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE finance_people (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, role TEXT,
    group_id INTEGER REFERENCES finance_people_groups(id) ON DELETE SET NULL,
    active INTEGER NOT NULL DEFAULT 1, notes TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE finance_salaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id INTEGER NOT NULL REFERENCES finance_people(id) ON DELETE CASCADE,
    year INTEGER NOT NULL, annual_cost REAL NOT NULL, notes TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE UNIQUE INDEX idx_fs_person_year ON finance_salaries(person_id, year);
  CREATE TABLE finance_funding_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('funded','pending')),
    default_start_date TEXT, default_end_date TEXT, notes TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE finance_salary_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL REFERENCES finance_funding_sources(id) ON DELETE CASCADE,
    person_id INTEGER REFERENCES finance_people(id) ON DELETE CASCADE,
    group_id INTEGER REFERENCES finance_people_groups(id) ON DELETE CASCADE,
    amount REAL NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL, notes TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    CHECK ((person_id IS NULL) <> (group_id IS NULL))
  );
  CREATE TABLE finance_uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_type TEXT NOT NULL CHECK(file_type IN ('libro_mayor','budget','category_map','sueldos')),
    file_name TEXT NOT NULL, row_count INTEGER, uploaded_by TEXT NOT NULL,
    uploaded_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`;

let raw: Database.Database;

beforeEach(() => {
  vi.clearAllMocks();
  mockRequirePermission.mockImplementation(async () => undefined);

  raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  raw.exec(DDL);
  raw.prepare("INSERT INTO finance_people_groups (name, sort_order) VALUES (?,?)").run("FCATeros", 1);
  raw
    .prepare("INSERT INTO finance_people_groups (name, sort_order) VALUES (?,?)")
    .run("FCATeros Ext.", 2);

  testDbRef.current = drizzle(raw, { schema });
});

async function actions() {
  return await import("@/app/finance/data/actions");
}

function count(table: string): number {
  return (raw.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
}

// --- workbook fixture -------------------------------------------------------

const TIMELINES = [
  {
    person: "Pedro Almeida",
    source: "GIZ (funded)",
    "start date": "11/1/24",
    "end date": "10/30/25",
    amount: 9042,
    status: "funded",
  },
  {
    person: "FCATeros",
    source: "NMBCA VII (funded)",
    "start date": "7/1/24",
    "end date": "6/30/26",
    amount: 8000,
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
  {
    // Sheet-2 spelling is "Ramiro Nuñez" — must resolve without help.
    person: "Ramiro Nunez",
    source: "Franklinia II (funded)",
    "start date": "9/1/25",
    "end date": "8/1/28",
    amount: 13000,
    status: "funded",
  },
  {
    // Sheet-2 spelling is "Lucia Mendez" — must NOT auto-resolve.
    person: "Luzia Mendez",
    source: "Franklinia II (funded)",
    "start date": "9/1/25",
    "end date": "8/1/28",
    amount: 10080,
    status: "funded",
  },
];

const SALARIES = [
  {
    Person: "Pedro Almeida",
    "Figura en rol pagos": "Administrador restauracion",
    "COSTO AL PROYECTO ANUAL": 35972.50,
  },
  {
    Person: "Lucia Mendez",
    "Figura en rol pagos": "Coordinador de programas",
    "COSTO AL PROYECTO ANUAL": 35397.08,
  },
  { Person: "Ramiro Nuñez", "Figura en rol pagos": "FCATero", "COSTO AL PROYECTO ANUAL": 16546.2 },
  { Person: "Esteban Palma", "Figura en rol pagos": "FCATero", "COSTO AL PROYECTO ANUAL": 17132.32 },
  { Person: "FCATeros", "Figura en rol pagos": "", "COSTO AL PROYECTO ANUAL": 33678.52 },
];

function workbook(timelines = TIMELINES, salaries = SALARIES, sheet = "2025 Sueldos"): File {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(timelines), "Timelines");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(salaries), sheet);
  const buf = XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  return new File([buf], "Sueldos 2026_07_31.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

function fd(file: File, extra: Record<string, string> = {}): FormData {
  const f = new FormData();
  f.set("file", file);
  for (const [k, v] of Object.entries(extra)) f.set(k, v);
  return f;
}

// ---------------------------------------------------------------------------

describe("previewSueldosImport", () => {
  it("reports what will be created before anything is written", async () => {
    const { previewSueldosImport } = await actions();
    const res = await previewSueldosImport(fd(workbook()));

    expect(res.success).toBe(true);
    if (!res.success) return;

    expect(res.data.requestedYear).toBe(2025);
    expect(res.data.newPeople).toHaveLength(4); // the aggregate is not a person
    expect(res.data.newSources.map((s) => s.name).sort()).toEqual([
      "Franklinia II",
      "GIZ",
      "NMBCA VII",
    ]);
    expect(res.data.allocationCount).toBe(5);
    expect(count("finance_people")).toBe(0);
  });

  it("auto-resolves the accent difference and flags only the real mismatch", async () => {
    const { previewSueldosImport } = await actions();
    const res = await previewSueldosImport(fd(workbook()));
    if (!res.success) throw new Error("expected success");

    const unresolved = res.data.unresolvedTargets.map((t) => t.rawTarget);
    expect(unresolved).toEqual(["Luzia Mendez"]);
  });

  it("offers Lucia as a suggestion for Luzia", async () => {
    const { previewSueldosImport } = await actions();
    const res = await previewSueldosImport(fd(workbook()));
    if (!res.success) throw new Error("expected success");

    expect(res.data.unresolvedTargets[0].suggestions).toContain("Lucia Mendez");
  });

  it("takes the year from the sheet name and lets the form override it", async () => {
    const { previewSueldosImport } = await actions();

    const auto = await previewSueldosImport(fd(workbook()));
    if (!auto.success) throw new Error("expected success");
    expect(auto.data.requestedYear).toBe(2025);
    expect(auto.data.detectedYear).toBe(2025);

    const override = await previewSueldosImport(fd(workbook(), { year: "2026" }));
    if (!override.success) throw new Error("expected success");
    expect(override.data.requestedYear).toBe(2026);
  });

  it("rejects a finance non-admin", async () => {
    const { previewSueldosImport } = await actions();
    mockRequirePermission.mockImplementation(async () => {
      throw new Error("NEXT_REDIRECT");
    });
    await expect(previewSueldosImport(fd(workbook()))).rejects.toThrow();
  });
});

describe("commitSueldosImport", () => {
  const RESOLVE = { resolutions: JSON.stringify({ "Luzia Mendez": "person:Lucia Mendez" }) };

  it("refuses while a name is unresolved, and writes nothing", async () => {
    const { commitSueldosImport } = await actions();
    const res = await commitSueldosImport(fd(workbook()));

    expect(res.success).toBe(false);
    if (!res.success) expect(res.error).toContain("Luzia Mendez");
    expect(count("finance_people")).toBe(0);
    expect(count("finance_salary_allocations")).toBe(0);
  });

  it("imports everything once the name is mapped", async () => {
    const { commitSueldosImport } = await actions();
    const res = await commitSueldosImport(fd(workbook(), RESOLVE));

    expect(res.success).toBe(true);
    expect(count("finance_people")).toBe(4);
    expect(count("finance_salaries")).toBe(4);
    expect(count("finance_funding_sources")).toBe(3);
    expect(count("finance_salary_allocations")).toBe(5);
  });

  it("routes the mapped line to the right person", async () => {
    const { commitSueldosImport } = await actions();
    await commitSueldosImport(fd(workbook(), RESOLVE));

    const row = raw
      .prepare(
        `SELECT a.amount FROM finance_salary_allocations a
         JOIN finance_people p ON p.id = a.person_id
         WHERE p.name = 'Lucia Mendez'`
      )
      .get() as { amount: number } | undefined;
    expect(row?.amount).toBeCloseTo(10080, 2);
  });

  it("resolves the accent mismatch without a mapping", async () => {
    const { commitSueldosImport } = await actions();
    await commitSueldosImport(fd(workbook(), RESOLVE));

    const row = raw
      .prepare(
        `SELECT a.amount FROM finance_salary_allocations a
         JOIN finance_people p ON p.id = a.person_id
         WHERE p.name = 'Ramiro Nuñez'`
      )
      .get() as { amount: number } | undefined;
    expect(row?.amount).toBeCloseTo(13000, 2);
  });

  it("sends group-named lines to groups, not to people", async () => {
    const { commitSueldosImport } = await actions();
    await commitSueldosImport(fd(workbook(), RESOLVE));

    expect(raw.prepare("SELECT COUNT(*) c FROM finance_people WHERE name LIKE 'FCATeros%'").get())
      .toEqual({ c: 0 });

    const pooled = raw
      .prepare(
        `SELECT g.name, a.amount FROM finance_salary_allocations a
         JOIN finance_people_groups g ON g.id = a.group_id ORDER BY g.name`
      )
      .all() as { name: string; amount: number }[];
    expect(pooled).toHaveLength(2);
    expect(pooled.map((p) => p.name)).toEqual(["FCATeros", "FCATeros Ext."]);
  });

  it("stores source names without the status suffix", async () => {
    const { commitSueldosImport } = await actions();
    await commitSueldosImport(fd(workbook(), RESOLVE));

    const names = (
      raw.prepare("SELECT name, status FROM finance_funding_sources ORDER BY name").all() as {
        name: string;
        status: string;
      }[]
    );
    expect(names.map((n) => n.name)).toEqual(["Franklinia II", "GIZ", "NMBCA VII"]);
    expect(names.every((n) => n.status === "funded")).toBe(true);
  });

  it("collapses the two GIZ lines under one source", async () => {
    const { commitSueldosImport } = await actions();
    await commitSueldosImport(fd(workbook(), RESOLVE));

    const giz = raw
      .prepare(
        `SELECT COUNT(*) c FROM finance_salary_allocations a
         JOIN finance_funding_sources s ON s.id = a.source_id WHERE s.name = 'GIZ'`
      )
      .get() as { c: number };
    expect(giz.c).toBe(2);
  });

  it("changes nothing when run a second time with the same file", async () => {
    const { commitSueldosImport } = await actions();
    await commitSueldosImport(fd(workbook(), RESOLVE));

    const before = {
      people: count("finance_people"),
      salaries: count("finance_salaries"),
      sources: count("finance_funding_sources"),
      allocations: count("finance_salary_allocations"),
    };

    await commitSueldosImport(fd(workbook(), RESOLVE));

    expect({
      people: count("finance_people"),
      salaries: count("finance_salaries"),
      sources: count("finance_funding_sources"),
      allocations: count("finance_salary_allocations"),
    }).toEqual(before);
  });

  it("leaves hand-entered rows absent from the file untouched", async () => {
    const { commitSueldosImport } = await actions();
    await commitSueldosImport(fd(workbook(), RESOLVE));

    raw.prepare("INSERT INTO finance_people (name, role) VALUES (?,?)").run("Nueva Persona", "FCATera");
    raw
      .prepare("INSERT INTO finance_funding_sources (name, status) VALUES (?,?)")
      .run("Fuente a mano", "pending");

    await commitSueldosImport(fd(workbook(), RESOLVE));

    expect(
      raw.prepare("SELECT COUNT(*) c FROM finance_people WHERE name = 'Nueva Persona'").get()
    ).toEqual({ c: 1 });
    expect(
      raw.prepare("SELECT COUNT(*) c FROM finance_funding_sources WHERE name = 'Fuente a mano'").get()
    ).toEqual({ c: 1 });
  });

  it("lists a hand-edited salary as a change before overwriting it", async () => {
    const { commitSueldosImport, previewSueldosImport } = await actions();
    await commitSueldosImport(fd(workbook(), RESOLVE));

    raw
      .prepare(
        `UPDATE finance_salaries SET annual_cost = 99999
         WHERE person_id = (SELECT id FROM finance_people WHERE name = 'Pedro Almeida')
           AND year = 2025`
      )
      .run();

    const pre = await previewSueldosImport(fd(workbook()));
    if (!pre.success) throw new Error("expected success");
    const change = pre.data.salaryChanges.find((c) => c.name === "Pedro Almeida");
    expect(change).toBeDefined();
    expect(change?.from).toBeCloseTo(99999, 2);
    expect(change?.to).toBeCloseTo(35972.50, 2);

    await commitSueldosImport(fd(workbook(), RESOLVE));
    const after = raw
      .prepare(
        `SELECT annual_cost FROM finance_salaries
         WHERE person_id = (SELECT id FROM finance_people WHERE name = 'Pedro Almeida') AND year = 2025`
      )
      .get() as { annual_cost: number };
    expect(after.annual_cost).toBeCloseTo(35972.50, 2);
  });

  it("adds a second year without disturbing the first", async () => {
    const { commitSueldosImport } = await actions();
    await commitSueldosImport(fd(workbook(), RESOLVE));

    const raised = SALARIES.map((s) =>
      s.Person === "Pedro Almeida"
        ? { ...s, "COSTO AL PROYECTO ANUAL": 19000 }
        : s
    );
    await commitSueldosImport(
      fd(workbook(TIMELINES, raised, "2026 Sueldos"), { ...RESOLVE, year: "2026" })
    );

    const rows = raw
      .prepare(
        `SELECT year, annual_cost FROM finance_salaries
         WHERE person_id = (SELECT id FROM finance_people WHERE name = 'Pedro Almeida')
         ORDER BY year`
      )
      .all() as { year: number; annual_cost: number }[];

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ year: 2025, annual_cost: 35972.50 });
    expect(rows[1].annual_cost).toBeCloseTo(19000, 2);
  });

  it("records the upload so the card's \"último archivo\" line still renders", async () => {
    const { commitSueldosImport } = await actions();
    await commitSueldosImport(fd(workbook(), RESOLVE));

    const row = raw.prepare("SELECT file_type, file_name FROM finance_uploads").get() as {
      file_type: string;
      file_name: string;
    };
    expect(row.file_type).toBe("sueldos");
    expect(row.file_name).toContain("Sueldos");
  });

  it("records one import event", async () => {
    const { commitSueldosImport } = await actions();
    await commitSueldosImport(fd(workbook(), RESOLVE));

    expect(recordEventMock).toHaveBeenCalledTimes(1);
    const input = recordEventMock.mock.calls[0][0] as { eventType: string };
    expect(input.eventType).toBe("finance_sueldos_import");
  });

  it("writes nothing when the workbook is unusable", async () => {
    const { commitSueldosImport } = await actions();
    const bad = new File([new Uint8Array([1, 2, 3])], "roto.xlsx");
    const res = await commitSueldosImport(fd(bad));

    expect(res.success).toBe(false);
    expect(count("finance_people")).toBe(0);
  });
});
