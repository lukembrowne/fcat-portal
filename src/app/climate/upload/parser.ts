/**
 * Campbell Scientific TOA5 .dat file parser
 *
 * Parses both hourly and 15-minute resolution files from the CS300 datalogger.
 * Format: 4 header rows (metadata, column names, units, aggregation type)
 * followed by CSV data rows with quoted fields.
 *
 * Timestamps are stored as-is (local Ecuador time, UTC-5, no conversion).
 */

import type { ClimateResolution } from "@/db/schema";

export interface ParsedRow {
  timestamp: string;
  resolution: ClimateResolution;
  recordNum: number | null;
  airTempAvg: number | null;
  airTempMax: number | null;
  airTempMin: number | null;
  humidityAvg: number | null;
  humidityMax: number | null;
  humidityMin: number | null;
  pressureAvg: number | null;
  pressureMax: number | null;
  pressureMin: number | null;
  rainMm: number | null;
  solarAvg: number | null;
  solarMax: number | null;
  solarMin: number | null;
  windDirAvg: number | null;
  windDirMax: number | null;
  windDirMin: number | null;
  windSpeedAvg: number | null;
  windSpeedMax: number | null;
  windSpeedMin: number | null;
  meanWindSpeed: number | null;
  meanWindDirection: number | null;
  stdWindDir: number | null;
}

export interface ParseError {
  line: number;
  message: string;
}

export interface ParseResult {
  resolution: ClimateResolution;
  rows: ParsedRow[];
  errors: ParseError[];
  dateRange: { start: string; end: string } | null;
}

/** Column name from the datalogger → ParsedRow field name */
const COLUMN_MAP: Record<string, keyof ParsedRow> = {
  TIMESTAMP: "timestamp",
  RECORD: "recordNum",
  AirTC_Avg: "airTempAvg",
  AirTC_Max: "airTempMax",
  AirTC_Min: "airTempMin",
  RH_Avg: "humidityAvg",
  RH_Max: "humidityMax",
  RH_Min: "humidityMin",
  Pressure_Avg: "pressureAvg",
  Pressure_Max: "pressureMax",
  Pressure_Min: "pressureMin",
  Rain_mm_Tot: "rainMm",
  Slrw_Avg: "solarAvg",
  Slrw_Max: "solarMax",
  Slrw_Min: "solarMin",
  WindDir_Avg: "windDirAvg",
  WindDir_Max: "windDirMax",
  WindDir_Min: "windDirMin",
  WS_ms_Avg: "windSpeedAvg",
  WS_ms_Max: "windSpeedMax",
  WS_ms_Min: "windSpeedMin",
  mean_wind_speed: "meanWindSpeed",
  mean_wind_direction: "meanWindDirection",
  std_wind_dir: "stdWindDir",
};

/**
 * Parse a single CSV line handling quoted fields.
 * Campbell Scientific wraps all fields in double quotes.
 */
export function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
        current += '"';
        i++; // skip escaped quote
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

/** Convert a string value to a number, returning null for NaN/"NAN"/empty. */
function toNum(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.toUpperCase() === "NAN") return null;
  const num = Number(trimmed);
  return isNaN(num) ? null : num;
}

/**
 * Parse a Campbell Scientific TOA5 .dat file.
 *
 * @param content - File content as a string
 * @returns ParseResult with rows, errors, detected resolution, and date range
 */
export function parseTOA5File(content: string): ParseResult {
  const lines = content.split(/\r?\n/).filter((l) => l.trim() !== "");

  if (lines.length < 5) {
    return {
      resolution: "hourly",
      rows: [],
      errors: [{ line: 1, message: "Archivo demasiado corto — se esperan al menos 5 líneas (4 encabezados + datos)" }],
      dateRange: null,
    };
  }

  // Row 1: TOA5 metadata — validate and detect resolution
  const metaFields = parseCSVLine(lines[0]);
  if (metaFields[0] !== "TOA5") {
    return {
      resolution: "hourly",
      rows: [],
      errors: [{ line: 1, message: `Formato no válido: se esperaba "TOA5" pero se encontró "${metaFields[0]}"` }],
      dateRange: null,
    };
  }

  // Detect resolution from table name in metadata (last field)
  const tableName = metaFields[metaFields.length - 1] || "";
  const resolution: ClimateResolution = tableName.toLowerCase().includes("min15") ||
    tableName.toLowerCase().includes("registromin15")
    ? "15min"
    : "hourly";

  // Row 2: Column names
  const columnNames = parseCSVLine(lines[1]);

  // Build column index mapping: position → field name
  const columnMapping: { index: number; field: keyof ParsedRow }[] = [];
  for (let i = 0; i < columnNames.length; i++) {
    const mapped = COLUMN_MAP[columnNames[i]];
    if (mapped) {
      columnMapping.push({ index: i, field: mapped });
    }
  }

  // Rows 3-4: Units and aggregation type — skip
  // Rows 5+: Data
  const rows: ParsedRow[] = [];
  const errors: ParseError[] = [];

  for (let lineIdx = 4; lineIdx < lines.length; lineIdx++) {
    const lineNum = lineIdx + 1; // 1-based line number
    try {
      const fields = parseCSVLine(lines[lineIdx]);

      // Validate field count
      if (fields.length < columnNames.length - 2) {
        errors.push({ line: lineNum, message: `Número de campos insuficiente: ${fields.length} (esperado ~${columnNames.length})` });
        continue;
      }

      const row: Partial<ParsedRow> = { resolution };

      for (const { index, field } of columnMapping) {
        if (index >= fields.length) continue;
        const value = fields[index];

        if (field === "timestamp") {
          row.timestamp = value;
        } else if (field === "recordNum") {
          row.recordNum = toNum(value) !== null ? Math.round(toNum(value)!) : null;
        } else {
          // All other fields are numeric
          (row as Record<string, number | null>)[field] = toNum(value);
        }
      }

      if (!row.timestamp) {
        errors.push({ line: lineNum, message: "Falta TIMESTAMP" });
        continue;
      }

      rows.push(row as ParsedRow);
    } catch (e) {
      errors.push({
        line: lineNum,
        message: `Error al procesar: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  const dateRange =
    rows.length > 0
      ? {
          start: rows[0].timestamp,
          end: rows[rows.length - 1].timestamp,
        }
      : null;

  return { resolution, rows, errors, dateRange };
}
