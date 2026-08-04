/**
 * Functional tests for the salary-planning actions
 * (src/app/finance/sueldos/actions.ts), backed by a real in-memory SQLite DB
 * using the Proxy-delegation pattern from finance-category-link-actions.test.ts.
 *
 * The DDL below carries the REAL foreign keys and CHECK constraints from
 * scripts/push-schema.mjs, and the connection sets `foreign_keys = ON`. SQLite
 * defaults that pragma OFF — without it every cascade assertion here would pass
 * vacuously while proving nothing.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sql } from "drizzle-orm";
import * as schema from "@/db/schema";

vi.mock("server-only", () => ({}));

const recordEventMock = vi.fn(async () => undefined);
vi.mock("@/lib/system-events", () => ({
  recordEvent: (...args: unknown[]) => recordEventMock(...args),
}));

const revalidatePathMock = vi.fn();
vi.mock("next/cache", () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

const mockRequirePermission = vi.fn(async () => undefined);
const mockGetCurrentUser = vi.fn(async () => ({ email: "admin@fcat-ecuador.org" }));
vi.mock("@/lib/auth", () => ({
  requirePermission: (...args: unknown[]) => mockRequirePermission(...args),
  getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args),
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

/** Mirrors scripts/push-schema.mjs — FKs and CHECKs included on purpose. */
const SUELDOS_DDL = `
  CREATE TABLE finance_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL, codigo TEXT NOT NULL DEFAULT '',
    cuenta_nombre TEXT NOT NULL, asiento TEXT NOT NULL DEFAULT '',
    detalle TEXT, actor TEXT, centros_de_ingreso TEXT, c_costo TEXT,
    debe REAL NOT NULL DEFAULT 0, haber REAL NOT NULL DEFAULT 0, balance REAL,
    year INTEGER NOT NULL, month INTEGER NOT NULL, year_month TEXT NOT NULL,
    tx_type TEXT NOT NULL CHECK(tx_type IN ('revenue','expense','cash','other'))
  );
  CREATE TABLE finance_people_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE, description TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE finance_people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE, role TEXT,
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
  CREATE UNIQUE INDEX idx_finance_salaries_person_year ON finance_salaries(person_id, year);
  CREATE TABLE finance_funding_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
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
`;

let raw: Database.Database;

beforeEach(() => {
  vi.clearAllMocks();
  mockRequirePermission.mockImplementation(async () => undefined);

  raw = new Database(":memory:");
  raw.pragma("foreign_keys = ON");
  raw.exec(SUELDOS_DDL);
  raw
    .prepare("INSERT INTO finance_people_groups (name, sort_order) VALUES (?, ?)")
    .run("FCATeros", 1);
  raw
    .prepare("INSERT INTO finance_people_groups (name, sort_order) VALUES (?, ?)")
    .run("FCATeros Ext.", 2);

  testDbRef.current = drizzle(raw, { schema });
});

async function actions() {
  return await import("@/app/finance/sueldos/actions");
}

function personId(name: string): number {
  return (raw.prepare("SELECT id FROM finance_people WHERE name = ?").get(name) as { id: number })
    .id;
}
function groupId(name: string): number {
  return (
    raw.prepare("SELECT id FROM finance_people_groups WHERE name = ?").get(name) as { id: number }
  ).id;
}
function count(table: string): number {
  return (raw.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number }).c;
}

// ---------------------------------------------------------------------------

describe("createPerson", () => {
  it("creates the person and their salary for the given year", async () => {
    const { createPerson } = await actions();
    const res = await createPerson({
      name: "Luis Carrasco",
      role: "Director reserva",
      groupId: null,
      year: 2026,
      annualCost: "66569.82",
    });

    expect(res.success).toBe(true);
    expect(count("finance_people")).toBe(1);
    const row = raw.prepare("SELECT * FROM finance_salaries").get() as {
      year: number;
      annual_cost: number;
    };
    expect(row.year).toBe(2026);
    expect(row.annual_cost).toBeCloseTo(66569.82, 2);
  });

  it("accepts a formatted currency string", async () => {
    const { createPerson } = await actions();
    await createPerson({
      name: "Gregory Paladines",
      role: "FCATero",
      groupId: groupId("FCATeros"),
      year: 2026,
      annualCost: "$17,132.32",
    });
    const row = raw.prepare("SELECT annual_cost FROM finance_salaries").get() as {
      annual_cost: number;
    };
    expect(row.annual_cost).toBeCloseTo(17132.32, 2);
  });

  it("rejects an unparseable amount instead of storing zero", async () => {
    const { createPerson } = await actions();
    const res = await createPerson({
      name: "Bad Amount",
      role: null,
      groupId: null,
      year: 2026,
      annualCost: "abc",
    });
    expect(res.success).toBe(false);
    expect(count("finance_people")).toBe(0);
  });

  it("reports a duplicate name as a sentence, not a constraint error", async () => {
    const { createPerson } = await actions();
    const input = {
      name: "Karla Zambrano",
      role: null,
      groupId: null,
      year: 2026,
      annualCost: "100",
    };
    await createPerson(input);
    const res = await createPerson(input);

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error).toContain("Karla Zambrano");
      expect(res.error).not.toContain("UNIQUE");
    }
  });

  it("creates a person with no salary when the amount is left blank", async () => {
    const { createPerson } = await actions();
    const res = await createPerson({
      name: "Sin sueldo",
      role: null,
      groupId: null,
      year: 2026,
      annualCost: null,
    });
    expect(res.success).toBe(true);
    expect(count("finance_salaries")).toBe(0);
  });
});

describe("updateSalaryForYear", () => {
  beforeEach(async () => {
    const { createPerson } = await actions();
    await createPerson({
      name: "Lucia Mendez",
      role: null,
      groupId: null,
      year: 2025,
      annualCost: "35397.08",
    });
  });

  it("updates the existing row rather than inserting a duplicate", async () => {
    const { updateSalaryForYear } = await actions();
    await updateSalaryForYear(personId("Lucia Mendez"), "2025", "18000");

    expect(count("finance_salaries")).toBe(1);
    const row = raw.prepare("SELECT annual_cost FROM finance_salaries").get() as {
      annual_cost: number;
    };
    expect(row.annual_cost).toBeCloseTo(18000, 2);
  });

  it("leaves the prior year untouched when a new year is set", async () => {
    const { updateSalaryForYear } = await actions();
    await updateSalaryForYear(personId("Lucia Mendez"), "2026", "19500");

    expect(count("finance_salaries")).toBe(2);
    const y2025 = raw
      .prepare("SELECT annual_cost FROM finance_salaries WHERE year = 2025")
      .get() as { annual_cost: number };
    expect(y2025.annual_cost).toBeCloseTo(35397.08, 2);
  });

  it("clears the row when the cell is emptied", async () => {
    const { updateSalaryForYear } = await actions();
    await updateSalaryForYear(personId("Lucia Mendez"), "2025", "");
    expect(count("finance_salaries")).toBe(0);
  });

  it("rejects an out-of-range year", async () => {
    const { updateSalaryForYear } = await actions();
    const res = await updateSalaryForYear(personId("Lucia Mendez"), "1899", "100");
    expect(res.success).toBe(false);
  });

  it("rejects a negative salary", async () => {
    const { updateSalaryForYear } = await actions();
    const res = await updateSalaryForYear(personId("Lucia Mendez"), "2025", "-500");
    expect(res.success).toBe(false);
  });
});

describe("field allowlists", () => {
  beforeEach(async () => {
    const { createPerson } = await actions();
    await createPerson({ name: "Alguien", role: null, groupId: null, year: 2026, annualCost: "1" });
  });

  it("rejects a person field outside the allowlist without writing", async () => {
    const { updatePersonField } = await actions();
    const res = await updatePersonField(personId("Alguien"), "createdAt", "0");
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error).toContain("no editable");
  });

  it("rejects an empty person name", async () => {
    const { updatePersonField } = await actions();
    const res = await updatePersonField(personId("Alguien"), "name", "   ");
    expect(res.success).toBe(false);
  });

  it("rejects a source status outside the two planning values", async () => {
    const { createFundingSource, updateSourceField } = await actions();
    await createFundingSource({
      name: "GIZ",
      status: "funded",
      defaultStartDate: null,
      defaultEndDate: null,
    });
    const sid = (raw.prepare("SELECT id FROM finance_funding_sources").get() as { id: number }).id;
    const res = await updateSourceField(sid, "status", "pending_decision");
    expect(res.success).toBe(false);
  });

  it("rejects a malformed date on an allocation", async () => {
    const { createFundingSource, createAllocation, updateAllocationField } = await actions();
    await createFundingSource({
      name: "GIZ",
      status: "funded",
      defaultStartDate: "2024-11-01",
      defaultEndDate: "2026-06-30",
    });
    const sid = (raw.prepare("SELECT id FROM finance_funding_sources").get() as { id: number }).id;
    await createAllocation({
      sourceId: sid,
      target: `person:${personId("Alguien")}`,
      amount: "1000",
      startDate: null,
      endDate: null,
      notes: null,
    });
    const aid = (raw.prepare("SELECT id FROM finance_salary_allocations").get() as { id: number })
      .id;
    const res = await updateAllocationField(aid, "startDate", "2026-13-45");
    expect(res.success).toBe(false);
  });
});

describe("permissions", () => {
  it("rejects every mutation when the permission check throws", async () => {
    const { createPerson, createFundingSource, deletePerson, updatePersonField } = await actions();
    mockRequirePermission.mockImplementation(async () => {
      throw new Error("NEXT_REDIRECT");
    });

    await expect(
      createPerson({ name: "X", role: null, groupId: null, year: 2026, annualCost: "1" })
    ).rejects.toThrow();
    await expect(
      createFundingSource({ name: "Y", status: "funded", defaultStartDate: null, defaultEndDate: null })
    ).rejects.toThrow();
    await expect(deletePerson(1)).rejects.toThrow();
    await expect(updatePersonField(1, "name", "Z")).rejects.toThrow();

    expect(count("finance_people")).toBe(0);
  });

  it("asks for admin on mutations and viewer on reads", async () => {
    const { createPerson, fetchSueldosPlanning } = await actions();
    await createPerson({ name: "A", role: null, groupId: null, year: 2026, annualCost: "1" });
    expect(mockRequirePermission).toHaveBeenCalledWith("finance", "admin");

    mockRequirePermission.mockClear();
    await fetchSueldosPlanning(2026, "all", "2026-01-01", "2026-12-31");
    expect(mockRequirePermission).toHaveBeenCalledWith("finance", "viewer");
  });
});

describe("allocations", () => {
  let sid: number;

  beforeEach(async () => {
    const { createPerson, createFundingSource } = await actions();
    await createPerson({
      name: "Pedro Almeida",
      role: null,
      groupId: null,
      year: 2026,
      annualCost: "35972.5",
    });
    await createFundingSource({
      name: "GIZ",
      status: "funded",
      defaultStartDate: "2024-11-01",
      defaultEndDate: "2026-06-30",
    });
    sid = (raw.prepare("SELECT id FROM finance_funding_sources").get() as { id: number }).id;
  });

  it("inherits the source's default period when dates are omitted", async () => {
    const { createAllocation } = await actions();
    await createAllocation({
      sourceId: sid,
      target: `person:${personId("Pedro Almeida")}`,
      amount: "9042",
      startDate: null,
      endDate: null,
      notes: null,
    });
    const row = raw.prepare("SELECT start_date, end_date FROM finance_salary_allocations").get() as {
      start_date: string;
      end_date: string;
    };
    expect(row.start_date).toBe("2024-11-01");
    expect(row.end_date).toBe("2026-06-30");
  });

  it("keeps its own dates when given, without touching the source", async () => {
    const { createAllocation } = await actions();
    await createAllocation({
      sourceId: sid,
      target: `person:${personId("Pedro Almeida")}`,
      amount: "9042",
      startDate: "2024-11-01",
      endDate: "2025-10-30",
      notes: null,
    });
    const row = raw.prepare("SELECT end_date FROM finance_salary_allocations").get() as {
      end_date: string;
    };
    expect(row.end_date).toBe("2025-10-30");

    const src = raw.prepare("SELECT default_end_date FROM finance_funding_sources").get() as {
      default_end_date: string;
    };
    expect(src.default_end_date).toBe("2026-06-30");
  });

  it("stores a group target with a null person", async () => {
    const { createAllocation } = await actions();
    const res = await createAllocation({
      sourceId: sid,
      target: `group:${groupId("FCATeros Ext.")}`,
      amount: "44800",
      startDate: "2025-01-01",
      endDate: "2026-01-30",
      notes: "extensionists",
    });
    expect(res.success).toBe(true);
    const row = raw.prepare("SELECT person_id, group_id FROM finance_salary_allocations").get() as {
      person_id: number | null;
      group_id: number | null;
    };
    expect(row.person_id).toBeNull();
    expect(row.group_id).toBe(groupId("FCATeros Ext."));
  });

  it("rejects a line with no target", async () => {
    const { createAllocation } = await actions();
    const res = await createAllocation({
      sourceId: sid,
      target: "",
      amount: "100",
      startDate: null,
      endDate: null,
      notes: null,
    });
    expect(res.success).toBe(false);
    expect(count("finance_salary_allocations")).toBe(0);
  });

  it("rejects an end date before the start date", async () => {
    const { createAllocation } = await actions();
    const res = await createAllocation({
      sourceId: sid,
      target: `person:${personId("Pedro Almeida")}`,
      amount: "100",
      startDate: "2026-08-01",
      endDate: "2026-03-01",
      notes: null,
    });
    expect(res.success).toBe(false);
  });

  it("moves person and group together when retargeting, never violating the XOR check", async () => {
    const { createAllocation, updateAllocationField } = await actions();
    await createAllocation({
      sourceId: sid,
      target: `person:${personId("Pedro Almeida")}`,
      amount: "1000",
      startDate: null,
      endDate: null,
      notes: null,
    });
    const aid = (raw.prepare("SELECT id FROM finance_salary_allocations").get() as { id: number })
      .id;

    const res = await updateAllocationField(aid, "personId", `group:${groupId("FCATeros")}`);
    expect(res.success).toBe(true);

    const row = raw
      .prepare("SELECT person_id, group_id FROM finance_salary_allocations WHERE id = ?")
      .get(aid) as { person_id: number | null; group_id: number | null };
    expect(row.person_id).toBeNull();
    expect(row.group_id).toBe(groupId("FCATeros"));
  });
});

describe("cascades", () => {
  let sid: number;

  beforeEach(async () => {
    const { createPerson, createFundingSource, createAllocation } = await actions();
    await createPerson({
      name: "Miembro",
      role: "FCATero",
      groupId: groupId("FCATeros"),
      year: 2026,
      annualCost: "8000",
    });
    await createFundingSource({
      name: "NMBCA VII",
      status: "funded",
      defaultStartDate: "2024-07-01",
      defaultEndDate: "2026-06-30",
    });
    sid = (raw.prepare("SELECT id FROM finance_funding_sources").get() as { id: number }).id;

    await createAllocation({
      sourceId: sid,
      target: `person:${personId("Miembro")}`,
      amount: "5000",
      startDate: null,
      endDate: null,
      notes: null,
    });
    await createAllocation({
      sourceId: sid,
      target: `group:${groupId("FCATeros")}`,
      amount: "8000",
      startDate: null,
      endDate: null,
      notes: null,
    });
  });

  it("removes a person's salaries and named lines, leaving pooled lines alone", async () => {
    const { deletePerson } = await actions();
    await deletePerson(personId("Miembro"));

    expect(count("finance_people")).toBe(0);
    expect(count("finance_salaries")).toBe(0);
    expect(count("finance_salary_allocations")).toBe(1); // the pooled line survives
  });

  it("removes every line when its source is deleted", async () => {
    const { deleteFundingSource } = await actions();
    await deleteFundingSource(sid);

    expect(count("finance_funding_sources")).toBe(0);
    expect(count("finance_salary_allocations")).toBe(0);
  });

  it("keeps a person's rows when they are only deactivated", async () => {
    const { updatePersonField } = await actions();
    await updatePersonField(personId("Miembro"), "active", "false");

    expect(count("finance_people")).toBe(1);
    expect(count("finance_salaries")).toBe(1);
    expect(count("finance_salary_allocations")).toBe(2);
  });
});

describe("fetchSueldosPlanning", () => {
  beforeEach(async () => {
    const { createPerson, createFundingSource, createAllocation } = await actions();

    await createPerson({
      name: "Directora",
      role: "Directora operaciones",
      groupId: null,
      year: 2026,
      annualCost: "59261.58",
    });
    await createPerson({
      name: "FCATero Uno",
      role: "FCATero",
      groupId: groupId("FCATeros"),
      year: 2026,
      annualCost: "16546.20",
    });

    await createFundingSource({
      name: "GIZ",
      status: "funded",
      defaultStartDate: "2026-01-01",
      defaultEndDate: "2026-12-31",
    });
    await createFundingSource({
      name: "NMBCA VIII",
      status: "pending",
      defaultStartDate: "2026-01-01",
      defaultEndDate: "2026-12-31",
    });

    const giz = (
      raw.prepare("SELECT id FROM finance_funding_sources WHERE name = 'GIZ'").get() as {
        id: number;
      }
    ).id;
    const nmbca = (
      raw.prepare("SELECT id FROM finance_funding_sources WHERE name = 'NMBCA VIII'").get() as {
        id: number;
      }
    ).id;

    await createAllocation({
      sourceId: giz,
      target: `person:${personId("Directora")}`,
      amount: "10000",
      startDate: null,
      endDate: null,
      notes: null,
    });
    await createAllocation({
      sourceId: nmbca,
      target: `person:${personId("Directora")}`,
      amount: "5000",
      startDate: null,
      endDate: null,
      notes: null,
    });
  });

  it("counts every source when the filter is 'all'", async () => {
    const { fetchSueldosPlanning } = await actions();
    const res = await fetchSueldosPlanning(2026, "all", "2026-01-01", "2026-12-31");
    expect(res.success).toBe(true);
    if (!res.success) return;

    expect(res.data.total.cost).toBeCloseTo(59261.58 + 16546.2, 2);
    expect(res.data.total.funded).toBeCloseTo(15000, 2);
    expect(res.data.sources).toHaveLength(2);
  });

  it("excludes pending sources from totals, tables and charts together", async () => {
    const { fetchSueldosPlanning } = await actions();
    const res = await fetchSueldosPlanning(2026, "funded", "2026-01-01", "2026-12-31");
    expect(res.success).toBe(true);
    if (!res.success) return;

    expect(res.data.total.funded).toBeCloseTo(10000, 2);
    expect(res.data.sources).toHaveLength(1);
    expect(res.data.sources[0].name).toBe("GIZ");

    const directora = res.data.ungrouped.find((p) => p.name === "Directora");
    expect(directora?.funded).toBeCloseTo(10000, 2);

    const chartTotal = res.data.chart.find((c) => c.key === "total");
    const chartSum =
      chartTotal?.months.reduce((s, m) => s + m.totalFunded, 0) ?? 0;
    expect(chartSum).toBeCloseTo(10000, 2);
  });

  it("returns an empty-but-valid payload for a year with no salaries", async () => {
    const { fetchSueldosPlanning } = await actions();
    const res = await fetchSueldosPlanning(2019, "all", "2019-01-01", "2019-12-31");
    expect(res.success).toBe(true);
    if (!res.success) return;

    expect(res.data.total.cost).toBe(0);
    expect(res.data.total.percentCovered).toBe(0);
    expect(res.data.empty).toBe(false); // people exist, just no salaries that year
  });

  it("flags an empty roster so the page can point at the import", async () => {
    raw.exec("DELETE FROM finance_salary_allocations; DELETE FROM finance_people;");
    const { fetchSueldosPlanning } = await actions();
    const res = await fetchSueldosPlanning(2026, "all", "2026-01-01", "2026-12-31");
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.empty).toBe(true);
  });

  it("derives the group's cost from its members and lists available years", async () => {
    const { fetchSueldosPlanning } = await actions();
    const res = await fetchSueldosPlanning(2026, "all", "2026-01-01", "2026-12-31");
    if (!res.success) throw new Error("expected success");

    const fcateros = res.data.groups.find((g) => g.name === "FCATeros");
    expect(fcateros?.cost).toBeCloseTo(16546.2, 2);
    expect(fcateros?.members).toHaveLength(1);
    expect(res.data.availableYears).toEqual([2026]);
  });

  it("reports the derived share of salary on a person line", async () => {
    const { fetchSueldosPlanning } = await actions();
    const res = await fetchSueldosPlanning(2026, "funded", "2026-01-01", "2026-12-31");
    if (!res.success) throw new Error("expected success");

    const line = res.data.sources[0].lines[0];
    // $10,000 over 12 months against $59,261.58/yr
    expect(line.share).toBeCloseTo(10000 / 59261.58, 3);
  });

  it("leaves the share unset on a group-targeted line", async () => {
    const { createAllocation, fetchSueldosPlanning } = await actions();
    const giz = (
      raw.prepare("SELECT id FROM finance_funding_sources WHERE name = 'GIZ'").get() as {
        id: number;
      }
    ).id;
    await createAllocation({
      sourceId: giz,
      target: `group:${groupId("FCATeros")}`,
      amount: "8000",
      startDate: null,
      endDate: null,
      notes: null,
    });

    const res = await fetchSueldosPlanning(2026, "funded", "2026-01-01", "2026-12-31");
    if (!res.success) throw new Error("expected success");

    const groupLine = res.data.sources[0].lines.find((l) => l.targetKind === "group");
    expect(groupLine?.share).toBeNull();
  });
});

describe("system events", () => {
  it("records create and delete without ever naming a salary figure", async () => {
    const { createPerson, deletePerson } = await actions();
    await createPerson({
      name: "Luis Carrasco",
      role: null,
      groupId: null,
      year: 2026,
      annualCost: "66569.82",
    });
    await deletePerson(personId("Luis Carrasco"));

    expect(recordEventMock).toHaveBeenCalledTimes(2);
    for (const call of recordEventMock.mock.calls) {
      const input = call[0] as { summary: string; details?: Record<string, unknown> };
      expect(input.summary).not.toMatch(/33[,.]?284/);
      expect(JSON.stringify(input.details ?? {})).not.toMatch(/33284\.91/);
    }
  });

  it("does not record an event for a per-field edit", async () => {
    const { createPerson, updatePersonField } = await actions();
    await createPerson({ name: "Alguien", role: null, groupId: null, year: 2026, annualCost: "1" });
    recordEventMock.mockClear();

    await updatePersonField(personId("Alguien"), "role", "FCATero");
    expect(recordEventMock).not.toHaveBeenCalled();
  });
});

describe("cache invalidation", () => {
  it("revalidates the page after a mutation", async () => {
    const { createPerson } = await actions();
    await createPerson({ name: "Alguien", role: null, groupId: null, year: 2026, annualCost: "1" });
    expect(revalidatePathMock).toHaveBeenCalledWith("/finance/sueldos");
  });
});
