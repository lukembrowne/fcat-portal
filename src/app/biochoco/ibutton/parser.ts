/**
 * iButton .xlsx file parser
 *
 * Parses iButton temperature logger data exported as .xlsx from OneWireViewer.
 * Format: ~20 header rows with device metadata, then Date/Time/Value data rows.
 *
 * Timestamps are stored as-is (local Ecuador time, UTC-5, no conversion).
 */

import * as XLSX from "xlsx";

export interface IbuttonMetadata {
  deviceSerial: string | null;
  devicePartNumber: string | null;
  sampleRate: string | null;
  missionStart: string | null;
  dataUnit: string | null;
  missionSampleCount: number | null;
}

export interface IbuttonReading {
  timestamp: string; // "YYYY-MM-DD HH:mm:ss"
  temperatureC: number;
}

export interface IbuttonParseResult {
  metadata: IbuttonMetadata;
  readings: IbuttonReading[];
  errors: string[];
}

/**
 * Extract a metadata value from header rows.
 * Header rows have format: "Label:", "", "Value" (columns A, B, C)
 */
function findHeaderValue(
  rows: (string | number | null)[][],
  label: string
): string | null {
  for (const row of rows) {
    const cell = String(row[0] ?? "").toLowerCase();
    if (cell.startsWith(label.toLowerCase())) {
      // Value is typically in column C (index 2), sometimes B
      const val = row[2] ?? row[1];
      if (val === null || val === undefined) return null;
      const str = String(val).trim();
      return str === "N/A" || str === "" ? null : str;
    }
  }
  return null;
}

/**
 * Parse an iButton .xlsx buffer into structured readings.
 */
export function parseIbuttonXlsx(buffer: Buffer): IbuttonParseResult {
  const errors: string[] = [];

  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: "buffer" });
  } catch {
    return {
      metadata: emptyMetadata(),
      readings: [],
      errors: ["No se pudo leer el archivo .xlsx — formato inválido"],
    };
  }

  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    return {
      metadata: emptyMetadata(),
      readings: [],
      errors: ["El archivo .xlsx no contiene hojas"],
    };
  }

  const sheet = workbook.Sheets[sheetName];
  const allRows: (string | number | null)[][] = XLSX.utils.sheet_to_json(
    sheet,
    { header: 1, defval: null }
  );

  if (allRows.length < 5) {
    return {
      metadata: emptyMetadata(),
      readings: [],
      errors: ["Archivo demasiado corto — se esperan encabezados + datos"],
    };
  }

  // --- Parse metadata from header rows ---
  // Find where data starts (look for "Date" header row)
  let dataStartIdx = -1;
  for (let i = 0; i < Math.min(30, allRows.length); i++) {
    const firstCell = String(allRows[i][0] ?? "").trim().toLowerCase();
    if (firstCell === "date") {
      dataStartIdx = i;
      break;
    }
  }

  if (dataStartIdx === -1) {
    return {
      metadata: emptyMetadata(),
      readings: [],
      errors: [
        'No se encontró la fila de encabezado "Date" — formato inesperado',
      ],
    };
  }

  const headerRows = allRows.slice(0, dataStartIdx);

  const metadata: IbuttonMetadata = {
    deviceSerial: findHeaderValue(headerRows, "Device Serial Number"),
    devicePartNumber: findHeaderValue(headerRows, "Device Part Number"),
    sampleRate: findHeaderValue(headerRows, "sample rate"),
    missionStart: findHeaderValue(headerRows, "Mission Start Time"),
    dataUnit: findHeaderValue(headerRows, "Data Unit"),
    missionSampleCount: (() => {
      const v = findHeaderValue(headerRows, "Mission Sample Count");
      return v ? parseInt(v, 10) || null : null;
    })(),
  };

  // --- Parse data rows ---
  const readings: IbuttonReading[] = [];

  for (let i = dataStartIdx + 1; i < allRows.length; i++) {
    const row = allRows[i];
    if (!row || row.length < 3) continue;

    const dateVal = row[0];
    const timeVal = row[1];
    const tempVal = row[2];

    if (dateVal === null || dateVal === undefined) continue;

    // Parse date — could be a string "YYYY-MM-DD" or an Excel serial number
    let dateStr: string;
    if (typeof dateVal === "number") {
      // Excel serial date
      const d = XLSX.SSF.parse_date_code(dateVal);
      dateStr = `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
    } else {
      dateStr = String(dateVal).trim();
    }

    // Parse time — could be a string "HH:mm:ss" or a fractional day number
    let timeStr: string;
    if (typeof timeVal === "number") {
      // Fractional day → hours:minutes:seconds
      const totalSeconds = Math.round(timeVal * 86400);
      const h = Math.floor(totalSeconds / 3600);
      const m = Math.floor((totalSeconds % 3600) / 60);
      const s = totalSeconds % 60;
      timeStr = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    } else {
      timeStr = String(timeVal ?? "00:00:00").trim();
    }

    // Parse temperature
    const temp = typeof tempVal === "number" ? tempVal : parseFloat(String(tempVal));
    if (isNaN(temp)) {
      errors.push(`Fila ${i + 1}: valor de temperatura no numérico "${tempVal}"`);
      continue;
    }

    const timestamp = `${dateStr} ${timeStr}`;
    readings.push({ timestamp, temperatureC: temp });
  }

  if (readings.length === 0 && errors.length === 0) {
    errors.push("No se encontraron lecturas de temperatura en el archivo");
  }

  return { metadata, readings, errors };
}

function emptyMetadata(): IbuttonMetadata {
  return {
    deviceSerial: null,
    devicePartNumber: null,
    sampleRate: null,
    missionStart: null,
    dataUnit: null,
    missionSampleCount: null,
  };
}
