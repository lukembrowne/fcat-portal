/**
 * Parser for the Sueldos (salary) Excel file.
 *
 * Sheet 1 ("Timelines"): one funding line per row.
 *   person | source | start date | end date | amount | status | notes
 *
 * Sheet 2 ("<year> Sueldos"): fully-loaded annual cost per person.
 *   Person | Figura en rol pagos | COSTO AL PROYECTO ANUAL
 *
 * Two things the previous parser did that this one deliberately does not:
 *
 *  1. It dropped every row whose "Figura en rol pagos" started with "FCATer" —
 *     thirteen people — keeping only the aggregate. Three of them are named
 *     individually on grants, so their funding had nowhere to land and silently
 *     vanished. Here they become people in the FCATeros group, and the aggregate
 *     row becomes the group itself.
 *  2. It matched allocation targets to people by exact string equality, so
 *     "Luzia"/"Lucia" and "Nunez"/"Nuñez" dropped rows with no warning.
 *     Here matching is accent- and case-insensitive, and anything still
 *     unmatched is REPORTED for a human to map rather than discarded.
 */

import * as XLSX from "xlsx";
import { parseAmount } from "@/lib/grants/coerce";

/** Group names the sheet uses as if they were people. */
export const FCATEROS_GROUP = "FCATeros";
export const FCATEROS_EXT_GROUP = "FCATeros Ext.";
export const KNOWN_GROUP_NAMES = [FCATEROS_GROUP, FCATEROS_EXT_GROUP];

/** Roles that place someone in the FCATeros pool. */
const FCATERO_ROLE_PREFIX = "fcater";

export interface ParsedPerson {
  name: string;
  role: string | null;
  /** Group name, or null for individually-named staff. */
  group: string | null;
  annualCost: number;
}

export interface ParsedSource {
  name: string;
  status: "funded" | "pending";
  /** Widest span across the source's own lines — the default for new lines. */
  defaultStartDate: string | null;
  defaultEndDate: string | null;
}

export interface ParsedAllocation {
  /** Raw target name as written in the Timelines sheet. */
  rawTarget: string;
  /** Normalized key used for matching. */
  targetKey: string;
  sourceName: string;
  amount: number;
  startDate: string;
  endDate: string;
  notes: string | null;
  /** Row number in the sheet, for error messages. */
  row: number;
}

export interface SueldosParseResult {
  /** Year read from the salary sheet's name, when it carries one. */
  detectedYear: number | null;
  people: ParsedPerson[];
  groups: string[];
  sources: ParsedSource[];
  allocations: ParsedAllocation[];
  /** Non-fatal problems worth showing before committing. */
  warnings: string[];
  /** Fatal problems — nothing should be written. */
  errors: string[];
}

/**
 * Accent- and case-insensitive key. Resolves "Ramiro Nunez" ↔ "Ramiro
 * Nuñez" deterministically. Deliberately NOT fuzzy: the payroll has three
 * different people sharing one surname, and edit-distance matching would
 * merge them.
 */
export function normalizeName(v: string): string {
  return v
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip combining diacriticals
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** Excel serial date number → YYYY-MM-DD. */
function excelDateToString(serial: number): string {
  const date = new Date(Math.round((serial - 25569) * 86400000));
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Any cell → YYYY-MM-DD, or null. Handles Excel serials, Dates, M/D/YY text. */
function parseCellDate(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "number" && isFinite(v) && v > 0) return excelDateToString(v);

  const s = String(v).trim();
  if (!s) return null;

  // M/D/YY or M/D/YYYY — parsed as UTC so the container's timezone can't shift
  // the calendar day.
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (m) {
    let year = parseInt(m[3], 10);
    if (year < 100) year += year < 70 ? 2000 : 1900;
    const d = new Date(Date.UTC(year, parseInt(m[1], 10) - 1, parseInt(m[2], 10)));
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }

  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  return null;
}

/**
 * "NMBCA VII (funded)" → { name: "NMBCA VII", statusHint: "funded" }.
 * The sheet encodes status in the name AND in its own column; the name is the
 * one that has to be cleaned, since it becomes a stored identifier.
 */
export function splitSourceName(raw: string): { name: string; statusHint: string | null } {
  const m = raw.trim().match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  if (!m) return { name: raw.trim(), statusHint: null };
  return { name: m[1].trim(), statusHint: m[2].trim().toLowerCase() };
}

/** "2025 Sueldos" → 2025. */
function yearFromSheetName(name: string): number | null {
  const m = name.match(/(20\d{2})/);
  return m ? parseInt(m[1], 10) : null;
}

export function parseSueldosExcel(buffer: ArrayBuffer): SueldosParseResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  const wb = XLSX.read(buffer, { type: "array" });
  if (wb.SheetNames.length < 2) {
    return {
      detectedYear: null,
      people: [],
      groups: [],
      sources: [],
      allocations: [],
      warnings: [],
      errors: ['Se esperan al menos 2 hojas ("Timelines" y la hoja de sueldos)'],
    };
  }

  // --- Sheet 2: the roster -------------------------------------------------
  const salarySheetName = wb.SheetNames[1];
  const detectedYear = yearFromSheetName(salarySheetName);
  const salaryRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(
    wb.Sheets[salarySheetName],
    { defval: null }
  );

  const people: ParsedPerson[] = [];
  const groupAggregates = new Map<string, number>();
  const seenNames = new Set<string>();

  for (const row of salaryRows) {
    const name = String(row["Person"] ?? "").trim();
    const role = String(row["Figura en rol pagos"] ?? "").trim();
    const annualCost = parseAmount(row["COSTO AL PROYECTO ANUAL"]);

    if (!name || annualCost == null || annualCost === 0) continue;

    // A row whose NAME is a group name is the pooled aggregate, not a person.
    const asGroup = KNOWN_GROUP_NAMES.find((g) => normalizeName(g) === normalizeName(name));
    if (asGroup) {
      groupAggregates.set(asGroup, annualCost);
      continue;
    }

    const key = normalizeName(name);
    if (seenNames.has(key)) {
      warnings.push(`Persona repetida en la hoja de sueldos: ${name} (se usa la primera fila)`);
      continue;
    }
    seenNames.add(key);

    // Role decides pool membership. Unlike the old parser, this ADDS the person
    // to a group rather than dropping them.
    const group = role.toLowerCase().startsWith(FCATERO_ROLE_PREFIX) ? FCATEROS_GROUP : null;

    people.push({ name, role: role || null, group, annualCost });
  }

  // Reconcile each pooled aggregate against the members that make it up. A
  // mismatch is a warning, not a failure — the members are the source of truth.
  for (const [groupName, aggregate] of groupAggregates) {
    const memberSum = people
      .filter((p) => p.group === groupName)
      .reduce((s, p) => s + p.annualCost, 0);
    if (Math.abs(memberSum - aggregate) > 0.01) {
      warnings.push(
        `El total de "${groupName}" en la hoja ($${aggregate.toFixed(2)}) no coincide con la suma de sus ${
          people.filter((p) => p.group === groupName).length
        } integrantes ($${memberSum.toFixed(2)}). Se usará la suma de los integrantes.`
      );
    }
  }

  // --- Sheet 1: funding lines ----------------------------------------------
  const timelineRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]], {
    defval: null,
  });

  const allocations: ParsedAllocation[] = [];
  const sourceSpans = new Map<
    string,
    { status: "funded" | "pending"; start: string | null; end: string | null }
  >();

  for (let i = 0; i < timelineRows.length; i++) {
    const row = timelineRows[i];
    const rowNum = i + 2; // 1-indexed with a header row

    const rawTarget = String(row["person"] ?? "").trim();
    const rawSource = String(row["source"] ?? "").trim();
    const amount = parseAmount(row["amount"]);

    if (!rawTarget || !rawSource || amount == null || amount === 0) continue;

    const startDate = parseCellDate(row["start date"]);
    const endDate = parseCellDate(row["end date"]);
    if (!startDate || !endDate) {
      warnings.push(`Fila ${rowNum}: fechas inválidas para ${rawTarget} (${rawSource}) — omitida`);
      continue;
    }
    if (endDate < startDate) {
      warnings.push(
        `Fila ${rowNum}: la fecha de fin precede a la de inicio para ${rawTarget} (${rawSource}) — omitida`
      );
      continue;
    }

    const { name: sourceName, statusHint } = splitSourceName(rawSource);
    const statusRaw = String(row["status"] ?? "").trim().toLowerCase() || statusHint || "";
    // "paused" counts as funded — the money exists, the work is on hold.
    const status: "funded" | "pending" =
      statusRaw === "funded" || statusRaw === "paused" ? "funded" : "pending";

    const existing = sourceSpans.get(sourceName);
    if (!existing) {
      sourceSpans.set(sourceName, { status, start: startDate, end: endDate });
    } else {
      if (existing.status !== status) {
        warnings.push(
          `La fuente "${sourceName}" aparece como financiada y pendiente en distintas filas; se usa "financiada".`
        );
        existing.status = "funded";
      }
      if (!existing.start || startDate < existing.start) existing.start = startDate;
      if (!existing.end || endDate > existing.end) existing.end = endDate;
    }

    const notes = row["notes"] == null ? null : String(row["notes"]).trim() || null;

    allocations.push({
      rawTarget,
      targetKey: normalizeName(rawTarget),
      sourceName,
      amount,
      startDate,
      endDate,
      notes,
      row: rowNum,
    });
  }

  const sources: ParsedSource[] = Array.from(sourceSpans.entries())
    .map(([name, v]) => ({
      name,
      status: v.status,
      defaultStartDate: v.start,
      defaultEndDate: v.end,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (people.length === 0 && allocations.length === 0) {
    errors.push("No se encontraron datos de sueldos en el archivo");
  }

  return {
    detectedYear,
    people,
    groups: KNOWN_GROUP_NAMES,
    sources,
    allocations,
    warnings,
    errors,
  };
}
