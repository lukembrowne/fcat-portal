/**
 * Parser for Budget-to-Accounting category linking Excel file.
 *
 * The file maps budget categories (e.g. "Food") to one or more
 * Link accounting system categories (e.g. "ALIMENTACION").
 *
 * Sheet 1 structure:
 *   Row 0: Headers — "Position or Expense Category",
 *          "Link Expense Category", "Link Expense Category_2", ...
 *   Rows 1+: category name, followed by 1+ accounting categories
 */

import * as XLSX from "xlsx";
import type { NewFinanceCategoryMapRow } from "@/db/schema";

export interface CategoryLinkParseResult {
  mappings: NewFinanceCategoryMapRow[];
  errors: string[];
}

export function parseCategoryLinkExcel(
  buffer: ArrayBuffer
): CategoryLinkParseResult {
  const errors: string[] = [];
  const wb = XLSX.read(buffer, { type: "array" });

  // Use the first sheet
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) {
    return { mappings: [], errors: ["No se encontró ninguna hoja"] };
  }

  const data = XLSX.utils.sheet_to_json<(string | number | null)[]>(ws, {
    header: 1,
    blankrows: false,
  });

  if (data.length < 2) {
    return { mappings: [], errors: ["El archivo está vacío"] };
  }

  const headers = data[0] as string[];
  if (!headers[0] || !String(headers[0]).includes("Position or Expense")) {
    errors.push(
      `Columna esperada "Position or Expense Category" no encontrada. Primera columna: "${headers[0]}"`
    );
    return { mappings: [], errors };
  }

  // Find all "Link Expense Category" columns
  const linkColIndexes: number[] = [];
  for (let c = 1; c < headers.length; c++) {
    if (String(headers[c] || "").startsWith("Link Expense Category")) {
      linkColIndexes.push(c);
    }
  }

  if (linkColIndexes.length === 0) {
    return {
      mappings: [],
      errors: ['No se encontraron columnas "Link Expense Category"'],
    };
  }

  // Extract mappings
  const mappings: NewFinanceCategoryMapRow[] = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i] as (string | null)[];
    const budgetCategory = String(row[0] || "").trim();
    if (!budgetCategory) continue;

    // Skip summary/total rows
    if (
      budgetCategory.startsWith("TOTAL") ||
      budgetCategory.startsWith("Total")
    )
      continue;

    for (const colIdx of linkColIndexes) {
      const linkCategory = String(row[colIdx] || "").trim();
      if (linkCategory && linkCategory !== "UNKNOWN") {
        mappings.push({
          budgetCategory,
          linkExpenseCategory: linkCategory,
        });
      }
    }
  }

  return { mappings, errors };
}
