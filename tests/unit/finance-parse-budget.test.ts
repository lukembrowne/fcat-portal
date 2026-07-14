import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import { parseBudgetExcel } from "@/app/finance/lib/parse-budget";

/**
 * Build a minimal "Budget" workbook buffer with an "Expenses Detail" sheet.
 * Each row is [category, budgetAmount] under a "<year> Budget" column.
 */
function buildBudgetBuffer(
  rows: [string, number][],
  year: number
): ArrayBuffer {
  const aoa: (string | number)[][] = [
    ["Position or Expense Category", `${year} Budget`],
    ...rows,
  ];
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Expenses Detail");
  return XLSX.write(wb, { type: "array", bookType: "xlsx" });
}

describe("parseBudgetExcel — Personnel breakdown", () => {
  it("keeps the two Personnel subtotals as separate categories (no double-count)", () => {
    const buffer = buildBudgetBuffer(
      [
        ["Personnel Total with Contract", 200000],
        ["Personnel Total without Contract", 100000],
        ["Food", 5000],
      ],
      2026
    );

    const { items } = parseBudgetExcel(buffer, 2026);

    // Broken down into two rows, each keeping its own subtotal.
    const withContract = items.filter(
      (i) => i.category === "Personnel with Contract"
    );
    const withoutContract = items.filter(
      (i) => i.category === "Personnel without Contract"
    );
    expect(withContract).toHaveLength(1);
    expect(withContract[0].amount).toBe(200000);
    expect(withoutContract).toHaveLength(1);
    expect(withoutContract[0].amount).toBe(100000);

    // No merged "Personnel" row, and no leftover raw sheet labels.
    expect(items.some((i) => i.category === "Personnel")).toBe(false);
    expect(
      items.some((i) => i.category === "Personnel Total with Contract")
    ).toBe(false);
    expect(
      items.some((i) => i.category === "Personnel Total without Contract")
    ).toBe(false);

    // Total is not inflated by a duplicate row.
    const total = items.reduce((sum, i) => sum + i.amount, 0);
    expect(total).toBe(305000);
  });

  it("excludes individual staff rows in the PERSONNEL section (by section, not name)", () => {
    const buffer = buildBudgetBuffer(
      [
        ["PERSONNEL", 0],
        ["With Contract", 0],
        ["Director de Reserva - Luis Carrasco", 32954.44],
        ["FCATero Junior - Darío Cantos", 9230.25],
        ["Personnel Total with Contract", 200000],
        ["No Contract", 0],
        ["Accountant - Johanna Bravo", 5000],
        ["Personnel Total without Contract", 100000],
        ["TOTAL PERSONNEL COSTS", 300000],
        ["Food", 5000],
        ["Nueva Categoría X", 1200],
      ],
      2026
    );

    const { items, unknownItems } = parseBudgetExcel(buffer, 2026);

    // Individual staff never appear as budget items nor as "new" categories.
    const staff = [
      "Director de Reserva - Luis Carrasco",
      "FCATero Junior - Darío Cantos",
      "Accountant - Johanna Bravo",
    ];
    for (const name of staff) {
      expect(items.some((i) => i.category === name)).toBe(false);
      expect(unknownItems.some((i) => i.category === name)).toBe(false);
    }

    // Personnel splits into two subtotal rows; Food imports; only the genuinely
    // new specific-expense category is surfaced for review.
    expect(
      items.find((i) => i.category === "Personnel with Contract")!.amount
    ).toBe(200000);
    expect(
      items.find((i) => i.category === "Personnel without Contract")!.amount
    ).toBe(100000);
    expect(items.some((i) => i.category === "Food")).toBe(true);
    expect(unknownItems.map((i) => i.category)).toEqual(["Nueva Categoría X"]);
  });

  it("does not pull an allowlisted name out of the PERSONNEL section (no double-count, no early end)", () => {
    // "Security Guards" is in BUDGET_CATEGORIES but here it is a No-Contract
    // staff line already rolled into "Personnel Total without Contract". It must
    // NOT be counted a second time, and it must NOT prematurely end the section
    // (which would drop the following "Temporary FCATeros" line to the
    // unrecognized path). Regression for the 2026 budget $3,600 discrepancy.
    const buffer = buildBudgetBuffer(
      [
        ["PERSONNEL", 0],
        ["With Contract", 0],
        ["Director de Reserva - Luis Carrasco", 32954.44],
        ["Personnel Total with Contract", 286033.8],
        ["No Contract", 0],
        ["Kitchen Helpers", 5000],
        ["Security Guards", 3600],
        ["Temporary FCATeros", 4000],
        ["Personnel Total without Contract", 41332.44],
        ["TOTAL PERSONNEL COSTS", 327366.24],
        ["Food", 45500],
      ],
      2026
    );

    const { items, unknownItems } = parseBudgetExcel(buffer, 2026);

    // Security Guards is not pulled out as its own line (it's in the subtotal).
    expect(items.some((i) => i.category === "Security Guards")).toBe(false);
    // The following staff line is still treated as personnel, not "new".
    expect(unknownItems.map((i) => i.category)).toEqual([]);
    // The without-contract subtotal keeps its exact value — no $3,600 inflation.
    expect(
      items.find((i) => i.category === "Personnel without Contract")!.amount
    ).toBeCloseTo(41332.44, 2);
    expect(
      items.find((i) => i.category === "Personnel with Contract")!.amount
    ).toBeCloseTo(286033.8, 2);
    const total = items.reduce((sum, i) => sum + i.amount, 0);
    expect(total).toBeCloseTo(372866.24, 2);
  });

  it("imports recognized $0 categories but drops unrecognized $0 rows", () => {
    const buffer = buildBudgetBuffer(
      [
        ["Food", 45500],
        ["Land acquisition", 0], // recognized, $0 → imported so it's linkable
        ["New construction", 0], // recognized, $0 → imported
        ["Assets", 0], // unrecognized header → dropped
        ["Nueva Categoría Z", 0], // unrecognized $0 → dropped, not a "new" category
      ],
      2026
    );

    const { items, unknownItems } = parseBudgetExcel(buffer, 2026);
    const cats = items.map((i) => i.category).sort();

    expect(cats).toEqual(["Food", "Land acquisition", "New construction"]);
    expect(
      items.find((i) => i.category === "Land acquisition")!.amount
    ).toBe(0);
    // Unrecognized zero rows never surface as items or as review candidates.
    expect(items.some((i) => i.category === "Assets")).toBe(false);
    expect(unknownItems).toHaveLength(0);
  });

  it("keeps the 'with Contract' row on its own when the other is absent", () => {
    const buffer = buildBudgetBuffer(
      [
        ["Personnel Total with Contract", 200000],
        ["Food", 5000],
      ],
      2026
    );

    const { items } = parseBudgetExcel(buffer, 2026);
    const personnel = items.filter(
      (i) => i.category === "Personnel with Contract"
    );
    expect(personnel).toHaveLength(1);
    expect(personnel[0].amount).toBe(200000);
    expect(items.some((i) => i.category === "Personnel")).toBe(false);
  });
});
