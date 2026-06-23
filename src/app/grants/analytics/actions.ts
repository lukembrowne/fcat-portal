"use server";

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { grants, funders, type GrantStatus } from "@/db/schema";
import { requirePermission } from "@/lib/auth";
import {
  GRANT_SUCCESS_DENOMINATOR_STATUSES,
  GRANT_STATUS_ORDER,
  TOTAL_KEY,
  NO_DATE_KEY,
} from "@/lib/grants/constants";

const PROJECT = "grants";
// Success-rate denominator: grants we applied to and got a verdict on. Excludes
// "passed" (opportunities we chose not to pursue).
const DECIDED = new Set<GrantStatus>(GRANT_SUCCESS_DENOMINATOR_STATUSES);

export interface FunderRow {
  funderId: number;
  name: string;
  total: number;
  funded: number;
  decided: number;
  hitRate: number | null;
  totalRequested: number;
}

export interface StageYearMatrix {
  years: string[]; // column order: real years desc, then "No date" if present
  statuses: GrantStatus[]; // row order (GRANT_STATUS_ORDER)
  counts: Record<GrantStatus, Record<string, number>>; // counts[status][year]; includes TOTAL_KEY
  totalsByYear: Record<string, number>; // column totals across all stages; includes TOTAL_KEY
  successByYear: Record<string, number | null>; // per-year success rate; includes TOTAL_KEY
}

export interface GrantAnalytics {
  matrix: StageYearMatrix;
  byFunder: FunderRow[];
}

export async function getGrantAnalytics(): Promise<GrantAnalytics> {
  await requirePermission(PROJECT, "viewer");

  const rows = db
    .select({
      status: grants.status,
      dueDate: grants.dueDate,
      amountRequested: grants.amountRequested,
      funderId: grants.funderId,
      funderName: funders.name,
    })
    .from(grants)
    .leftJoin(funders, eq(grants.funderId, funders.id))
    .all();

  // --- Stage × year matrix (year = UTC year of due_date; null → "No date") ---
  const counts = {} as Record<GrantStatus, Record<string, number>>;
  for (const s of GRANT_STATUS_ORDER) counts[s] = { [TOTAL_KEY]: 0 };
  const realYears = new Set<string>();
  let hasNoDate = false;

  const funderMap = new Map<number, FunderRow>();

  for (const r of rows) {
    const yKey = r.dueDate ? String(r.dueDate.getUTCFullYear()) : NO_DATE_KEY;
    if (r.dueDate) realYears.add(yKey);
    else hasNoDate = true;

    const row = counts[r.status];
    row[yKey] = (row[yKey] ?? 0) + 1;
    row[TOTAL_KEY]++;

    // by funder (only linked grants)
    if (r.funderId != null) {
      const amt = r.amountRequested ?? 0;
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

  const years = [...realYears].sort((a, b) => Number(b) - Number(a));
  if (hasNoDate) years.push(NO_DATE_KEY);
  const yearKeys = [...years, TOTAL_KEY];

  // Column totals + per-year success rate.
  // wins = funded + completed; decided = wins + rejected (NOT passed); rate = wins / decided.
  const totalsByYear: Record<string, number> = {};
  const successByYear: Record<string, number | null> = {};
  for (const y of yearKeys) {
    const total = GRANT_STATUS_ORDER.reduce((sum, s) => sum + (counts[s][y] ?? 0), 0);
    totalsByYear[y] = total;

    const wins = (counts.funded[y] ?? 0) + (counts.completed[y] ?? 0);
    const decided = wins + (counts.rejected[y] ?? 0);
    successByYear[y] = decided > 0 ? wins / decided : null;
  }

  const byFunder = [...funderMap.values()]
    .map((f) => ({ ...f, hitRate: f.decided > 0 ? f.funded / f.decided : null }))
    .sort((a, b) => b.total - a.total || b.totalRequested - a.totalRequested);

  return {
    matrix: {
      years,
      statuses: GRANT_STATUS_ORDER,
      counts,
      totalsByYear,
      successByYear,
    },
    byFunder,
  };
}
