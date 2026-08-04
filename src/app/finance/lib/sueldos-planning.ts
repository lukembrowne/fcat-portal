/**
 * Rollup math for salary planning (/finance/sueldos).
 *
 * Pure functions over plain row shapes — no database access — so the arithmetic
 * that decides "who isn't paid for yet" is testable without fixtures.
 *
 * Two invariants hold everything together:
 *
 *  1. A group's cost is ALWAYS derived from its members' salaries, never stored.
 *     The spreadsheet stored the FCATeros aggregate as its own row alongside the
 *     thirteen rows that sum to it, which lets the two drift.
 *  2. Because of (1), the grand total counts each person's salary exactly once
 *     and each allocation exactly once, whether or not a group is involved.
 */

import { monthSequence } from "./calculations";

// ---------------------------------------------------------------------------
// Row shapes (structural — actions pass query results straight in)
// ---------------------------------------------------------------------------

export interface AllocationRow {
  id: number;
  sourceId: number;
  /** Set iff this line names an individual. Mutually exclusive with groupId. */
  personId: number | null;
  /** Set iff this line funds a pool. Mutually exclusive with personId. */
  groupId: number | null;
  amount: number;
  /** YYYY-MM-DD */
  startDate: string;
  /** YYYY-MM-DD */
  endDate: string;
}

export interface PersonRow {
  id: number;
  name: string;
  role: string | null;
  groupId: number | null;
  active: boolean;
}

export interface SalaryRow {
  personId: number;
  year: number;
  annualCost: number;
}

/** Under-funded, funded to the cent, or funded beyond cost. */
export type CoverageState = "under" | "covered" | "over";

export interface Coverage {
  cost: number;
  funded: number;
  /** Shortfall, never negative — an overage lives in `overfunded`. */
  uncovered: number;
  /** Excess funding, never negative. */
  overfunded: number;
  /** 0 when there is no cost, never NaN or Infinity. */
  percentCovered: number;
  state: CoverageState;
  /** False when the person has no salary row at all for this year — distinct
   *  from a salary that is genuinely 0. */
  hasSalary: boolean;
}

export interface GroupCoverage extends Coverage {
  memberCount: number;
  /** Funding attached to the pool itself. */
  pooledFunded: number;
  /** Funding attached to individual members by name. */
  namedFunded: number;
  /** Members with no salary row for this year — surfaced rather than silently
   *  contributing 0, which is the failure mode this module exists to prevent. */
  membersMissingSalary: string[];
}

/** Amounts within half a cent of each other are the same amount. */
const EPSILON = 0.005;

// ---------------------------------------------------------------------------
// Month spans and per-year proration
// ---------------------------------------------------------------------------

/**
 * Inclusive month span of an allocation, as YYYY-MM-01 strings. Empty when the
 * end precedes the start, which makes every downstream sum fall to 0 rather
 * than going negative.
 */
export function allocationMonths(a: Pick<AllocationRow, "startDate" | "endDate">): string[] {
  if (!a.startDate || !a.endDate) return [];
  const start = `${a.startDate.slice(0, 7)}-01`;
  const end = `${a.endDate.slice(0, 7)}-01`;
  if (end < start) return [];
  return monthSequence(start, end);
}

/** Even monthly spread — the semantics the spreadsheet already implies. */
export function monthlyAmount(a: AllocationRow): number {
  const months = allocationMonths(a);
  if (months.length === 0) return 0;
  return a.amount / months.length;
}

/**
 * The part of an allocation that lands in one calendar year. Summing this over
 * every year the allocation touches returns the full amount.
 */
export function fundedInYear(a: AllocationRow, year: number): number {
  const months = allocationMonths(a);
  if (months.length === 0) return 0;
  const prefix = String(year);
  const inYear = months.filter((m) => m.startsWith(prefix)).length;
  if (inYear === 0) return 0;
  return (a.amount / months.length) * inYear;
}

/**
 * What fraction of a salary this line covers, monthly rate against monthly
 * salary. This is the "25%" / "50%" the spreadsheet keeps as a hand-typed note,
 * turned into something that can be checked. Null when there is no salary to
 * compare against (including group-targeted lines).
 */
export function shareOfSalary(a: AllocationRow, annualCost: number | null): number | null {
  if (annualCost == null || annualCost <= 0) return null;
  const perMonth = monthlyAmount(a);
  if (perMonth === 0) return null;
  return perMonth / (annualCost / 12);
}

// ---------------------------------------------------------------------------
// Salary lookup
// ---------------------------------------------------------------------------

/** The salary row for exactly this year. Null when absent — no fallback, so a
 *  missing year reads as missing rather than as last year's figure. */
export function salaryForYear(
  salaries: SalaryRow[],
  personId: number,
  year: number
): number | null {
  const row = salaries.find((s) => s.personId === personId && s.year === year);
  return row ? row.annualCost : null;
}

/**
 * Salary in effect during a given month, falling back to the most recent
 * EARLIER year on file. Used for the chart's cost reference line, which steps
 * at year boundaries; never used for the rollup tables, where a missing year
 * must stay visible as missing.
 */
export function salaryForMonth(
  salaries: SalaryRow[],
  personId: number,
  month: string
): number | null {
  const year = Number(month.slice(0, 4));
  const candidates = salaries
    .filter((s) => s.personId === personId && s.year <= year)
    .sort((a, b) => b.year - a.year);
  return candidates.length > 0 ? candidates[0].annualCost : null;
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

function buildCoverage(cost: number, funded: number, hasSalary: boolean): Coverage {
  const delta = cost - funded;
  const state: CoverageState =
    Math.abs(delta) < EPSILON ? "covered" : delta > 0 ? "under" : "over";

  return {
    cost,
    funded,
    uncovered: state === "under" ? delta : 0,
    overfunded: state === "over" ? -delta : 0,
    percentCovered: cost > 0 ? funded / cost : 0,
    state,
    hasSalary,
  };
}

/** One person's year: their own salary against the lines that name them.
 *  Pooled group funding is deliberately excluded — it can't be attributed to an
 *  individual, so the group row is where it shows up. */
export function personCoverage(
  p: PersonRow,
  salaries: SalaryRow[],
  allocations: AllocationRow[],
  year: number
): Coverage {
  const annual = salaryForYear(salaries, p.id, year);
  const funded = allocations
    .filter((a) => a.personId === p.id)
    .reduce((sum, a) => sum + fundedInYear(a, year), 0);

  return buildCoverage(annual ?? 0, funded, annual != null);
}

/**
 * One group's year. Cost is the sum of active members' salaries; funded counts
 * both the pool's own lines and lines naming its members, since both pay for
 * the same people.
 */
export function groupCoverage(
  groupId: number,
  allPeople: PersonRow[],
  salaries: SalaryRow[],
  allocations: AllocationRow[],
  year: number
): GroupCoverage {
  const members = allPeople.filter((p) => p.groupId === groupId && p.active);
  const memberIds = new Set(members.map((m) => m.id));

  let cost = 0;
  const membersMissingSalary: string[] = [];
  for (const m of members) {
    const annual = salaryForYear(salaries, m.id, year);
    if (annual == null) membersMissingSalary.push(m.name);
    else cost += annual;
  }

  let pooledFunded = 0;
  let namedFunded = 0;
  for (const a of allocations) {
    if (a.groupId === groupId) pooledFunded += fundedInYear(a, year);
    else if (a.personId != null && memberIds.has(a.personId)) {
      namedFunded += fundedInYear(a, year);
    }
  }

  const base = buildCoverage(cost, pooledFunded + namedFunded, members.length > 0);
  return {
    ...base,
    memberCount: members.length,
    pooledFunded,
    namedFunded,
    membersMissingSalary,
  };
}

/**
 * Everyone, for one year. Cost sums every active person's salary once; funded
 * sums every allocation once, regardless of whether it names a person or a
 * pool. Group rows are a view over these same numbers, never an addition to
 * them — which is what keeps the total from double-counting.
 */
export function grandTotal(
  allPeople: PersonRow[],
  salaries: SalaryRow[],
  allocations: AllocationRow[],
  year: number
): Coverage {
  const active = allPeople.filter((p) => p.active);

  let cost = 0;
  let anySalary = false;
  for (const p of active) {
    const annual = salaryForYear(salaries, p.id, year);
    if (annual != null) {
      cost += annual;
      anySalary = true;
    }
  }

  const funded = allocations.reduce((sum, a) => sum + fundedInYear(a, year), 0);
  return buildCoverage(cost, funded, anySalary);
}
