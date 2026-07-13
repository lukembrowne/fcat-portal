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

describe("parseBudgetExcel — Personnel combine", () => {
  it("combines the two Personnel categories into ONE row (no double-count)", () => {
    const buffer = buildBudgetBuffer(
      [
        ["Personnel Total with Contract", 200000],
        ["Personnel Total without Contract", 100000],
        ["Food", 5000],
      ],
      2026
    );

    const { items } = parseBudgetExcel(buffer, 2026);

    const personnel = items.filter((i) => i.category === "Personnel");
    // Exactly one combined Personnel row — the bug produced two identical rows.
    expect(personnel).toHaveLength(1);
    expect(personnel[0].amount).toBe(300000);

    // No leftover original personnel categories
    expect(
      items.some((i) => i.category === "Personnel Total with Contract")
    ).toBe(false);
    expect(
      items.some((i) => i.category === "Personnel Total without Contract")
    ).toBe(false);

    // Total is not inflated by a duplicate Personnel row
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

    // Personnel collapses to one combined row; Food imports; only the genuinely
    // new specific-expense category is surfaced for review.
    expect(items.filter((i) => i.category === "Personnel")).toHaveLength(1);
    expect(items.find((i) => i.category === "Personnel")!.amount).toBe(300000);
    expect(items.some((i) => i.category === "Food")).toBe(true);
    expect(unknownItems.map((i) => i.category)).toEqual(["Nueva Categoría X"]);
  });

  it("renames a lone 'with Contract' row to Personnel when the other is absent", () => {
    const buffer = buildBudgetBuffer(
      [
        ["Personnel Total with Contract", 200000],
        ["Food", 5000],
      ],
      2026
    );

    const { items } = parseBudgetExcel(buffer, 2026);
    const personnel = items.filter((i) => i.category === "Personnel");
    expect(personnel).toHaveLength(1);
    expect(personnel[0].amount).toBe(200000);
  });
});
