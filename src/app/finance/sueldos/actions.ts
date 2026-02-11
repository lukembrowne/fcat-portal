"use server";

import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import {
  financeTransactions,
  financeSueldosGrants,
  financeSueldosTotals,
} from "@/db/schema";
import { sql } from "drizzle-orm";
import type { ActionResult } from "@/lib/types";
import { SUELDO_CATEGORIES } from "../constants";
import { monthSequence } from "../lib/calculations";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SueldosData {
  /** Total actual sueldo spend in the date range */
  totalSpent: number;
  /** Per-person monthly breakdown (for stacked bar charts) */
  personData: PersonPanel[];
}

export interface PersonPanel {
  person: string;
  monthlyCost: number;
  months: {
    month: string; // YYYY-MM-01
    sources: { source: string; amount: number }[];
    totalFunded: number;
  }[];
}

// ---------------------------------------------------------------------------
// Fetch sueldos data
// ---------------------------------------------------------------------------

export async function fetchSueldosData(
  from: string,
  to: string,
  grantStatusFilter: "all" | "funded" | "pending" = "all"
): Promise<ActionResult<SueldosData>> {
  await requirePermission("finance", "viewer");

  try {
    // 1. Total actual sueldo spend from transactions
    const sueldoCategoryList = SUELDO_CATEGORIES.map((c) => `'${c}'`).join(",");
    const totalRow = db
      .select({ total: sql<number>`COALESCE(SUM(debe), 0)` })
      .from(financeTransactions)
      .where(
        sql`tx_type = 'expense' AND cuenta_nombre IN (${sql.raw(sueldoCategoryList)}) AND fecha >= ${from} AND fecha <= ${to}`
      )
      .get();

    // 2. Get all grant rows
    const grants = db
      .select({
        person: financeSueldosGrants.person,
        source: financeSueldosGrants.source,
        status: financeSueldosGrants.status,
        amount: financeSueldosGrants.amount,
        startDate: financeSueldosGrants.startDate,
        endDate: financeSueldosGrants.endDate,
      })
      .from(financeSueldosGrants)
      .all();

    // 3. Get sueldos totals (monthly cost per person)
    const totals = db
      .select({
        person: financeSueldosTotals.person,
        monthlyCost: financeSueldosTotals.monthlyCost,
      })
      .from(financeSueldosTotals)
      .all();

    const monthlyCostMap = new Map(totals.map((t) => [t.person, t.monthlyCost]));

    // 4. Expand grants into monthly amounts per person
    //    For each grant, divide total amount by number of months in range
    type ExpandedRow = {
      person: string;
      month: string;
      source: string;
      amount: number;
    };

    const expanded: ExpandedRow[] = [];
    for (const g of grants) {
      // Apply grant status filter
      if (grantStatusFilter !== "all" && g.status !== grantStatusFilter) continue;

      const months = monthSequence(
        g.startDate.slice(0, 7) + "-01",
        g.endDate.slice(0, 7) + "-01"
      );
      if (months.length === 0) continue;
      const monthlyAmount = g.amount / months.length;
      for (const m of months) {
        expanded.push({
          person: g.person,
          month: m,
          source: g.source,
          amount: monthlyAmount,
        });
      }
    }

    // 5. Build per-person panels
    //    Get all unique persons from totals (so even unfunded people show up)
    const allPersons = totals.map((t) => t.person);

    // Determine month range: from earliest grant start to 2 years out
    const now = new Date();
    const futureEnd = `${now.getFullYear() + 2}-12-01`;
    const allMonths = monthSequence(
      `${now.getFullYear()}-01-01`,
      futureEnd
    );

    // Build person panels
    const personPanels: PersonPanel[] = [];

    // First build individual person panels
    for (const person of allPersons) {
      const monthlyCost = monthlyCostMap.get(person) || 0;
      const personExpanded = expanded.filter((e) => e.person === person);

      const months = allMonths.map((m) => {
        const sources = personExpanded
          .filter((e) => e.month === m)
          .reduce<Map<string, number>>((acc, e) => {
            acc.set(e.source, (acc.get(e.source) || 0) + e.amount);
            return acc;
          }, new Map());

        const sourceArr = Array.from(sources.entries()).map(([source, amount]) => ({
          source,
          amount,
        }));
        const totalFunded = sourceArr.reduce((s, x) => s + x.amount, 0);

        return { month: m, sources: sourceArr, totalFunded };
      });

      personPanels.push({ person, monthlyCost, months });
    }

    // Build "Total" panel: aggregate all persons
    if (personPanels.length > 0) {
      const totalMonthlyCost = totals.reduce((s, t) => s + t.monthlyCost, 0);
      const totalMonths = allMonths.map((m) => {
        // Collect all sources across all people for this month
        const sourceMap = new Map<string, number>();
        for (const pp of personPanels) {
          const monthData = pp.months.find((x) => x.month === m);
          if (monthData) {
            for (const s of monthData.sources) {
              sourceMap.set(s.source, (sourceMap.get(s.source) || 0) + s.amount);
            }
          }
        }
        const sourceArr = Array.from(sourceMap.entries()).map(([source, amount]) => ({
          source,
          amount,
        }));
        const totalFunded = sourceArr.reduce((s, x) => s + x.amount, 0);
        return { month: m, sources: sourceArr, totalFunded };
      });

      personPanels.unshift({
        person: "Total",
        monthlyCost: totalMonthlyCost,
        months: totalMonths,
      });
    }

    return {
      success: true,
      data: {
        totalSpent: totalRow?.total ?? 0,
        personData: personPanels,
      },
    };
  } catch (e) {
    return {
      success: false,
      error: `Error al cargar datos de sueldos: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
