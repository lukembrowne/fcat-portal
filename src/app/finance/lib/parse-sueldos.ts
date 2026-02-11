/**
 * Parser for Sueldos (salary) Excel file.
 *
 * Sheet 1 ("Timelines"): Grant funding allocations per person.
 *   Columns: person, source, start date, end date, amount, status, notes
 *   Dates are Excel serial numbers.
 *
 * Sheet 2 ("2025 Sueldos"): Total annual cost per person.
 *   Columns: Person, Figura en rol pagos, COSTO AL PROYECTO ANUAL
 */

import * as XLSX from "xlsx";
import type {
  NewFinanceSueldosGrant,
  NewFinanceSueldosTotal,
} from "@/db/schema";

export interface SueldosParseResult {
  grants: NewFinanceSueldosGrant[];
  totals: NewFinanceSueldosTotal[];
  errors: string[];
}

/** Convert Excel serial date number to YYYY-MM-DD string */
function excelDateToString(serial: number): string {
  // Excel epoch is 1900-01-01 (with a known bug treating 1900 as leap year)
  const utcDays = serial - 25569; // Days since Unix epoch
  const date = new Date(utcDays * 86400000);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function parseSueldosExcel(buffer: ArrayBuffer): SueldosParseResult {
  const errors: string[] = [];
  const wb = XLSX.read(buffer, { type: "array" });

  if (wb.SheetNames.length < 2) {
    return {
      grants: [],
      totals: [],
      errors: ["Se esperan al menos 2 hojas (Timelines + Sueldos)"],
    };
  }

  // --- Sheet 1: Timelines (grants) ---
  const grantsSheet = wb.Sheets[wb.SheetNames[0]];
  const grantsData = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    grantsSheet,
    { defval: null }
  );

  const grants: NewFinanceSueldosGrant[] = [];
  for (let i = 0; i < grantsData.length; i++) {
    const row = grantsData[i];
    const person = String(row["person"] || "").trim();
    const source = String(row["source"] || "").trim();
    const statusRaw = String(row["status"] || "").trim().toLowerCase();
    const amount = Number(row["amount"]) || 0;
    const startRaw = row["start date"];
    const endRaw = row["end date"];

    if (!person || !source || !amount) continue;

    // Map status
    const status: "funded" | "pending" =
      statusRaw === "funded" || statusRaw === "paused" ? "funded" : "pending";

    // Parse dates (Excel serial numbers)
    let startDate: string;
    let endDate: string;
    if (typeof startRaw === "number") {
      startDate = excelDateToString(startRaw);
    } else {
      startDate = String(startRaw || "").trim();
    }
    if (typeof endRaw === "number") {
      endDate = excelDateToString(endRaw);
    } else {
      endDate = String(endRaw || "").trim();
    }

    if (!startDate || !endDate) {
      errors.push(
        `Fila ${i + 2}: fechas inválidas para ${person} (${source})`
      );
      continue;
    }

    grants.push({ person, source, status, amount, startDate, endDate });
  }

  // --- Sheet 2: Sueldos totals ---
  const totalsSheet = wb.Sheets[wb.SheetNames[1]];
  const totalsData = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    totalsSheet,
    { defval: null }
  );

  const totals: NewFinanceSueldosTotal[] = [];
  // Group by person and sum, excluding FCATero individual lines (they're summed)
  for (const row of totalsData) {
    const person = String(row["Person"] || "").trim();
    const figuraPagos = String(row["Figura en rol pagos"] || "").trim();
    const annualCost = Number(row["COSTO AL PROYECTO ANUAL"]) || 0;

    if (!person || annualCost === 0) continue;

    // Skip individual FCATero lines — they're summed into aggregate entries
    if (figuraPagos.startsWith("FCATer")) continue;

    totals.push({
      person,
      annualCost,
      monthlyCost: annualCost / 12,
    });
  }

  return { grants, totals, errors };
}
