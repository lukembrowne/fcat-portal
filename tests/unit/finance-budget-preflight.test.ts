/**
 * Pre-flight budget upload: parser split (known vs. unknown categories) and the
 * previewBudget / commitBudget approval flow (unrecognized categories are
 * surfaced and only imported when approved or already-known, never dropped
 * silently). Backed by a real in-memory SQLite DB for the action tests.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as XLSX from "xlsx";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { parseBudgetExcel } from "@/app/finance/lib/parse-budget";

function buildBudgetBuffer(rows: [string, number][], year: number): ArrayBuffer {
  const aoa: (string | number)[][] = [
    ["Position or Expense Category", `${year} Budget`],
    ...rows,
  ];
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Expenses Detail");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" });
}

const YEAR = new Date().getFullYear();

describe("parseBudgetExcel — known vs. unknown split", () => {
  it("recognized categories go to items, unrecognized to unknownItems", () => {
    const buffer = buildBudgetBuffer(
      [
        ["Food", 5000],
        ["Nueva Categoría X", 1200],
        ["TOTAL EXPENSES", 99999], // total row — dropped from both
        ["Otra Cosa", 0], // zero amount — dropped
      ],
      YEAR
    );
    const { items, unknownItems } = parseBudgetExcel(buffer, YEAR);

    expect(items.map((i) => i.category)).toEqual(["Food"]);
    expect(unknownItems.map((i) => i.category)).toEqual(["Nueva Categoría X"]);
    expect(unknownItems[0].amount).toBe(1200);
  });
});

// ----- Action-layer tests (previewBudget / commitBudget) -----

vi.mock("server-only", () => ({}));
vi.mock("@/lib/system-events", () => ({ recordEvent: vi.fn(async () => undefined) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  requirePermission: vi.fn(async () => undefined),
  getCurrentUser: vi.fn(async () => ({ email: "admin@fcat-ecuador.org" })),
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

const FINANCE_DDL = `
  CREATE TABLE finance_budget_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    budget_year INTEGER NOT NULL,
    category TEXT NOT NULL,
    amount REAL NOT NULL
  );
  CREATE TABLE finance_uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_type TEXT NOT NULL,
    file_name TEXT NOT NULL,
    row_count INTEGER,
    uploaded_by TEXT NOT NULL,
    uploaded_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`;

const { previewBudget, commitBudget } = await import("@/app/finance/data/actions");

function fileFormData(rows: [string, number][], extra?: Record<string, string>) {
  const buffer = buildBudgetBuffer(rows, YEAR);
  const file = new File([buffer], "budget.xlsx", {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const fd = new FormData();
  fd.set("file", file);
  fd.set("year", String(YEAR));
  for (const [k, v] of Object.entries(extra ?? {})) fd.set(k, v);
  return fd;
}

function budgetCategories() {
  return testDbRef
    .current!.select({ category: schema.financeBudgetItems.category })
    .from(schema.financeBudgetItems)
    .all()
    .map((r) => r.category)
    .sort();
}

beforeEach(() => {
  const sqlite = new Database(":memory:");
  sqlite.exec(FINANCE_DDL);
  testDbRef.current = drizzle(sqlite, { schema });
});

describe("previewBudget", () => {
  it("reports recognized count and lists new categories", async () => {
    const res = await previewBudget(fileFormData([["Food", 5000], ["Nueva X", 1200]]));
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.knownCount).toBe(1);
    expect(res.data.newCategories).toEqual([{ category: "Nueva X", amount: 1200 }]);
  });

  it("does not re-flag a category already stored in the budget", async () => {
    testDbRef
      .current!.insert(schema.financeBudgetItems)
      .values({ budgetYear: YEAR, category: "Nueva X", amount: 1000 })
      .run();
    const res = await previewBudget(fileFormData([["Food", 5000], ["Nueva X", 1200]]));
    expect(res.success && res.data.newCategories).toEqual([]);
    expect(res.success && res.data.knownCount).toBe(2);
  });

  it("flags current categories that are missing from the file (will be removed)", async () => {
    testDbRef
      .current!.insert(schema.financeBudgetItems)
      .values([
        { budgetYear: YEAR, category: "Food", amount: 1 },
        { budgetYear: YEAR, category: "Transport", amount: 1 },
        { budgetYear: YEAR, category: "Lodging", amount: 1 },
      ])
      .run();
    // File contains only Food → Transport and Lodging would be deleted.
    const res = await previewBudget(fileFormData([["Food", 5000]]));
    expect(res.success && res.data.removedCategories).toEqual(["Lodging", "Transport"]);
  });

  it("reports the detected year and no mismatch for a matching column", async () => {
    const res = await previewBudget(fileFormData([["Food", 5000]]));
    expect(res.success && res.data.detectedYear).toBe(YEAR);
    expect(res.success && res.data.yearMismatch).toBe(false);
  });
});

describe("commitBudget", () => {
  it("imports approved new categories but drops unapproved ones", async () => {
    const res = await commitBudget(
      fileFormData([["Food", 5000], ["Aprobar", 100], ["Rechazar", 200]], {
        approvedCategories: JSON.stringify(["Aprobar"]),
      })
    );
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.newCount).toBe(1);
    expect(budgetCategories()).toEqual(["Aprobar", "Food"]);
  });

  it("without approvals, imports only recognized categories", async () => {
    const res = await commitBudget(fileFormData([["Food", 5000], ["Nueva X", 1200]]));
    expect(res.success).toBe(true);
    expect(budgetCategories()).toEqual(["Food"]);
  });

  it("keeps already-known categories even when not re-approved", async () => {
    testDbRef
      .current!.insert(schema.financeBudgetItems)
      .values({ budgetYear: YEAR, category: "Nueva X", amount: 1 })
      .run();
    await commitBudget(fileFormData([["Food", 5000], ["Nueva X", 1200]]));
    expect(budgetCategories()).toEqual(["Food", "Nueva X"]);
  });
});
