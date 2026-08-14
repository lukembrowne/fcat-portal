/**
 * Rollup math for salary planning (src/app/finance/lib/sueldos-planning.ts).
 *
 * Pure functions, no database. The cases that matter most are the ones where a
 * number can look right and be wrong: a grouped person's salary counted twice in
 * the grand total, a pooled allocation counted both on the group and on its
 * members, and a member with no salary row for the year quietly contributing 0.
 */

import { describe, it, expect } from "vitest";
import {
  allocationMonths,
  fundedInYear,
  shareOfSalary,
  personCoverage,
  groupCoverage,
  grandTotal,
  salaryForYear,
  salaryForMonth,
  type AllocationRow,
  type PersonRow,
  type SalaryRow,
} from "@/app/finance/lib/sueldos-planning";

// --- fixtures ---------------------------------------------------------------

let nextId = 1;

function alloc(over: Partial<AllocationRow> = {}): AllocationRow {
  return {
    id: nextId++,
    sourceId: 1,
    personId: null,
    groupId: null,
    amount: 1200,
    startDate: "2026-01-01",
    endDate: "2026-12-31",
    ...over,
  };
}

function person(over: Partial<PersonRow> = {}): PersonRow {
  return {
    id: nextId++,
    name: `Person ${nextId}`,
    role: null,
    groupId: null,
    active: true,
    ...over,
  };
}

function salary(personId: number, year: number, annualCost: number): SalaryRow {
  return { personId, year, annualCost };
}

// --- month spans ------------------------------------------------------------

describe("allocationMonths", () => {
  it("spans inclusive months", () => {
    expect(allocationMonths(alloc({ startDate: "2026-01-15", endDate: "2026-03-04" }))).toEqual([
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
    ]);
  });

  it("returns a single month when start and end fall in the same month", () => {
    expect(allocationMonths(alloc({ startDate: "2026-05-02", endDate: "2026-05-28" }))).toEqual([
      "2026-05-01",
    ]);
  });

  it("returns nothing when the end date precedes the start date", () => {
    expect(allocationMonths(alloc({ startDate: "2026-06-01", endDate: "2026-02-01" }))).toEqual([]);
  });
});

// --- per-year proration -----------------------------------------------------

describe("fundedInYear", () => {
  it("contributes the whole amount when the allocation sits inside the year", () => {
    const a = alloc({ amount: 12000, startDate: "2026-01-01", endDate: "2026-12-31" });
    expect(fundedInYear(a, 2026)).toBeCloseTo(12000, 6);
  });

  it("contributes only the months falling in the selected year", () => {
    // NMBCA VII shape: 2024-07 .. 2026-06 = 24 months, $36,200 => $1,508.33/mo
    const a = alloc({ amount: 36200, startDate: "2024-07-01", endDate: "2026-06-30" });
    expect(fundedInYear(a, 2024)).toBeCloseTo((36200 / 24) * 6, 6);
    expect(fundedInYear(a, 2025)).toBeCloseTo((36200 / 24) * 12, 6);
    expect(fundedInYear(a, 2026)).toBeCloseTo((36200 / 24) * 6, 6);
  });

  it("sums across every year it touches back to the full amount", () => {
    const a = alloc({ amount: 36200, startDate: "2024-07-01", endDate: "2026-06-30" });
    const total = [2024, 2025, 2026].reduce((s, y) => s + fundedInYear(a, y), 0);
    expect(total).toBeCloseTo(36200, 6);
  });

  it("contributes nothing to a year it does not touch", () => {
    const a = alloc({ amount: 5000, startDate: "2024-01-01", endDate: "2024-12-31" });
    expect(fundedInYear(a, 2026)).toBe(0);
  });

  it("contributes the full amount for a single-month allocation without dividing by zero", () => {
    const a = alloc({ amount: 800, startDate: "2026-05-10", endDate: "2026-05-20" });
    expect(fundedInYear(a, 2026)).toBeCloseTo(800, 6);
  });

  it("contributes nothing when the end date precedes the start date", () => {
    const a = alloc({ amount: 9000, startDate: "2026-08-01", endDate: "2026-03-01" });
    expect(fundedInYear(a, 2026)).toBe(0);
  });
});

// --- derived share of salary ------------------------------------------------

describe("shareOfSalary", () => {
  it("reproduces the percentages the spreadsheet keeps by hand", () => {
    // Pedro Almeida on NMBCA VII: $36,200 over 24 months against $35,972.50/yr,
    // noted as "50%" in the sheet.
    const a = alloc({ amount: 36200, startDate: "2024-07-01", endDate: "2026-06-30" });
    expect(shareOfSalary(a, 35972.50)).toBeCloseTo(0.503, 2);

    // Fernando Castillo on the same grant, noted as "25%".
    const b = alloc({ amount: 21750, startDate: "2024-07-01", endDate: "2026-06-30" });
    expect(shareOfSalary(b, 43014.2)).toBeCloseTo(0.253, 2);
  });

  it("returns null when the target has no salary to compare against", () => {
    expect(shareOfSalary(alloc(), 0)).toBeNull();
    expect(shareOfSalary(alloc(), null)).toBeNull();
  });
});

// --- person coverage --------------------------------------------------------

describe("personCoverage", () => {
  it("reports the full salary as uncovered when nothing funds it", () => {
    const p = person();
    const c = personCoverage(p, [salary(p.id, 2026, 30000)], [], 2026);
    expect(c.cost).toBe(30000);
    expect(c.funded).toBe(0);
    expect(c.uncovered).toBe(30000);
    expect(c.overfunded).toBe(0);
    expect(c.state).toBe("under");
    expect(c.hasSalary).toBe(true);
  });

  it("counts only allocations that name this person", () => {
    const p = person();
    const other = person();
    const c = personCoverage(
      p,
      [salary(p.id, 2026, 30000)],
      [
        alloc({ personId: p.id, amount: 10000 }),
        alloc({ personId: other.id, amount: 9999 }),
        alloc({ groupId: 1, amount: 8888 }),
      ],
      2026
    );
    expect(c.funded).toBeCloseTo(10000, 6);
    expect(c.uncovered).toBeCloseTo(20000, 6);
  });

  it("reports over-funding as a positive overage, never a negative uncovered figure", () => {
    const p = person();
    const c = personCoverage(
      p,
      [salary(p.id, 2026, 8000)],
      [alloc({ personId: p.id, amount: 10000 })],
      2026
    );
    expect(c.state).toBe("over");
    expect(c.uncovered).toBe(0);
    expect(c.overfunded).toBeCloseTo(2000, 6);
  });

  it("reports exact coverage as covered despite floating-point drift", () => {
    const p = person();
    const c = personCoverage(
      p,
      [salary(p.id, 2026, 12000)],
      [alloc({ personId: p.id, amount: 12000 })],
      2026
    );
    expect(c.state).toBe("covered");
    expect(c.uncovered).toBe(0);
    expect(c.overfunded).toBe(0);
  });

  it("distinguishes a missing salary row from a salary of zero", () => {
    const missing = person();
    const zero = person();
    const a = personCoverage(missing, [], [], 2026);
    const b = personCoverage(zero, [salary(zero.id, 2026, 0)], [], 2026);

    expect(a.cost).toBe(0);
    expect(a.hasSalary).toBe(false);
    expect(b.cost).toBe(0);
    expect(b.hasSalary).toBe(true);
  });

  it("reports zero percent covered rather than NaN when there is no cost", () => {
    const p = person();
    const c = personCoverage(p, [], [], 2026);
    expect(c.percentCovered).toBe(0);
    expect(Number.isFinite(c.percentCovered)).toBe(true);
  });

  it("reads the selected year's salary, not another year's", () => {
    const p = person();
    const salaries = [salary(p.id, 2025, 20000), salary(p.id, 2026, 25000)];
    expect(personCoverage(p, salaries, [], 2025).cost).toBe(20000);
    expect(personCoverage(p, salaries, [], 2026).cost).toBe(25000);
  });
});

// --- group coverage ---------------------------------------------------------

describe("groupCoverage", () => {
  const GROUP_ID = 7;

  it("derives cost from active members and excludes inactive ones", () => {
    const a = person({ groupId: GROUP_ID });
    const b = person({ groupId: GROUP_ID });
    const gone = person({ groupId: GROUP_ID, active: false });
    const salaries = [
      salary(a.id, 2026, 16546.2),
      salary(b.id, 2026, 20810.62),
      salary(gone.id, 2026, 9000),
    ];

    const c = groupCoverage(GROUP_ID, [a, b, gone], salaries, [], 2026);
    expect(c.cost).toBeCloseTo(16546.2 + 20810.62, 6);
  });

  it("counts pooled lines and member-named lines toward the group", () => {
    const a = person({ groupId: GROUP_ID });
    const b = person({ groupId: GROUP_ID });
    const salaries = [salary(a.id, 2026, 10000), salary(b.id, 2026, 10000)];
    const allocations = [
      alloc({ groupId: GROUP_ID, amount: 8000 }),
      alloc({ personId: a.id, amount: 5000 }),
    ];

    const c = groupCoverage(GROUP_ID, [a, b], salaries, allocations, 2026);
    expect(c.cost).toBeCloseTo(20000, 6);
    expect(c.funded).toBeCloseTo(13000, 6);
    expect(c.pooledFunded).toBeCloseTo(8000, 6);
    expect(c.namedFunded).toBeCloseTo(5000, 6);
  });

  it("leaves pooled funding out of an individual member's own row", () => {
    const a = person({ groupId: GROUP_ID });
    const allocations = [
      alloc({ groupId: GROUP_ID, amount: 8000 }),
      alloc({ personId: a.id, amount: 5000 }),
    ];
    const c = personCoverage(a, [salary(a.id, 2026, 17132.32)], allocations, 2026);
    expect(c.funded).toBeCloseTo(5000, 6);
  });

  it("reports a group holding funding with no members as over-funded", () => {
    // FCATeros Ext. as of today: $44,800 of GIZ money, nobody assigned.
    const c = groupCoverage(
      GROUP_ID,
      [],
      [],
      [alloc({ groupId: GROUP_ID, amount: 44800, startDate: "2025-01-01", endDate: "2026-01-31" })],
      2026
    );
    expect(c.cost).toBe(0);
    expect(c.funded).toBeGreaterThan(0);
    expect(c.state).toBe("over");
    expect(c.memberCount).toBe(0);
  });

  it("names members with no salary row for the year instead of counting them as zero", () => {
    const paid = person({ groupId: GROUP_ID, name: "Con sueldo" });
    const missing = person({ groupId: GROUP_ID, name: "Sin sueldo" });
    const c = groupCoverage(
      GROUP_ID,
      [paid, missing],
      [salary(paid.id, 2026, 8000)],
      [],
      2026
    );
    expect(c.cost).toBeCloseTo(8000, 6);
    expect(c.membersMissingSalary).toEqual(["Sin sueldo"]);
  });
});

// --- grand total ------------------------------------------------------------

describe("grandTotal", () => {
  const GROUP_ID = 3;

  it("counts a grouped person's salary exactly once", () => {
    const solo = person();
    const inGroup = person({ groupId: GROUP_ID });
    const salaries = [salary(solo.id, 2026, 66569.82), salary(inGroup.id, 2026, 17132.32)];

    const total = grandTotal([solo, inGroup], salaries, [], 2026);
    expect(total.cost).toBeCloseTo(66569.82 + 17132.32, 6);
  });

  it("counts a pooled line and a member-named line once each", () => {
    const inGroup = person({ groupId: GROUP_ID });
    const salaries = [salary(inGroup.id, 2026, 17132.32)];
    const allocations = [
      alloc({ groupId: GROUP_ID, amount: 8000 }),
      alloc({ personId: inGroup.id, amount: 5000 }),
    ];

    const total = grandTotal([inGroup], salaries, allocations, 2026);
    expect(total.funded).toBeCloseTo(13000, 6);
  });

  it("excludes inactive people from the total cost", () => {
    const active = person();
    const gone = person({ active: false });
    const salaries = [salary(active.id, 2026, 20000), salary(gone.id, 2026, 15000)];
    expect(grandTotal([active, gone], salaries, [], 2026).cost).toBeCloseTo(20000, 6);
  });

  it("reconciles with the real 2025 figures from the Sueldos sheet", () => {
    // The eight named staff plus the thirteen FCATeros, which is what the
    // spreadsheet's own $562,100.72 total is made of.
    const named = [35972.50, 59261.58, 18398.0, 66569.82, 43014.2, 35397.08, 36404.26, 38849.34];
    const fcateros = [
      16546.2, 18865.38, 17570.38, 18865.38, 15235.6, 16546.2, 19452.88, 16546.2, 17132.32, 16546.2,
      17570.38, 16546.2, 20810.62,
    ];

    const people: PersonRow[] = [];
    const salaries: SalaryRow[] = [];
    for (const cost of named) {
      const p = person();
      people.push(p);
      salaries.push(salary(p.id, 2025, cost));
    }
    for (const cost of fcateros) {
      const p = person({ groupId: GROUP_ID });
      people.push(p);
      salaries.push(salary(p.id, 2025, cost));
    }

    expect(grandTotal(people, salaries, [], 2025).cost).toBeCloseTo(562100.72, 2);
    expect(groupCoverage(GROUP_ID, people, salaries, [], 2025).cost).toBeCloseTo(228233.94, 2);
  });
});

// --- salary lookup ----------------------------------------------------------

describe("salaryForYear / salaryForMonth", () => {
  it("returns null for a year with no row rather than falling back", () => {
    const p = person();
    expect(salaryForYear([salary(p.id, 2025, 20000)], p.id, 2026)).toBeNull();
  });

  it("falls back to the most recent earlier year for the chart reference line", () => {
    const p = person();
    const salaries = [salary(p.id, 2024, 18000), salary(p.id, 2026, 25000)];
    // 2025 has no row — the step line holds the 2024 figure until 2026 lands.
    expect(salaryForMonth(salaries, p.id, "2025-06-01")).toBe(18000);
    expect(salaryForMonth(salaries, p.id, "2026-06-01")).toBe(25000);
  });

  it("does not fall back to a later year for months before the first row", () => {
    const p = person();
    expect(salaryForMonth([salary(p.id, 2026, 25000)], p.id, "2024-06-01")).toBeNull();
  });
});
