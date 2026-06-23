"use server";

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { grants, funders, type GrantStatus } from "@/db/schema";
import { requirePermission } from "@/lib/auth";
import { FORECAST_WEIGHTS, GRANT_DECIDED_STATUSES } from "@/lib/grants/constants";

const PROJECT = "grants";
const DECIDED = new Set<GrantStatus>(GRANT_DECIDED_STATUSES);

export interface YearRow {
  year: string; // "2026" or "Sin fecha"
  total: number;
  funded: number;
  decided: number;
  winRate: number | null;
  totalRequested: number;
  totalAwarded: number;
}

export interface FunderRow {
  funderId: number;
  name: string;
  total: number;
  funded: number;
  decided: number;
  hitRate: number | null;
  totalRequested: number;
}

export interface ForecastRow {
  status: GrantStatus;
  count: number;
  sumRequested: number;
  weighted: number;
}

export interface GrantAnalytics {
  byYear: YearRow[];
  byFunder: FunderRow[];
  forecast: { rows: ForecastRow[]; totalWeighted: number; activeRequested: number };
}

export async function getGrantAnalytics(): Promise<GrantAnalytics> {
  await requirePermission(PROJECT, "viewer");

  const rows = db
    .select({
      status: grants.status,
      dueDate: grants.dueDate,
      amountRequested: grants.amountRequested,
      amountAwarded: grants.amountAwarded,
      funderId: grants.funderId,
      funderName: funders.name,
    })
    .from(grants)
    .leftJoin(funders, eq(grants.funderId, funders.id))
    .all();

  // --- By year (UTC year of due_date; null → "Sin fecha") ---
  const yearMap = new Map<string, YearRow>();
  const forecastMap = new Map<GrantStatus, ForecastRow>();
  const funderMap = new Map<number, FunderRow>();
  let totalWeighted = 0;
  let activeRequested = 0;

  for (const r of rows) {
    const amt = r.amountRequested ?? 0;
    const awarded = r.amountAwarded ?? 0;

    const yKey = r.dueDate ? String(r.dueDate.getUTCFullYear()) : "No date";
    let y = yearMap.get(yKey);
    if (!y) {
      y = { year: yKey, total: 0, funded: 0, decided: 0, winRate: null, totalRequested: 0, totalAwarded: 0 };
      yearMap.set(yKey, y);
    }
    y.total++;
    y.totalRequested += amt;
    y.totalAwarded += awarded;
    if (DECIDED.has(r.status)) y.decided++;
    if (r.status === "funded" || r.status === "completed") y.funded++;

    // forecast
    let f = forecastMap.get(r.status);
    if (!f) {
      f = { status: r.status, count: 0, sumRequested: 0, weighted: 0 };
      forecastMap.set(r.status, f);
    }
    f.count++;
    f.sumRequested += amt;
    const w = FORECAST_WEIGHTS[r.status] ?? 0;
    f.weighted += amt * w;
    totalWeighted += amt * w;
    if (r.status === "in_prep" || r.status === "pending_decision") activeRequested += amt;

    // by funder (only linked grants)
    if (r.funderId != null) {
      let fr = funderMap.get(r.funderId);
      if (!fr) {
        fr = {
          funderId: r.funderId,
          name: r.funderName ?? `#${r.funderId}`,
          total: 0,
          funded: 0,
          decided: 0,
          hitRate: null,
          totalRequested: 0,
        };
        funderMap.set(r.funderId, fr);
      }
      fr.total++;
      fr.totalRequested += amt;
      if (DECIDED.has(r.status)) fr.decided++;
      if (r.status === "funded" || r.status === "completed") fr.funded++;
    }
  }

  const byYear = [...yearMap.values()].map((y) => ({
    ...y,
    winRate: y.decided > 0 ? y.funded / y.decided : null,
  }));
  // Real years descending; "Sin fecha" last.
  byYear.sort((a, b) => {
    if (a.year === "No date") return 1;
    if (b.year === "No date") return -1;
    return Number(b.year) - Number(a.year);
  });

  const byFunder = [...funderMap.values()]
    .map((f) => ({ ...f, hitRate: f.decided > 0 ? f.funded / f.decided : null }))
    .sort((a, b) => b.total - a.total || b.totalRequested - a.totalRequested);

  // Forecast rows in pipeline order.
  const ORDER: GrantStatus[] = [
    "to_research", "in_prep", "pending_decision", "funded", "rejected", "passed", "completed",
  ];
  const forecastRows = ORDER.map(
    (s) => forecastMap.get(s) ?? { status: s, count: 0, sumRequested: 0, weighted: 0 }
  );

  return {
    byYear,
    byFunder,
    forecast: { rows: forecastRows, totalWeighted, activeRequested },
  };
}
