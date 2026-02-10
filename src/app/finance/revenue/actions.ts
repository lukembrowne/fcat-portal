"use server";

import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import { financeTransactions } from "@/db/schema";
import { sql } from "drizzle-orm";
import type { ActionResult } from "@/lib/types";
import type { MonthlyAmount, CategoryAmount } from "../types";

export interface RevenueData {
  totalRevenue: number;
  byCategory: CategoryAmount[];
  byMonth: MonthlyAmount[];
  transactions: {
    fecha: string;
    cuentaNombre: string;
    asiento: string;
    detalle: string | null;
    actor: string | null;
    centrosDeIngreso: string | null;
    haber: number;
  }[];
}

export async function fetchRevenueData(
  from: string,
  to: string
): Promise<ActionResult<RevenueData>> {
  await requirePermission("finance", "viewer");

  try {
    // Total revenue
    const totalRow = db
      .select({ total: sql<number>`COALESCE(SUM(haber), 0)` })
      .from(financeTransactions)
      .where(
        sql`tx_type = 'revenue' AND fecha >= ${from} AND fecha <= ${to}`
      )
      .get();

    // Revenue by category
    const byCategory = db
      .select({
        category: financeTransactions.cuentaNombre,
        amount: sql<number>`SUM(haber)`,
      })
      .from(financeTransactions)
      .where(
        sql`tx_type = 'revenue' AND fecha >= ${from} AND fecha <= ${to}`
      )
      .groupBy(financeTransactions.cuentaNombre)
      .orderBy(sql`SUM(haber) DESC`)
      .all();

    // Revenue by month
    const byMonth = db
      .select({
        yearMonth: financeTransactions.yearMonth,
        amount: sql<number>`SUM(haber)`,
      })
      .from(financeTransactions)
      .where(
        sql`tx_type = 'revenue' AND fecha >= ${from} AND fecha <= ${to}`
      )
      .groupBy(financeTransactions.yearMonth)
      .orderBy(financeTransactions.yearMonth)
      .all();

    // Individual transactions
    const transactions = db
      .select({
        fecha: financeTransactions.fecha,
        cuentaNombre: financeTransactions.cuentaNombre,
        asiento: financeTransactions.asiento,
        detalle: financeTransactions.detalle,
        actor: financeTransactions.actor,
        centrosDeIngreso: financeTransactions.centrosDeIngreso,
        haber: financeTransactions.haber,
      })
      .from(financeTransactions)
      .where(
        sql`tx_type = 'revenue' AND fecha >= ${from} AND fecha <= ${to}`
      )
      .orderBy(sql`fecha DESC`)
      .all();

    return {
      success: true,
      data: {
        totalRevenue: totalRow?.total ?? 0,
        byCategory,
        byMonth,
        transactions,
      },
    };
  } catch (e) {
    return {
      success: false,
      error: `Error al cargar datos de ingresos: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
