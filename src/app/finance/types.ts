/**
 * Shared types for the financial dashboard module.
 */

export interface DateRange {
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
}

export type DateRangePreset =
  | "this-year"
  | "last-year"
  | "this-month"
  | "last-month"
  | "custom";

/** Summary of a parsed file before committing to the database */
export interface UploadPreview {
  rowCount: number;
  dateRange?: { min: string; max: string };
  sampleRows?: Record<string, unknown>[];
}

/** Aggregated revenue/expense data by month */
export interface MonthlyAmount {
  yearMonth: string; // YYYY-MM-01
  amount: number;
}

/** Aggregated data by category */
export interface CategoryAmount {
  category: string;
  amount: number;
}

/** A single row in the budget comparison table */
export interface BudgetComparisonRow {
  category: string;
  spent: number;
  budgetedProrated: number;
  budgetedAnnual: number;
  progress: number; // 0-1+
}

/** Cashflow monthly balance row */
export interface CashflowMonthRow {
  yearMonth: string;
  revenue: number | null;
  expenses: number | null;
  net: number | null;
  projectedIncome: number | null;
  projectedExpenses: number | null;
  projectedAdditionalExpenses: number | null;
  balance: number | null;
  projectedBalance: number | null;
}

/** Sueldos per-person monthly data for charts */
export interface SueldosPersonMonth {
  person: string;
  month: string; // YYYY-MM-01
  source: string;
  amount: number;
  monthlyCost: number;
}
