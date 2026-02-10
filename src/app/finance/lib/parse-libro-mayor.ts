/**
 * Parser for LibroMayor CSV exports from Link accounting system.
 *
 * The file is tab-separated, ISO-8859-1 encoded.
 * Columns: CUENTA CÓDIGO, CUENTA NOMBRE, FECHA, # ASIENTO, COMPROBANTE,
 *          USUARIO, DETALLE, DOC., C. COSTO, CENTROS DE INGRESO,
 *          IDENTIFICACION, ACTOR, DEBE, HABER, SALDO ACT
 */

import type { NewFinanceTransaction } from "@/db/schema";
import { LIBRO_MAYOR_COLUMNS } from "../constants";

type TxType = "revenue" | "expense" | "cash" | "other";

/**
 * Classify a transaction based on its account code and journal entry ID.
 * Ported from server.R lines 201-258.
 */
export function classifyTransaction(codigo: string, asiento: string): TxType {
  // Exclude transfers and starting balances
  if (asiento.startsWith("CC2CR") || asiento.startsWith("SALDO")) return "other";

  // Cash account (banco principal)
  if (codigo === "1.1.1.2.01") return "cash";

  // Expenses: accounts 5.x.x, 6.x.x, plus land (1.2.2.1.01) and loan (2.1.6.1.01)
  if (
    codigo.startsWith("5") ||
    codigo.startsWith("6") ||
    codigo === "1.2.2.1.01" ||
    codigo === "2.1.6.1.01"
  ) {
    return "expense";
  }

  // Revenue: accounts 2.x.x or 4.x.x with specific entry types
  if (
    (codigo.startsWith("2") || codigo.startsWith("4")) &&
    (asiento.startsWith("ING") || codigo === "4.1.1.1.01")
  ) {
    return "revenue";
  }

  return "other";
}

/** Parse a numeric value, handling empty strings and locale differences */
function parseNumber(val: string): number {
  if (!val || val.trim() === "") return 0;
  return parseFloat(val.replace(/,/g, "")) || 0;
}

/**
 * Parse a LibroMayor CSV buffer into transaction rows ready for DB insertion.
 *
 * @param buffer - Raw file buffer (ISO-8859-1 encoded)
 * @returns Array of transaction rows + validation errors
 */
export function parseLibroMayor(buffer: ArrayBuffer): {
  rows: NewFinanceTransaction[];
  errors: string[];
} {
  const errors: string[] = [];

  // Decode ISO-8859-1
  const decoder = new TextDecoder("iso-8859-1");
  const text = decoder.decode(buffer);

  // Split into lines and filter empties
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) {
    return { rows: [], errors: ["El archivo está vacío o no tiene datos"] };
  }

  // Validate header
  const headerLine = lines[0];
  const headers = headerLine.split("\t").map((h) => h.trim());

  // Check for expected columns
  const missingCols = LIBRO_MAYOR_COLUMNS.filter(
    (col) => !headers.includes(col)
  );
  if (missingCols.length > 0) {
    errors.push(`Columnas faltantes: ${missingCols.join(", ")}`);
    return { rows: [], errors };
  }

  // Build column index map
  const colIdx: Record<string, number> = {};
  for (const col of LIBRO_MAYOR_COLUMNS) {
    colIdx[col] = headers.indexOf(col);
  }

  // Parse data rows
  const rows: NewFinanceTransaction[] = [];
  const seenKeys = new Set<string>();

  for (let i = 1; i < lines.length; i++) {
    const fields = lines[i].split("\t");
    if (fields.length < headers.length - 1) continue; // Skip malformed rows

    const codigo = (fields[colIdx["CUENTA CÓDIGO"]] || "").trim();
    const cuentaNombre = (fields[colIdx["CUENTA NOMBRE"]] || "").trim();
    const fechaRaw = (fields[colIdx["FECHA"]] || "").trim();
    const asiento = (fields[colIdx["# ASIENTO"]] || "").trim();
    const detalle = (fields[colIdx["DETALLE"]] || "").trim();
    const actor = (fields[colIdx["ACTOR"]] || "").trim();
    const centrosDeIngreso = (
      fields[colIdx["CENTROS DE INGRESO"]] || ""
    ).trim();
    const cCosto = (fields[colIdx["C. COSTO"]] || "").trim();
    const debe = parseNumber(fields[colIdx["DEBE"]] || "");
    const haber = parseNumber(fields[colIdx["HABER"]] || "");
    const balance = parseNumber(fields[colIdx["SALDO ACT"]] || "");

    // Skip rows without a date (e.g., "Saldo Inicial" rows)
    if (!fechaRaw) continue;

    // Parse date — format should be YYYY-MM-DD from Link system
    const fecha = fechaRaw;
    const dateParts = fecha.split("-");
    if (dateParts.length !== 3) {
      errors.push(`Fila ${i + 1}: formato de fecha inválido "${fechaRaw}"`);
      continue;
    }

    const year = parseInt(dateParts[0], 10);
    const month = parseInt(dateParts[1], 10);
    const yearMonth = `${year}-${String(month).padStart(2, "0")}-01`;

    // Deduplicate
    const key = `${codigo}|${fecha}|${asiento}|${detalle}|${debe}|${haber}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    // Classify transaction type
    const txType = classifyTransaction(codigo, asiento);

    // Apply recategorization rules from server.R lines 222-225
    let adjustedCuentaNombre = cuentaNombre;
    if (
      actor === "FREILE ORTIZ JUAN FERNANDO" &&
      cuentaNombre === "HONORARIOS PROFESIONALES"
    ) {
      adjustedCuentaNombre = "SERVICIOS PERSONALES CONSULTORIA";
    }
    if (
      actor === "TIRADO CHAMORRO MILTON FABIAN" &&
      cuentaNombre === "HONORARIOS PROFESIONALES"
    ) {
      adjustedCuentaNombre = "SERVICIOS PERSONALES CONSULTORIA";
    }

    // Skip specific adjustment entry (server.R line 230)
    if (
      cuentaNombre === "GASTOS NO DEDUCIBLES" &&
      detalle === "Ajuste Cuentas provisiones gastos" &&
      asiento === "DG840627"
    ) {
      continue;
    }

    rows.push({
      fecha,
      codigo,
      cuentaNombre: adjustedCuentaNombre,
      asiento,
      detalle: detalle || null,
      actor: actor || null,
      centrosDeIngreso: centrosDeIngreso || null,
      cCosto: cCosto || null,
      debe,
      haber,
      balance,
      year,
      month,
      yearMonth,
      txType,
    });
  }

  return { rows, errors };
}
