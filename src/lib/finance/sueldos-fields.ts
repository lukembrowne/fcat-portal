/**
 * Client-safe constants and formatters for salary planning (/finance/sueldos).
 *
 * Lives outside the `"use server"` actions file on purpose: a `"use server"`
 * module may only export async functions, and a type re-export there
 * mis-compiles into a runtime action export under Turbopack (a 138-error
 * cascade across every page). Both the actions and the client cells import
 * from here instead.
 *
 * No runtime imports from the Drizzle schema — type-only, so this is safe in
 * Client Components.
 */

import type { FinanceFundingStatus } from "@/db/schema";

/** The four row kinds the page can edit inline. */
export type SueldoEntity = "person" | "salary" | "source" | "allocation";

/**
 * Fields each inline editor may write. Whitelisted so a crafted call can't
 * reach columns the table doesn't expose (id, createdAt, …) — same rationale as
 * EDITABLE_GRANT_FIELDS.
 */
export const EDITABLE_PERSON_FIELDS = ["name", "role", "groupId", "active", "notes"] as const;
export type EditablePersonField = (typeof EDITABLE_PERSON_FIELDS)[number];

export const EDITABLE_SOURCE_FIELDS = [
  "name",
  "status",
  "defaultStartDate",
  "defaultEndDate",
  "notes",
] as const;
export type EditableSourceField = (typeof EDITABLE_SOURCE_FIELDS)[number];

export const EDITABLE_ALLOCATION_FIELDS = [
  "sourceId",
  "personId",
  "groupId",
  "amount",
  "startDate",
  "endDate",
  "notes",
] as const;
export type EditableAllocationField = (typeof EDITABLE_ALLOCATION_FIELDS)[number];

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * The planning flag on a funding source. Deliberately two-valued — this is NOT
 * the seven-state grants pipeline, and the two modules are not linked.
 */
export const FUNDING_STATUS_LABELS: Record<FinanceFundingStatus, string> = {
  funded: "Financiado",
  pending: "Pendiente",
};

export const FUNDING_STATUS_COLORS: Record<FinanceFundingStatus, string> = {
  funded: "bg-green-100 text-green-800",
  pending: "bg-amber-100 text-amber-800",
};

export const FUNDING_STATUS_ORDER: FinanceFundingStatus[] = ["funded", "pending"];

/** Page-level filter over source status. */
export type FundingStatusFilter = "all" | FinanceFundingStatus;

export const STATUS_FILTER_LABELS: Record<FundingStatusFilter, string> = {
  all: "Todos",
  funded: "Solo financiado",
  pending: "Solo pendiente",
};

export function isFundingStatusFilter(v: string): v is FundingStatusFilter {
  return v === "all" || v === "funded" || v === "pending";
}

// ---------------------------------------------------------------------------
// Formatters (Spanish finance UI)
// ---------------------------------------------------------------------------

export function formatMoney(v: number | null | undefined, decimals = 2): string {
  if (v == null) return "—";
  return (
    "$" +
    v.toLocaleString("en-US", {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })
  );
}

/** Whole dollars — for axis ticks and dense table columns. */
export function formatMoney0(v: number | null | undefined): string {
  return formatMoney(v, 0);
}

export function formatPercent(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${Math.round(v * 100)}%`;
}

const MONTHS_ES = [
  "ene", "feb", "mar", "abr", "may", "jun",
  "jul", "ago", "sep", "oct", "nov", "dic",
];

/** "2026-06-30" → "jun 2026". Date-only strings, formatted without a Date
 *  round-trip so the container's timezone can't shift the month. */
export function formatMonthYear(iso: string | null | undefined): string {
  if (!iso || iso.length < 7) return "—";
  const m = parseInt(iso.slice(5, 7), 10) - 1;
  if (m < 0 || m > 11) return "—";
  return `${MONTHS_ES[m]} ${iso.slice(0, 4)}`;
}

/** "2026-06-30" → "30 jun 2026". Same no-Date-round-trip rule. */
export function formatDateEs(iso: string | null | undefined): string {
  if (!iso || iso.length < 10) return "—";
  const m = parseInt(iso.slice(5, 7), 10) - 1;
  if (m < 0 || m > 11) return "—";
  return `${iso.slice(8, 10)} ${MONTHS_ES[m]} ${iso.slice(0, 4)}`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** True for a well-formed YYYY-MM-DD that names a real calendar day. */
export function isIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** Planning horizon guard — catches a mistyped year before it lands in a total. */
export const MIN_PLANNING_YEAR = 2000;
export const MAX_PLANNING_YEAR = 2100;

export function isPlanningYear(y: number): boolean {
  return Number.isInteger(y) && y >= MIN_PLANNING_YEAR && y <= MAX_PLANNING_YEAR;
}
