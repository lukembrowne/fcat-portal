/**
 * Pure coercion helpers for the grants xlsx importer. Extracted so they're
 * unit-testable without executing the importer's main().
 */
import type { GrantStatus, FunderPriority } from "@/db/schema";

/** Excel serial day-number → JS Date (UTC). 25569 = days from 1899-12-30 to 1970-01-01. */
export function excelSerialToDate(serial: number): Date {
  return new Date(Math.round((serial - 25569) * 86400 * 1000));
}

/** Any cell value → Unix SECONDS (Drizzle timestamp mode) or null. */
export function parseDateToSeconds(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return Math.floor(v.getTime() / 1000);
  if (typeof v === "number" && isFinite(v)) {
    if (v <= 0) return null;
    return Math.floor(excelSerialToDate(v).getTime() / 1000);
  }
  const s = String(v).trim();
  if (!s) return null;
  // Handle M/D/YYYY explicitly as UTC FIRST — `new Date("8/1/2026")` would parse
  // in the container's local (Eastern) tz and drift the calendar day.
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const d = new Date(Date.UTC(parseInt(m[3], 10), parseInt(m[1], 10) - 1, parseInt(m[2], 10)));
    if (!isNaN(d.getTime())) return Math.floor(d.getTime() / 1000);
  }
  // ISO date-only ("2026-08-01") parses as UTC midnight per spec; ISO datetimes carry their own tz.
  const native = new Date(s).getTime();
  if (!isNaN(native)) return Math.floor(native / 1000);
  return null;
}

/** Currency-ish string/number → number (USD) or null. Never NaN/0-on-garbage. */
export function parseAmount(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return isFinite(v) ? v : null;
  const cleaned = String(v).replace(/[^0-9.-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === ".") return null;
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

export function parseDays(v: unknown): number {
  if (v === null || v === undefined || v === "") return 14;
  const n = parseInt(String(v).replace(/[^0-9-]/g, ""), 10);
  return isNaN(n) || n < 0 ? 14 : n;
}

const GRANT_STATUS_MAP: Record<string, GrantStatus> = {
  "to research": "to_research",
  "in prep": "in_prep",
  "pending decision": "pending_decision",
  funded: "funded",
  rejected: "rejected",
  passed: "passed",
  completed: "completed",
};
export function mapStatus(v: unknown): GrantStatus {
  const s = String(v ?? "").toLowerCase().trim();
  return GRANT_STATUS_MAP[s] ?? "to_research";
}

const PRIORITY_MAP: Record<string, FunderPriority> = {
  highest: "highest",
  high: "high",
  medium: "medium",
  low: "low",
};
export function mapPriority(v: unknown): FunderPriority | null {
  const s = String(v ?? "").toLowerCase().trim();
  return PRIORITY_MAP[s] ?? null;
}
