"use server";

import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import { financeTransactions } from "@/db/schema";
import { sql } from "drizzle-orm";
import type { ActionResult } from "@/lib/types";
import type { MonthlyAmount, CategoryAmount } from "../types";

export interface ExpenseData {
  totalExpenses: number;
  byCategory: CategoryAmount[];
  byMonth: MonthlyAmount[];
  pivotData: {
    category: string;
    months: Record<string, number>;
    total: number;
    avgMonthly: number;
  }[];
  transactions: {
    fecha: string;
    cuentaNombre: string;
    asiento: string;
    detalle: string | null;
    actor: string | null;
    centrosDeIngreso: string | null;
    debe: number;
  }[];
}

export async function fetchExpenseData(
  from: string,
  to: string
): Promise<ActionResult<ExpenseData>> {
  await requirePermission("finance", "viewer");

  try {
    // Total expenses
    const totalRow = db
      .select({ total: sql<number>`COALESCE(SUM(debe), 0)` })
      .from(financeTransactions)
      .where(
        sql`tx_type = 'expense' AND fecha >= ${from} AND fecha <= ${to}`
      )
      .get();

    // Expenses by category
    const byCategory = db
      .select({
        category: financeTransactions.cuentaNombre,
        amount: sql<number>`SUM(debe)`,
      })
      .from(financeTransactions)
      .where(
        sql`tx_type = 'expense' AND fecha >= ${from} AND fecha <= ${to}`
      )
      .groupBy(financeTransactions.cuentaNombre)
      .orderBy(sql`SUM(debe) DESC`)
      .all();

    // Expenses by month
    const byMonth = db
      .select({
        yearMonth: financeTransactions.yearMonth,
        amount: sql<number>`SUM(debe)`,
      })
      .from(financeTransactions)
      .where(
        sql`tx_type = 'expense' AND fecha >= ${from} AND fecha <= ${to}`
      )
      .groupBy(financeTransactions.yearMonth)
      .orderBy(financeTransactions.yearMonth)
      .all();

    // Pivot data: expenses by category x month
    const pivotRows = db
      .select({
        category: financeTransactions.cuentaNombre,
        yearMonth: financeTransactions.yearMonth,
        amount: sql<number>`SUM(debe)`,
      })
      .from(financeTransactions)
      .where(
        sql`tx_type = 'expense' AND fecha >= ${from} AND fecha <= ${to}`
      )
      .groupBy(financeTransactions.cuentaNombre, financeTransactions.yearMonth)
      .orderBy(financeTransactions.cuentaNombre, financeTransactions.yearMonth)
      .all();

    // Build pivot map: category -> { months, total }
    const pivotMap = new Map<
      string,
      { months: Record<string, number>; total: number }
    >();
    for (const row of pivotRows) {
      if (!pivotMap.has(row.category)) {
        pivotMap.set(row.category, { months: {}, total: 0 });
      }
      const entry = pivotMap.get(row.category)!;
      entry.months[row.yearMonth] = row.amount;
      entry.total += row.amount;
    }

    // Collect all unique months for avgMonthly calculation
    const allMonths = new Set<string>();
    for (const row of pivotRows) {
      allMonths.add(row.yearMonth);
    }
    const monthCount = allMonths.size || 1;

    const pivotData = Array.from(pivotMap.entries())
      .map(([category, { months, total }]) => ({
        category,
        months,
        total,
        avgMonthly: total / monthCount,
      }))
      .sort((a, b) => b.total - a.total);

    // Individual transactions
    const transactions = db
      .select({
        fecha: financeTransactions.fecha,
        cuentaNombre: financeTransactions.cuentaNombre,
        asiento: financeTransactions.asiento,
        detalle: financeTransactions.detalle,
        actor: financeTransactions.actor,
        centrosDeIngreso: financeTransactions.centrosDeIngreso,
        debe: financeTransactions.debe,
      })
      .from(financeTransactions)
      .where(
        sql`tx_type = 'expense' AND fecha >= ${from} AND fecha <= ${to}`
      )
      .orderBy(sql`fecha DESC`)
      .all();

    return {
      success: true,
      data: {
        totalExpenses: totalRow?.total ?? 0,
        byCategory,
        byMonth,
        pivotData,
        transactions,
      },
    };
  } catch (e) {
    return {
      success: false,
      error: `Error al cargar datos de gastos: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
