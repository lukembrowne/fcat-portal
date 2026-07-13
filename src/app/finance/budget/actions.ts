"use server";

import { requirePermission, getCurrentUser } from "@/lib/auth";
import { db } from "@/db";
import {
  financeTransactions,
  financeBudgetItems,
  financeCategoryMap,
} from "@/db/schema";
import { sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/types";
import { budgetProportionByDay, dayOfYear } from "../lib/calculations";
import { recordEvent } from "@/lib/system-events";

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

// ---------------------------------------------------------------------------
// Category-link editor (in-app replacement for the Excel mapping upload)
// ---------------------------------------------------------------------------

export interface CategoryLinkEditorRow {
  /** Link accounting category (finance_transactions.cuentaNombre) */
  linkCategory: string;
  /** Budget category it is mapped to, or null when unlinked */
  budgetCategory: string | null;
  /** Total spent (SUM debe) for this accounting category, current year */
  spent: number;
}

export interface CategoryLinkEditorData {
  rows: CategoryLinkEditorRow[];
  /** Budget categories available to assign (from the uploaded budget) */
  budgetCategoryOptions: string[];
}

/**
 * Read model for the accounting-centric linking editor on the Presupuesto page.
 * Universe of accounting categories = distinct current-year expense categories
 * ∪ any category already present in the map (so a mapped-but-inactive category
 * still shows and can be re-assigned or cleared).
 */
export async function fetchCategoryLinkEditorData(): Promise<
  ActionResult<CategoryLinkEditorData>
> {
  await requirePermission("finance", "viewer");

  try {
    const currentYear = new Date().getFullYear();
    const yearStart = `${currentYear}-01-01`;
    const yearEnd = `${currentYear}-12-31`;

    // Expense totals by accounting category (current year)
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

    // Existing mappings (link accounting category -> budget category)
    const mappings = db
      .select({
        budgetCategory: financeCategoryMap.budgetCategory,
        linkExpenseCategory: financeCategoryMap.linkExpenseCategory,
      })
      .from(financeCategoryMap)
      .all();

    const linkToBudget = new Map<string, string>();
    for (const m of mappings) {
      linkToBudget.set(m.linkExpenseCategory, m.budgetCategory);
    }

    const spentMap = new Map<string, number>();
    for (const row of expensesByCategory) {
      if (row.category) spentMap.set(row.category, row.total);
    }

    // Universe: current-year expense categories ∪ already-mapped categories
    const universe = new Set<string>();
    for (const row of expensesByCategory) {
      if (row.category) universe.add(row.category);
    }
    for (const cat of linkToBudget.keys()) universe.add(cat);

    const rows: CategoryLinkEditorRow[] = [...universe].map((linkCategory) => ({
      linkCategory,
      budgetCategory: linkToBudget.get(linkCategory) ?? null,
      spent: spentMap.get(linkCategory) ?? 0,
    }));

    // Unlinked first, then by spend descending, then name for stability
    rows.sort((a, b) => {
      const aUnlinked = a.budgetCategory === null ? 0 : 1;
      const bUnlinked = b.budgetCategory === null ? 0 : 1;
      if (aUnlinked !== bUnlinked) return aUnlinked - bUnlinked;
      if (b.spent !== a.spent) return b.spent - a.spent;
      return a.linkCategory.localeCompare(b.linkCategory);
    });

    // Budget-category dropdown options = distinct budgeted categories this year
    const budgetCategoryRows = db
      .selectDistinct({ category: financeBudgetItems.category })
      .from(financeBudgetItems)
      .where(sql`budget_year = ${currentYear}`)
      .all();
    const budgetCategoryOptions = budgetCategoryRows
      .map((r) => r.category)
      .sort((a, b) => a.localeCompare(b));

    return { success: true, data: { rows, budgetCategoryOptions } };
  } catch (e) {
    return {
      success: false,
      error: `Error al cargar el editor de vinculación: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Assign a Link accounting category to a budget category, or clear it
 * (budgetCategory = null). A Link category maps to at most one budget category,
 * so this replaces any existing rows for that Link category.
 */
export async function setCategoryLink(
  linkCategory: string,
  budgetCategory: string | null
): Promise<ActionResult<undefined>> {
  await requirePermission("finance", "admin");
  const user = await getCurrentUser();

  const link = linkCategory.trim();
  if (!link) {
    return { success: false, error: "Categoría contable vacía" };
  }
  const budget = budgetCategory?.trim() || null;

  try {
    db.transaction((tx) => {
      tx.run(
        sql`DELETE FROM finance_category_map WHERE link_expense_category = ${link}`
      );
      if (budget) {
        tx.insert(financeCategoryMap)
          .values({ budgetCategory: budget, linkExpenseCategory: link })
          .run();
      }
    });

    db.run(sql`PRAGMA wal_checkpoint(PASSIVE)`);

    await recordEvent({
      source: "finance",
      eventType: "finance_category_link_set",
      summary: budget
        ? `Categoría contable "${link}" vinculada a "${budget}"`
        : `Categoría contable "${link}" desvinculada`,
      severity: "info",
      actorEmail: user?.email ?? null,
      projectId: "finance",
      targetType: "finance_category_map",
      details: { linkCategory: link, budgetCategory: budget },
    });

    revalidatePath("/finance");
    return { success: true, data: undefined };
  } catch (e) {
    return {
      success: false,
      error: `Error al vincular categoría: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
