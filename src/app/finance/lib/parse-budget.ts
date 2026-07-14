/**
 * Parser for FCAT Annual Budget Excel file.
 *
 * Reads the "Expenses Detail" sheet to extract budget line items.
 * Reads the "Revenue and Summary" sheet to get total expenses for validation.
 *
 * Expected structure of Expenses Detail:
 *   Row 0: Headers — "Position or Expense Category", ..., "2025 Budget", ...
 *   Rows 1+: Data — category name in col 0, budget amount in the year column
 */

import * as XLSX from "xlsx";
import type { NewFinanceBudgetItem } from "@/db/schema";
import { BUDGET_CATEGORIES } from "../constants";

export interface BudgetParseResult {
  /** Rows whose category is in the recognized BUDGET_CATEGORIES allowlist. */
  items: NewFinanceBudgetItem[];
  /**
   * Rows with a real category name and non-zero amount that are NOT in the
   * allowlist. Surfaced to the uploader for pre-flight review instead of being
   * silently dropped. Total/summary rows are excluded from this list.
   */
  unknownItems: NewFinanceBudgetItem[];
  totalBudget: number;
  budgetYear: number;
  errors: string[];
}

/**
 * Parse a Budget Excel file buffer.
 * @param buffer - Raw file buffer
 * @param budgetYear - The budget year to extract (e.g. 2025)
 */
export function parseBudgetExcel(
  buffer: ArrayBuffer,
  requestedYear: number
): BudgetParseResult {
  let budgetYear = requestedYear;
  const errors: string[] = [];
  const wb = XLSX.read(buffer, { type: "array" });

  // Find the Expenses Detail sheet
  const expSheet = wb.Sheets["Expenses Detail"];
  if (!expSheet) {
    return {
      items: [],
      unknownItems: [],
      totalBudget: 0,
      budgetYear,
      errors: ['No se encontró la hoja "Expenses Detail"'],
    };
  }

  const data = XLSX.utils.sheet_to_json<string[]>(expSheet, {
    header: 1,
    blankrows: false,
  });

  if (data.length < 2) {
    return {
      items: [],
      unknownItems: [],
      totalBudget: 0,
      budgetYear,
      errors: ["La hoja Expenses Detail está vacía"],
    };
  }

  // Find the budget year column — try requested year first, then auto-detect latest
  const headers = data[0] as string[];
  let budgetColName = `${budgetYear} Budget`;
  let budgetColIdx = headers.indexOf(budgetColName);

  if (budgetColIdx === -1) {
    // Auto-detect: find the latest "YYYY Budget" column
    const budgetCols = headers
      .map((h, i) => ({ header: String(h || ""), idx: i }))
      .filter((c) => /^\d{4}\s+Budget$/i.test(c.header))
      .sort((a, b) => b.header.localeCompare(a.header));

    if (budgetCols.length > 0) {
      budgetColIdx = budgetCols[0].idx;
      budgetColName = budgetCols[0].header;
      const detectedYear = parseInt(budgetColName, 10);
      if (!isNaN(detectedYear)) budgetYear = detectedYear;
    } else {
      return {
        items: [],
        unknownItems: [],
        totalBudget: 0,
        budgetYear,
        errors: [
          `No se encontró columna de presupuesto. Columnas disponibles: ${headers.filter(Boolean).join(", ")}`,
        ],
      };
    }
  }

  // Recognized personnel subtotals. The individual staff rows in the budget
  // sit between the "PERSONNEL" header and the "TOTAL PERSONNEL COSTS" line and
  // already sum into these two subtotals, so they are excluded by section (not
  // by name) — only the subtotals below survive, as two separate budget
  // categories ("Personnel with Contract" / "Personnel without Contract").
  const PERSONNEL_SUBTOTALS = new Set([
    "Personnel Total with Contract",
    "Personnel Total without Contract",
  ]);

  // Extract candidate rows and split into recognized vs. unrecognized.
  // A candidate is any row with a real category name that is not a total/summary
  // or per-staff personnel line. Recognized categories (allowlist) import
  // directly — even at $0, so every budgeted category is linkable; unrecognized
  // categories import only when non-zero and are surfaced for pre-flight review.
  const items: NewFinanceBudgetItem[] = [];
  const unknownItems: NewFinanceBudgetItem[] = [];
  let inPersonnelSection = false;
  for (let i = 1; i < data.length; i++) {
    const row = data[i] as (string | number)[];
    const category = String(row[0] || "").trim();
    const amount = Number(row[budgetColIdx]) || 0;

    // Personnel-section boundaries (checked before the amount/total guards so
    // the flag flips even when the header/total rows carry a value).
    if (/^personnel$/i.test(category)) {
      inPersonnelSection = true;
      continue;
    }
    if (/^total\s+personnel/i.test(category)) {
      inPersonnelSection = false;
      continue;
    }

    if (!category) continue;
    // Skip subtotal/total lines that carry a number but aren't real categories.
    if (/^(total|subtotal|sub-total|suma|gran\s+total|grand\s+total)/i.test(category)) {
      continue;
    }

    const isKnown = BUDGET_CATEGORIES.includes(
      category as (typeof BUDGET_CATEGORIES)[number]
    );

    // Drop zero-amount rows UNLESS the category is recognized. A recognized
    // category budgeted at $0 this year (e.g. "Land acquisition", "New
    // construction", "Internet") is still a real budget line and must be
    // imported so it can be linked to accounting spending. Unrecognized zero
    // rows are section headers / blank noise ("Assets", "No Contract", …) and
    // stay dropped so they never reach the "new category" review list.
    if (amount === 0 && !isKnown) continue;

    if (inPersonnelSection) {
      if (PERSONNEL_SUBTOTALS.has(category)) {
        // The rolled-up personnel figures — keep these.
        items.push({ budgetYear, category, amount });
      }
      // else: an individual staff detail line — skip (already in the subtotals),
      // even if its name collides with the recognized-category allowlist. A
      // No-Contract line named "Security Guards" is already inside "Personnel
      // Total without Contract", so pulling it out here double-counts it AND
      // prematurely ends the personnel block (dropping the lines that follow it,
      // e.g. "Temporary FCATeros", to the unrecognized path). The section only
      // ends on the explicit "TOTAL PERSONNEL…" row handled above.
      continue;
    }

    if (isKnown) {
      items.push({ budgetYear, category, amount });
    } else {
      unknownItems.push({ budgetYear, category, amount });
    }
  }

  // Keep the two personnel subtotals as separate budget categories rather than
  // merging them into one "Personnel" line, so the budget breaks personnel down
  // by contract status. Rename the raw sheet labels to clean category names.
  const withContract = items.find(
    (i) => i.category === "Personnel Total with Contract"
  );
  const withoutContract = items.find(
    (i) => i.category === "Personnel Total without Contract"
  );
  if (withContract) withContract.category = "Personnel with Contract";
  if (withoutContract) withoutContract.category = "Personnel without Contract";

  // Get total budget from Revenue and Summary sheet for validation
  let totalFromSummary = 0;
  const summarySheet = wb.Sheets["Revenue and Summary"];
  if (summarySheet) {
    const summaryData = XLSX.utils.sheet_to_json<(string | number)[]>(
      summarySheet,
      { header: 1, blankrows: false }
    );
    // Find "Total Expenses by Program/Function" row
    for (const row of summaryData) {
      if (String(row[0]).includes("Total Expenses")) {
        // "Total" column is typically column index 1 or find it by header
        const summaryHeaders = summaryData[0] as string[];
        const totalIdx = summaryHeaders.indexOf("Total ");
        const totalIdx2 = summaryHeaders.indexOf("Total");
        const idx = totalIdx !== -1 ? totalIdx : totalIdx2;
        if (idx !== -1) {
          totalFromSummary = Number(row[idx]) || 0;
        }
        break;
      }
    }
  }

  const totalBudget = items.reduce((sum, i) => sum + i.amount, 0);

  // Validate totals match (with tolerance for floating point)
  if (totalFromSummary > 0 && Math.abs(totalBudget - totalFromSummary) > 1) {
    errors.push(
      `Advertencia: Total calculado ($${totalBudget.toFixed(2)}) difiere del resumen ($${totalFromSummary.toFixed(2)})`
    );
  }

  return { items, unknownItems, totalBudget, budgetYear, errors };
}
