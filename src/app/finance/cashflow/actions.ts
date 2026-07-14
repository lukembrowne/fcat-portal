"use server";

import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import {
  financeTransactions,
  financeProjections,
  financeBudgetItems,
} from "@/db/schema";
import { sql, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/types";
import type { CashflowMonthRow, MonthlyAmount } from "../types";
import {
  MONTHLY_EXPENSE_PROPORTIONS,
  NON_OPERATING_CATEGORIES,
  CASH_RESERVE_TARGET,
} from "../constants";
import { monthSequence } from "../lib/calculations";

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

export interface CashflowData {
  /** Monthly balance breakdown rows (actual + projected) */
  monthRows: CashflowMonthRow[];
  /** Revenue by month (for bar chart) */
  revenueByMonth: MonthlyAmount[];
  /** Expenses by month (for bar chart) */
  expensesByMonth: MonthlyAmount[];
  /** All projections (for the editable table) */
  projections: ProjectionRow[];
  /** Metrics */
  metrics: {
    lastBankBalance: number;
    annualOperatingExpenses: number;
    runwayOnHandMonths: number;
    runwayProjectedMonths: number | null;
    goingNegativeDate: string | null;
  };
  cashReserveTarget: number;
}

export interface ProjectionRow {
  id: number;
  name: string;
  type: "income" | "expense";
  status: "confirmed" | "very_likely" | "maybe";
  amount: number;
  date: string;
  includeInProjection: boolean;
}

// ---------------------------------------------------------------------------
// Fetch all cashflow data
// ---------------------------------------------------------------------------

export async function fetchCashflowData(): Promise<ActionResult<CashflowData>> {
  await requirePermission("finance", "viewer");

  try {
    // 1. Annual operating expenses from budget (excluding non-operating)
    const budgetRows = db
      .select({
        category: financeBudgetItems.category,
        amount: financeBudgetItems.amount,
      })
      .from(financeBudgetItems)
      .all();

    const totalBudget = budgetRows.reduce((sum, r) => sum + r.amount, 0);
    const nonOperating = budgetRows
      .filter((r) => NON_OPERATING_CATEGORIES.includes(r.category))
      .reduce((sum, r) => sum + r.amount, 0);
    const annualOperatingExpenses = totalBudget - nonOperating;

    // 2. Revenue by month (all time)
    const revenueByMonth = db
      .select({
        yearMonth: financeTransactions.yearMonth,
        amount: sql<number>`SUM(haber)`,
      })
      .from(financeTransactions)
      .where(sql`tx_type = 'revenue'`)
      .groupBy(financeTransactions.yearMonth)
      .orderBy(financeTransactions.yearMonth)
      .all();

    // 3. Expenses by month (all time)
    const expensesByMonth = db
      .select({
        yearMonth: financeTransactions.yearMonth,
        amount: sql<number>`SUM(debe)`,
      })
      .from(financeTransactions)
      .where(sql`tx_type = 'expense'`)
      .groupBy(financeTransactions.yearMonth)
      .orderBy(financeTransactions.yearMonth)
      .all();

    // 4. Cash balance: last balance per month (end-of-month balance)
    const cashBalances = db
      .select({
        yearMonth: financeTransactions.yearMonth,
        balance: sql<number>`MIN(balance)`,
      })
      .from(financeTransactions)
      .where(
        sql`tx_type = 'cash' AND fecha = (
          SELECT MAX(t2.fecha) FROM finance_transactions t2
          WHERE t2.tx_type = 'cash' AND t2.year_month = finance_transactions.year_month
        )`
      )
      .groupBy(financeTransactions.yearMonth)
      .orderBy(financeTransactions.yearMonth)
      .all();

    const cashMap = new Map(cashBalances.map((r) => [r.yearMonth, r.balance]));

    // 5. Last known bank balance
    const lastCashRow = db
      .select({ balance: financeTransactions.balance })
      .from(financeTransactions)
      .where(sql`tx_type = 'cash'`)
      .orderBy(sql`fecha DESC`)
      .limit(1)
      .get();
    const lastBankBalance = lastCashRow?.balance ?? 0;

    // 6. Projections from DB
    const projections = db
      .select({
        id: financeProjections.id,
        name: financeProjections.name,
        type: financeProjections.type,
        status: financeProjections.status,
        amount: financeProjections.amount,
        date: financeProjections.date,
        includeInProjection: financeProjections.includeInProjection,
      })
      .from(financeProjections)
      .orderBy(financeProjections.date)
      .all();

    // 7. Build projected income/additional expenses by month from projections
    const projIncomeMap = new Map<string, number>();
    const projAdditionalExpMap = new Map<string, number>();
    for (const p of projections) {
      if (!p.includeInProjection) continue;
      const ym = p.date.slice(0, 7) + "-01";
      if (p.type === "income") {
        projIncomeMap.set(ym, (projIncomeMap.get(ym) || 0) + p.amount);
      } else {
        projAdditionalExpMap.set(ym, (projAdditionalExpMap.get(ym) || 0) + p.amount);
      }
    }

    // 8. Build projected expenses by month (proportional)
    //    Range: from earliest data month to 2 years out
    const allActualMonths = [
      ...revenueByMonth.map((r) => r.yearMonth),
      ...expensesByMonth.map((r) => r.yearMonth),
      ...cashBalances.map((r) => r.yearMonth),
    ].sort();

    const now = new Date();
    // Cap the projection horizon at the end of 2027 (business decision — don't
    // project cash flow further than the current planning window).
    const futureEnd = "2027-12-01";
    const startMonth = allActualMonths[0] || `${now.getFullYear()}-01-01`;
    const endMonth = futureEnd;

    const allMonths = monthSequence(startMonth, endMonth);

    const projExpensesMap = new Map<string, number>();
    for (const ym of allMonths) {
      const monthIdx = parseInt(ym.slice(5, 7), 10) - 1;
      projExpensesMap.set(ym, MONTHLY_EXPENSE_PROPORTIONS[monthIdx] * annualOperatingExpenses);
    }

    // 9. Build the month rows
    const revenueMap = new Map(revenueByMonth.map((r) => [r.yearMonth, r.amount]));
    const expensesMap = new Map(expensesByMonth.map((r) => [r.yearMonth, r.amount]));

    const monthRows: CashflowMonthRow[] = [];
    let lastProjectedBalance: number | null = null;

    for (const ym of allMonths) {
      const revenue = revenueMap.get(ym) ?? null;
      const expenses = expensesMap.get(ym) ?? null;
      const net = revenue !== null && expenses !== null ? revenue - expenses : null;
      const balance = cashMap.get(ym) ?? null;
      const projectedIncome = projIncomeMap.get(ym) ?? null;
      const projectedExpenses = projExpensesMap.get(ym) ?? null;
      const projectedAdditionalExpenses = projAdditionalExpMap.get(ym) ?? null;

      // Projected balance calculation (only for months without actual balance)
      let projectedBalance: number | null = null;
      if (balance !== null) {
        // Has actual balance — use it as base for next projected
        lastProjectedBalance = balance;
      } else if (lastProjectedBalance !== null) {
        // No actual balance — project forward
        projectedBalance = lastProjectedBalance
          + (projectedIncome ?? 0)
          - (projectedExpenses ?? 0)
          - (projectedAdditionalExpenses ?? 0);
        lastProjectedBalance = projectedBalance;
      }

      monthRows.push({
        yearMonth: ym,
        revenue,
        expenses,
        net,
        projectedIncome,
        projectedExpenses,
        projectedAdditionalExpenses,
        balance,
        projectedBalance,
      });
    }

    // 10. Runway calculations
    const monthlyOpEx = annualOperatingExpenses > 0 ? annualOperatingExpenses / 12 : 0;
    const runwayOnHandMonths = monthlyOpEx > 0
      ? Math.round((lastBankBalance / monthlyOpEx) * 100) / 100
      : 0;

    // Runway with projected income: find first month where projected balance < 0
    let runwayProjectedMonths: number | null = null;
    let goingNegativeDate: string | null = null;
    const firstProjectedIdx = monthRows.findIndex((r) => r.projectedBalance !== null && r.projectedBalance < 0);
    if (firstProjectedIdx >= 0) {
      goingNegativeDate = monthRows[firstProjectedIdx].yearMonth;
      // Calculate months from now
      const nowYM = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
      const nowIdx = allMonths.indexOf(nowYM);
      if (nowIdx >= 0) {
        runwayProjectedMonths = firstProjectedIdx - nowIdx;
      }
    }

    return {
      success: true,
      data: {
        monthRows,
        revenueByMonth,
        expensesByMonth,
        projections: projections as ProjectionRow[],
        metrics: {
          lastBankBalance,
          annualOperatingExpenses,
          runwayOnHandMonths,
          runwayProjectedMonths,
          goingNegativeDate,
        },
        cashReserveTarget: CASH_RESERVE_TARGET,
      },
    };
  } catch (e) {
    return {
      success: false,
      error: `Error al cargar datos de flujo de caja: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Projection CRUD
// ---------------------------------------------------------------------------

export async function addProjection(formData: FormData): Promise<ActionResult<undefined>> {
  await requirePermission("finance", "admin");

  try {
    const name = formData.get("name");
    const type = formData.get("type");
    const status = formData.get("status");
    const amount = formData.get("amount");
    const date = formData.get("date");
    const includeInProjection = formData.get("includeInProjection");

    if (typeof name !== "string" || !name.trim()) {
      return { success: false, error: "Nombre es requerido" };
    }
    if (type !== "income" && type !== "expense") {
      return { success: false, error: "Tipo debe ser income o expense" };
    }
    if (status !== "confirmed" && status !== "very_likely" && status !== "maybe") {
      return { success: false, error: "Estado inválido" };
    }
    if (typeof amount !== "string" || isNaN(Number(amount)) || Number(amount) <= 0) {
      return { success: false, error: "Monto debe ser un número positivo" };
    }
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { success: false, error: "Fecha inválida" };
    }

    db.insert(financeProjections)
      .values({
        name: name.trim(),
        type,
        status,
        amount: Number(amount),
        date,
        includeInProjection: includeInProjection === "on" || includeInProjection === "true",
      })
      .run();

    revalidatePath("/finance");
    return { success: true, data: undefined };
  } catch (e) {
    return {
      success: false,
      error: `Error al agregar proyección: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function updateProjection(formData: FormData): Promise<ActionResult<undefined>> {
  await requirePermission("finance", "admin");

  try {
    const id = formData.get("id");
    if (typeof id !== "string" || isNaN(Number(id))) {
      return { success: false, error: "ID inválido" };
    }

    const name = formData.get("name");
    const type = formData.get("type");
    const status = formData.get("status");
    const amount = formData.get("amount");
    const date = formData.get("date");
    const includeInProjection = formData.get("includeInProjection");

    if (typeof name !== "string" || !name.trim()) {
      return { success: false, error: "Nombre es requerido" };
    }
    if (type !== "income" && type !== "expense") {
      return { success: false, error: "Tipo debe ser income o expense" };
    }
    if (status !== "confirmed" && status !== "very_likely" && status !== "maybe") {
      return { success: false, error: "Estado inválido" };
    }
    if (typeof amount !== "string" || isNaN(Number(amount)) || Number(amount) <= 0) {
      return { success: false, error: "Monto debe ser un número positivo" };
    }
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { success: false, error: "Fecha inválida" };
    }

    db.update(financeProjections)
      .set({
        name: name.trim(),
        type,
        status,
        amount: Number(amount),
        date,
        includeInProjection: includeInProjection === "on" || includeInProjection === "true",
        updatedAt: new Date(),
      })
      .where(eq(financeProjections.id, Number(id)))
      .run();

    revalidatePath("/finance");
    return { success: true, data: undefined };
  } catch (e) {
    return {
      success: false,
      error: `Error al actualizar proyección: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function deleteProjection(formData: FormData): Promise<ActionResult<undefined>> {
  await requirePermission("finance", "admin");

  try {
    const id = formData.get("id");
    if (typeof id !== "string" || isNaN(Number(id))) {
      return { success: false, error: "ID inválido" };
    }

    db.delete(financeProjections)
      .where(eq(financeProjections.id, Number(id)))
      .run();

    revalidatePath("/finance");
    return { success: true, data: undefined };
  } catch (e) {
    return {
      success: false,
      error: `Error al eliminar proyección: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
