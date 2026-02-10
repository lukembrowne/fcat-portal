"use server";

import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import { financeTransactions } from "@/db/schema";
import { sql } from "drizzle-orm";
import type { ActionResult } from "@/lib/types";

export interface AnnualSummaryRow {
  year: number;
  totalRevenue: number;
  totalExpenses: number;
}

export interface MonthlyByYear {
  year: number;
  month: number;
  amount: number;
}

export interface CategoryByYear {
  year: number;
  category: string;
  amount: number;
}

export interface AnnualData {
  annualSummary: AnnualSummaryRow[];
  monthlyRevenue: MonthlyByYear[];
  monthlyExpenses: MonthlyByYear[];
  expensesByCategory: CategoryByYear[];
}

export async function fetchAnnualData(): Promise<ActionResult<AnnualData>> {
  await requirePermission("finance", "viewer");

  try {
    // Annual summary: total revenue and expenses per year
    const revenueByYear = db
      .select({
        year: financeTransactions.year,
        total: sql<number>`COALESCE(SUM(haber), 0)`,
      })
      .from(financeTransactions)
      .where(sql`tx_type = 'revenue'`)
      .groupBy(financeTransactions.year)
      .orderBy(financeTransactions.year)
      .all();

    const expensesByYear = db
      .select({
        year: financeTransactions.year,
        total: sql<number>`COALESCE(SUM(debe), 0)`,
      })
      .from(financeTransactions)
      .where(sql`tx_type = 'expense'`)
      .groupBy(financeTransactions.year)
      .orderBy(financeTransactions.year)
      .all();

    // Collect all years from both revenue and expenses
    const yearSet = new Set<number>();
    for (const r of revenueByYear) yearSet.add(r.year);
    for (const e of expensesByYear) yearSet.add(e.year);
    const years = [...yearSet].sort((a, b) => a - b);

    const revenueMap = new Map(revenueByYear.map((r) => [r.year, r.total]));
    const expenseMap = new Map(expensesByYear.map((e) => [e.year, e.total]));

    const annualSummary: AnnualSummaryRow[] = years.map((year) => ({
      year,
      totalRevenue: revenueMap.get(year) ?? 0,
      totalExpenses: expenseMap.get(year) ?? 0,
    }));

    // Monthly revenue by year
    const monthlyRevenue = db
      .select({
        year: financeTransactions.year,
        month: financeTransactions.month,
        amount: sql<number>`COALESCE(SUM(haber), 0)`,
      })
      .from(financeTransactions)
      .where(sql`tx_type = 'revenue'`)
      .groupBy(financeTransactions.year, financeTransactions.month)
      .orderBy(financeTransactions.year, financeTransactions.month)
      .all();

    // Monthly expenses by year
    const monthlyExpenses = db
      .select({
        year: financeTransactions.year,
        month: financeTransactions.month,
        amount: sql<number>`COALESCE(SUM(debe), 0)`,
      })
      .from(financeTransactions)
      .where(sql`tx_type = 'expense'`)
      .groupBy(financeTransactions.year, financeTransactions.month)
      .orderBy(financeTransactions.year, financeTransactions.month)
      .all();

    // Expenses by category by year
    const expensesByCategory = db
      .select({
        year: financeTransactions.year,
        category: financeTransactions.cuentaNombre,
        amount: sql<number>`COALESCE(SUM(debe), 0)`,
      })
      .from(financeTransactions)
      .where(sql`tx_type = 'expense'`)
      .groupBy(financeTransactions.year, financeTransactions.cuentaNombre)
      .orderBy(financeTransactions.year, sql`SUM(debe) DESC`)
      .all();

    return {
      success: true,
      data: {
        annualSummary,
        monthlyRevenue,
        monthlyExpenses,
        expensesByCategory,
      },
    };
  } catch (e) {
    return {
      success: false,
      error: `Error al cargar datos anuales: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
