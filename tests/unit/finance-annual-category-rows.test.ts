import { describe, it, expect } from "vitest";
import { buildCategoryYearRows } from "@/app/finance/annual/category-rows";
import type { CategoryByYear } from "@/app/finance/annual/actions";

describe("buildCategoryYearRows", () => {
  it("builds per-year amounts, totals, and descending order by total", () => {
    const data: CategoryByYear[] = [
      { category: "Sueldos", year: 2023, amount: 100 },
      { category: "Sueldos", year: 2024, amount: 120 },
      { category: "Combustible", year: 2023, amount: 40 },
      { category: "Combustible", year: 2024, amount: 30 },
    ];
    const rows = buildCategoryYearRows(data, [2023, 2024]);

    expect(rows.map((r) => r.category)).toEqual(["Sueldos", "Combustible"]);
    expect(rows[0].perYear).toEqual({ "2023": 100, "2024": 120 });
    expect(rows[0].total).toBe(220);
    expect(rows[1].total).toBe(70);
  });

  it("treats a missing year cell as 0 without inflating the total", () => {
    const data: CategoryByYear[] = [
      { category: "Viáticos", year: 2024, amount: 50 },
    ];
    const rows = buildCategoryYearRows(data, [2023, 2024]);

    expect(rows[0].perYear).toEqual({ "2023": 0, "2024": 50 });
    expect(rows[0].total).toBe(50);
  });

  it("computes change as latest − previous with correct sign", () => {
    const data: CategoryByYear[] = [
      { category: "Up", year: 2023, amount: 10 },
      { category: "Up", year: 2024, amount: 25 },
      { category: "Down", year: 2023, amount: 40 },
      { category: "Down", year: 2024, amount: 15 },
    ];
    const rows = buildCategoryYearRows(data, [2023, 2024]);
    const up = rows.find((r) => r.category === "Up")!;
    const down = rows.find((r) => r.category === "Down")!;

    expect(up.change).toBe(15);
    expect(down.change).toBe(-25);
  });

  it("returns null change when only a single year exists", () => {
    const data: CategoryByYear[] = [
      { category: "Solo", year: 2024, amount: 100 },
    ];
    const rows = buildCategoryYearRows(data, [2024]);

    expect(rows[0].change).toBeNull();
  });

  it("scales barFraction against the largest row total", () => {
    const data: CategoryByYear[] = [
      { category: "Big", year: 2024, amount: 100 },
      { category: "Half", year: 2024, amount: 50 },
    ];
    const rows = buildCategoryYearRows(data, [2024]);
    const big = rows.find((r) => r.category === "Big")!;
    const half = rows.find((r) => r.category === "Half")!;

    expect(big.barFraction).toBe(1);
    expect(half.barFraction).toBe(0.5);
  });

  it("yields barFraction 0 for all-zero data (no divide-by-zero)", () => {
    const data: CategoryByYear[] = [
      { category: "A", year: 2024, amount: 0 },
      { category: "B", year: 2024, amount: 0 },
    ];
    const rows = buildCategoryYearRows(data, [2024]);

    expect(rows.every((r) => r.barFraction === 0)).toBe(true);
    expect(rows.every((r) => !Number.isNaN(r.barFraction))).toBe(true);
  });

  it("orders equal totals deterministically by category name", () => {
    const data: CategoryByYear[] = [
      { category: "Zebra", year: 2024, amount: 50 },
      { category: "Alpha", year: 2024, amount: 50 },
    ];
    const rows = buildCategoryYearRows(data, [2024]);

    expect(rows.map((r) => r.category)).toEqual(["Alpha", "Zebra"]);
  });

  it("returns an empty array for empty input", () => {
    expect(buildCategoryYearRows([], [2023, 2024])).toEqual([]);
  });
});
