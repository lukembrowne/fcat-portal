import { describe, it, expect } from "vitest";
import {
  budgetProportionByDay,
  dayOfYear,
  calculateRunwayMonths,
  monthSequence,
  getDateRangeForPreset,
} from "../calculations";

describe("dayOfYear", () => {
  it("returns 1 for January 1", () => {
    expect(dayOfYear("2025-01-01")).toBe(1);
  });

  it("returns 32 for February 1", () => {
    expect(dayOfYear("2025-02-01")).toBe(32);
  });

  it("returns 365 for December 31 in a non-leap year", () => {
    expect(dayOfYear("2025-12-31")).toBe(365);
  });

  it("returns 60 for March 1 in a non-leap year", () => {
    expect(dayOfYear("2025-03-01")).toBe(60);
  });
});

describe("budgetProportionByDay", () => {
  it("returns 0 for day 0", () => {
    expect(budgetProportionByDay(0)).toBe(0);
  });

  it("returns 1 for day 366", () => {
    expect(budgetProportionByDay(366)).toBe(1);
  });

  it("returns a value between 0 and 1 for mid-year", () => {
    const result = budgetProportionByDay(182); // ~July 1
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThan(1);
  });

  it("is monotonically increasing", () => {
    let prev = 0;
    for (let d = 1; d <= 365; d++) {
      const current = budgetProportionByDay(d);
      expect(current).toBeGreaterThanOrEqual(prev);
      prev = current;
    }
  });

  it("approximately sums to 1 at day 365", () => {
    const result = budgetProportionByDay(365);
    expect(result).toBeCloseTo(1.0, 2);
  });
});

describe("calculateRunwayMonths", () => {
  it("calculates runway correctly", () => {
    // $500k balance / ($600k annual / 12 months) = 10 months
    expect(calculateRunwayMonths(500000, 600000)).toBe(10);
  });

  it("returns 0 when annual expenses is 0", () => {
    expect(calculateRunwayMonths(500000, 0)).toBe(0);
  });

  it("returns 0 when annual expenses is negative", () => {
    expect(calculateRunwayMonths(500000, -100)).toBe(0);
  });

  it("handles zero balance", () => {
    expect(calculateRunwayMonths(0, 600000)).toBe(0);
  });

  it("rounds to 2 decimal places", () => {
    // $100k / ($365k/12) = 3.287671...
    const result = calculateRunwayMonths(100000, 365000);
    expect(result).toBe(3.29);
  });
});

describe("monthSequence", () => {
  it("returns a single month for same start and end", () => {
    expect(monthSequence("2025-06-01", "2025-06-01")).toEqual(["2025-06-01"]);
  });

  it("returns correct sequence within a year", () => {
    const result = monthSequence("2025-01-01", "2025-03-01");
    expect(result).toEqual(["2025-01-01", "2025-02-01", "2025-03-01"]);
  });

  it("handles year boundaries", () => {
    const result = monthSequence("2025-11-01", "2026-02-01");
    expect(result).toEqual([
      "2025-11-01",
      "2025-12-01",
      "2026-01-01",
      "2026-02-01",
    ]);
  });

  it("returns empty for reversed range", () => {
    expect(monthSequence("2025-06-01", "2025-01-01")).toEqual([]);
  });
});

describe("getDateRangeForPreset", () => {
  it("returns this year range for 'this-year'", () => {
    const result = getDateRangeForPreset("this-year");
    const y = new Date().getFullYear();
    expect(result.from).toBe(`${y}-01-01`);
    expect(result.to).toBe(`${y}-12-31`);
  });

  it("returns last year range for 'last-year'", () => {
    const result = getDateRangeForPreset("last-year");
    const y = new Date().getFullYear() - 1;
    expect(result.from).toBe(`${y}-01-01`);
    expect(result.to).toBe(`${y}-12-31`);
  });

  it("returns a valid date range for 'this-month'", () => {
    const result = getDateRangeForPreset("this-month");
    expect(result.from).toMatch(/^\d{4}-\d{2}-01$/);
    expect(result.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.from <= result.to).toBe(true);
  });

  it("returns a valid date range for 'last-month'", () => {
    const result = getDateRangeForPreset("last-month");
    expect(result.from).toMatch(/^\d{4}-\d{2}-01$/);
    expect(result.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result.from <= result.to).toBe(true);
  });

  it("defaults to this year for unknown preset", () => {
    const result = getDateRangeForPreset("unknown");
    const y = new Date().getFullYear();
    expect(result.from).toBe(`${y}-01-01`);
  });
});
