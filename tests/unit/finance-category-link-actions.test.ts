/**
 * Functional tests for the in-app category-link editor actions
 * (src/app/finance/budget/actions.ts): fetchCategoryLinkEditorData +
 * setCategoryLink. Backed by a real in-memory SQLite DB with the three
 * finance tables, using the Proxy-delegation pattern from test-db.ts.
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

const FINANCE_DDL = `
  CREATE TABLE finance_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL,
    codigo TEXT NOT NULL DEFAULT '',
    cuenta_nombre TEXT NOT NULL,
    asiento TEXT NOT NULL DEFAULT '',
    detalle TEXT, actor TEXT, centros_de_ingreso TEXT, c_costo TEXT,
    debe REAL NOT NULL DEFAULT 0,
    haber REAL NOT NULL DEFAULT 0,
    balance REAL,
    year INTEGER NOT NULL,
    month INTEGER NOT NULL,
    year_month TEXT NOT NULL,
    tx_type TEXT NOT NULL CHECK(tx_type IN ('revenue','expense','cash','other'))
  );
  CREATE TABLE finance_budget_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    budget_year INTEGER NOT NULL,
    category TEXT NOT NULL,
    amount REAL NOT NULL
  );
  CREATE TABLE finance_category_map (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    budget_category TEXT NOT NULL,
    link_expense_category TEXT NOT NULL
  );
`;

const YEAR = new Date().getFullYear();

function expense(cuenta: string, debe: number) {
  return {
    fecha: `${YEAR}-06-15`,
    codigo: "5",
    cuentaNombre: cuenta,
    asiento: "1",
    debe,
    haber: 0,
    year: YEAR,
    month: 6,
    yearMonth: `${YEAR}-06`,
    txType: "expense" as const,
  };
}

function createDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(FINANCE_DDL);
  return drizzle(sqlite, { schema });
}

const { fetchCategoryLinkEditorData, setCategoryLink } = await import(
  "@/app/finance/budget/actions"
);

function mapRows() {
  return testDbRef.current!
    .select({
      budgetCategory: schema.financeCategoryMap.budgetCategory,
      linkExpenseCategory: schema.financeCategoryMap.linkExpenseCategory,
    })
    .from(schema.financeCategoryMap)
    .all();
}

beforeEach(() => {
  recordEventMock.mockClear();
  revalidatePathMock.mockClear();
  mockRequirePermission.mockClear();
  const db = createDb();
  testDbRef.current = db;

  // Expenses: A=150, B=30, C=20
  db.insert(schema.financeTransactions)
    .values([expense("A", 100), expense("A", 50), expense("B", 30), expense("C", 20)])
    .run();
  // Budget lines for the dropdown
  db.insert(schema.financeBudgetItems)
    .values([
      { budgetYear: YEAR, category: "Food", amount: 1000 },
      { budgetYear: YEAR, category: "Transport", amount: 500 },
    ])
    .run();
  // A already mapped to Food; D mapped to Transport but has no transactions
  db.insert(schema.financeCategoryMap)
    .values([
      { budgetCategory: "Food", linkExpenseCategory: "A" },
      { budgetCategory: "Transport", linkExpenseCategory: "D" },
    ])
    .run();
});

describe("fetchCategoryLinkEditorData", () => {
  it("returns every accounting category with its assignment, unlinked first", async () => {
    const res = await fetchCategoryLinkEditorData();
    expect(res.success).toBe(true);
    if (!res.success) return;

    const { rows, budgetCategoryOptions } = res.data;
    // Universe: A,B,C (expenses) ∪ D (mapped, no txns)
    expect(rows.map((r) => r.linkCategory).sort()).toEqual(["A", "B", "C", "D"]);

    // Unlinked (B, C) come before linked (A, D)
    const unlinked = rows.filter((r) => r.budgetCategory === null);
    expect(unlinked.map((r) => r.linkCategory)).toEqual(["B", "C"]); // sorted by spend desc
    expect(rows[0].linkCategory).toBe("B");

    const a = rows.find((r) => r.linkCategory === "A")!;
    expect(a).toMatchObject({ budgetCategory: "Food", spent: 150 });
    // D is mapped but has no current-year spend
    const d = rows.find((r) => r.linkCategory === "D")!;
    expect(d).toMatchObject({ budgetCategory: "Transport", spent: 0 });

    expect(budgetCategoryOptions).toEqual(["Food", "Transport"]);
  });

  it("keeps categories with only prior-year spend (and no mapping) so they stay editable", async () => {
    // F only ever had expenses in a prior year and is not mapped. It must still
    // appear so its link can be set at any time — previously it vanished because
    // the universe was current-year-only.
    testDbRef.current!
      .insert(schema.financeTransactions)
      .values([
        {
          fecha: `${YEAR - 1}-06-15`,
          codigo: "5",
          cuentaNombre: "F",
          asiento: "1",
          debe: 999,
          haber: 0,
          year: YEAR - 1,
          month: 6,
          yearMonth: `${YEAR - 1}-06`,
          txType: "expense" as const,
        },
      ])
      .run();

    const res = await fetchCategoryLinkEditorData();
    expect(res.success).toBe(true);
    if (!res.success) return;

    const f = res.data.rows.find((r) => r.linkCategory === "F");
    expect(f).toBeDefined();
    // Present and linkable, but spent stays current-year (0), not the prior-year 999.
    expect(f).toMatchObject({ budgetCategory: null, spent: 0 });
  });
});

describe("setCategoryLink", () => {
  it("assigns an unlinked accounting category", async () => {
    const res = await setCategoryLink("B", "Transport");
    expect(res.success).toBe(true);
    const bRows = mapRows().filter((r) => r.linkExpenseCategory === "B");
    expect(bRows).toEqual([{ budgetCategory: "Transport", linkExpenseCategory: "B" }]);
    expect(recordEventMock).toHaveBeenCalledOnce();
    expect(revalidatePathMock).toHaveBeenCalledWith("/finance");
  });

  it("reassigning replaces the existing row (never duplicates)", async () => {
    await setCategoryLink("A", "Transport");
    const aRows = mapRows().filter((r) => r.linkExpenseCategory === "A");
    expect(aRows).toEqual([{ budgetCategory: "Transport", linkExpenseCategory: "A" }]);
  });

  it("clears a mapping when budgetCategory is null", async () => {
    const res = await setCategoryLink("A", null);
    expect(res.success).toBe(true);
    expect(mapRows().filter((r) => r.linkExpenseCategory === "A")).toHaveLength(0);
    expect(recordEventMock).toHaveBeenCalledOnce();
  });

  it("collapses dirty legacy data (multiple rows) to exactly one", async () => {
    testDbRef.current!
      .insert(schema.financeCategoryMap)
      .values([
        { budgetCategory: "Food", linkExpenseCategory: "E" },
        { budgetCategory: "Transport", linkExpenseCategory: "E" },
      ])
      .run();
    await setCategoryLink("E", "Food");
    expect(mapRows().filter((r) => r.linkExpenseCategory === "E")).toEqual([
      { budgetCategory: "Food", linkExpenseCategory: "E" },
    ]);
  });

  it("rejects an empty accounting category", async () => {
    const res = await setCategoryLink("   ", "Food");
    expect(res.success).toBe(false);
  });
});
