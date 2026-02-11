"use server";

import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import {
  financeTransactions,
  financeBudgetItems,
  financeCategoryMap,
} from "@/db/schema";
import { sql } from "drizzle-orm";
import type { ActionResult } from "@/lib/types";
import { budgetProportionByDay, dayOfYear } from "../lib/calculations";

export interface BudgetRow {
  category: string;
  spent: number;
  budgetedProrated: number;
  budgetedAnnual: number;
  progress: number; // 0-1+ (fraction spent of prorated budget)
}

export interface BudgetData {
  totalSpent: number;
  totalBudgetProrated: number;
  totalBudgetAnnual: number;
  isOverBudget: boolean;
  overUnderAmount: number;
  budgetRows: BudgetRow[];
  unlinkedAccounting: string[];
  unlinkedBudget: string[];
}

export async function fetchBudgetData(): Promise<ActionResult<BudgetData>> {
  await requirePermission("finance", "viewer");

  try {
    const currentYear = new Date().getFullYear();
    const yearStart = `${currentYear}-01-01`;
    const yearEnd = `${currentYear}-12-31`;

    // 1. Get the last transaction date for proration
    const lastTxRow = db
      .select({ maxDate: sql<string>`MAX(fecha)` })
      .from(financeTransactions)
      .where(
        sql`tx_type = 'expense' AND fecha >= ${yearStart} AND fecha <= ${yearEnd}`
      )
      .get();

    const lastTransactionDate = lastTxRow?.maxDate ?? yearStart;
    const proportion = budgetProportionByDay(dayOfYear(lastTransactionDate));

    // 2. Get all expense totals by accounting category for current year
    const expensesByCategory = db
      .select({
        category: financeTransactions.cuentaNombre,
        total: sql<number>`SUM(debe)`,
      })
      .from(financeTransactions)
      .where(
        sql`tx_type = 'expense' AND fecha >= ${yearStart} AND fecha <= ${yearEnd}`
      )
      .groupBy(financeTransactions.cuentaNombre)
      .all();

    // 3. Get budget items for current year
    const budgetItems = db
      .select({
        category: financeBudgetItems.category,
        amount: financeBudgetItems.amount,
      })
      .from(financeBudgetItems)
      .where(sql`budget_year = ${currentYear}`)
      .all();

    // 4. Get category mappings (budget category -> accounting category)
    const categoryMappings = db
      .select({
        budgetCategory: financeCategoryMap.budgetCategory,
        linkExpenseCategory: financeCategoryMap.linkExpenseCategory,
      })
      .from(financeCategoryMap)
      .all();

    // Build lookup: budget category -> list of accounting categories
    const budgetToAccounting = new Map<string, string[]>();
    const accountingToBudget = new Map<string, string>();

    for (const mapping of categoryMappings) {
      const existing = budgetToAccounting.get(mapping.budgetCategory) ?? [];
      existing.push(mapping.linkExpenseCategory);
      budgetToAccounting.set(mapping.budgetCategory, existing);
      accountingToBudget.set(
        mapping.linkExpenseCategory,
        mapping.budgetCategory
      );
    }

    // Build lookup: accounting category -> total spent
    const accountingSpentMap = new Map<string, number>();
    for (const row of expensesByCategory) {
      accountingSpentMap.set(row.category, row.total);
    }

    // 5. Build budget rows: for each budget category, sum linked accounting spending
    const budgetRows: BudgetRow[] = [];
    const budgetCategorySet = new Set<string>();

    for (const item of budgetItems) {
      budgetCategorySet.add(item.category);
      const linkedAccounting = budgetToAccounting.get(item.category) ?? [];
      const spent = linkedAccounting.reduce(
        (sum, acctCat) => sum + (accountingSpentMap.get(acctCat) ?? 0),
        0
      );
      const budgetedProrated = item.amount * proportion;
      const progress = budgetedProrated > 0 ? spent / budgetedProrated : 0;

      budgetRows.push({
        category: item.category,
        spent,
        budgetedProrated,
        budgetedAnnual: item.amount,
        progress,
      });
    }

    // Sort by spent descending
    budgetRows.sort((a, b) => b.spent - a.spent);

    // 6. Calculate totals
    const totalSpent = budgetRows.reduce((sum, r) => sum + r.spent, 0);
    const totalBudgetAnnual = budgetRows.reduce(
      (sum, r) => sum + r.budgetedAnnual,
      0
    );
    const totalBudgetProrated = totalBudgetAnnual * proportion;
    const overUnderAmount = totalSpent - totalBudgetProrated;
    const isOverBudget = overUnderAmount > 0;

    // 7. Find unlinked categories
    const allAccountingCategories = new Set(
      expensesByCategory.map((r) => r.category)
    );
    const linkedAccountingCategories = new Set(
      categoryMappings.map((m) => m.linkExpenseCategory)
    );

    const unlinkedAccounting = [...allAccountingCategories].filter(
      (cat) => !linkedAccountingCategories.has(cat)
    );
    unlinkedAccounting.sort();

    const linkedBudgetCategories = new Set(
      categoryMappings.map((m) => m.budgetCategory)
    );
    const unlinkedBudget = [...budgetCategorySet].filter(
      (cat) => !linkedBudgetCategories.has(cat)
    );
    unlinkedBudget.sort();

    return {
      success: true,
      data: {
        totalSpent,
        totalBudgetProrated,
        totalBudgetAnnual,
        isOverBudget,
        overUnderAmount,
        budgetRows,
        unlinkedAccounting,
        unlinkedBudget,
      },
    };
  } catch (e) {
    return {
      success: false,
      error: `Error al cargar datos de presupuesto: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
