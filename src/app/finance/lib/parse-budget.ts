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
  items: NewFinanceBudgetItem[];
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
  budgetYear: number
): BudgetParseResult {
  const errors: string[] = [];
  const wb = XLSX.read(buffer, { type: "array" });

  // Find the Expenses Detail sheet
  const expSheet = wb.Sheets["Expenses Detail"];
  if (!expSheet) {
    return {
      items: [],
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
      totalBudget: 0,
      budgetYear,
      errors: ["La hoja Expenses Detail está vacía"],
    };
  }

  // Find the budget year column
  const headers = data[0] as string[];
  const budgetColName = `${budgetYear} Budget`;
  const budgetColIdx = headers.indexOf(budgetColName);
  if (budgetColIdx === -1) {
    return {
      items: [],
      totalBudget: 0,
      budgetYear,
      errors: [
        `No se encontró la columna "${budgetColName}". Columnas disponibles: ${headers.filter(Boolean).join(", ")}`,
      ],
    };
  }

  // Extract budget items matching known categories
  const items: NewFinanceBudgetItem[] = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i] as (string | number)[];
    const category = String(row[0] || "").trim();
    const amount = Number(row[budgetColIdx]) || 0;

    if (category && BUDGET_CATEGORIES.includes(category as (typeof BUDGET_CATEGORIES)[number]) && amount !== 0) {
      items.push({ budgetYear, category, amount });
    }
  }

  // Combine personnel categories (server.R lines 152-158)
  const withContract = items.find(
    (i) => i.category === "Personnel Total with Contract"
  );
  const withoutContract = items.find(
    (i) => i.category === "Personnel Total without Contract"
  );

  if (withContract && withoutContract) {
    withContract.amount += withoutContract.amount;
    withContract.category = "Personnel";
    // Remove the two original entries and add the combined one
    const filtered = items.filter(
      (i) =>
        i.category !== "Personnel Total with Contract" &&
        i.category !== "Personnel Total without Contract"
    );
    filtered.push({
      budgetYear,
      category: "Personnel",
      amount: withContract.amount,
    });
    items.length = 0;
    items.push(...filtered);
  } else if (withContract) {
    withContract.category = "Personnel";
  }

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

  return { items, totalBudget, budgetYear, errors };
}
