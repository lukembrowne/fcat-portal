/**
 * Client-safe constants + formatters for the grant tracking module.
 * No runtime imports from the Drizzle schema (type-only) — safe in Client Components.
 *
 * NOTE: The grant tracking module is intentionally in ENGLISH (a deliberate exception
 * to the portal's Spanish-UI convention) so it can be shared with English-speaking
 * collaborators. Do not "fix" these strings back to Spanish.
 */
import type { GrantStatus, FunderPriority } from "@/db/schema";

export const GRANT_STATUS_LABELS: Record<GrantStatus, string> = {
  to_research: "To Research",
  in_prep: "In Preparation",
  pending_decision: "Pending Decision",
  funded: "Funded",
  rejected: "Rejected",
  passed: "Passed",
  completed: "Completed",
};

export const GRANT_STATUS_COLORS: Record<GrantStatus, string> = {
  to_research: "bg-slate-100 text-slate-800",
  in_prep: "bg-blue-100 text-blue-800",
  pending_decision: "bg-yellow-100 text-yellow-800",
  funded: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
  passed: "bg-gray-100 text-gray-600",
  completed: "bg-emerald-100 text-emerald-800",
};

/** Pipeline order for selects + status columns. */
export const GRANT_STATUS_ORDER: GrantStatus[] = [
  "to_research",
  "in_prep",
  "pending_decision",
  "funded",
  "rejected",
  "passed",
  "completed",
];

/** Statuses considered decided (no longer active in the pipeline). */
export const GRANT_DECIDED_STATUSES: GrantStatus[] = [
  "funded",
  "rejected",
  "passed",
  "completed",
];

export const FUNDER_PRIORITY_LABELS: Record<FunderPriority, string> = {
  highest: "Highest",
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** Stage weights for the pipeline forecast (expected value). */
export const FORECAST_WEIGHTS: Record<GrantStatus, number> = {
  to_research: 0,
  in_prep: 0.2,
  pending_decision: 0.5,
  funded: 1,
  rejected: 0,
  passed: 0,
  completed: 0,
};

export function formatUsd(amount: number | null | undefined): string {
  if (amount == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatDate(d: Date | null | undefined): string {
  if (!d) return "—";
  // Date-only fields are stored at UTC midnight; format in UTC to avoid day drift.
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Date + time, e.g. "Jun 22, 2026, 8:43 PM" (local time). For audit subtext. */
export function formatDateTime(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Date → "YYYY-MM-DD" (UTC) for <input type="date"> values. */
export function toDateInput(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

/** Whole days from now until `due` (negative = overdue). null if no date. */
export function daysUntil(due: Date | null | undefined, now: Date = new Date()): number | null {
  if (!due) return null;
  return Math.round((due.getTime() - now.getTime()) / 86_400_000);
}
