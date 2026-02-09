/**
 * Google Sheets client for BioChoco schedule data.
 *
 * Service account auth. Reads/writes the main schedule sheet and SlotTemplate tab.
 */

import "server-only";

import { google, type sheets_v4 } from "googleapis";
import type { ScheduleRow, SlotRow, ScheduleRowUpdate } from "./schedule-types";

const SHEET_ID = process.env.BIOCHOCO_SHEET_ID;

function getServiceAccountKey(): Record<string, string> {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY not configured");
  return JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
}

let sheetsClient: sheets_v4.Sheets | null = null;

function getSheets(): sheets_v4.Sheets {
  if (sheetsClient) return sheetsClient;

  const key = getServiceAccountKey();
  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

function requireSheetId(): string {
  if (!SHEET_ID) throw new Error("BIOCHOCO_SHEET_ID not configured");
  return SHEET_ID;
}

// --- Column mapping: Google Sheets header → ScheduleRow field ---

const HEADER_MAP: Record<string, keyof ScheduleRow> = {
  deployment_id: "deploymentId",
  site_id: "siteId",
  site_name: "siteName",
  habitat_type: "habitatType",
  visit_number: "visitNumber",
  season: "season",
  planned_deploy_date: "plannedDeployDate",
  planned_retrieve_date: "plannedRetrieveDate",
  actual_deploy_date: "actualDeployDate",
  actual_retrieve_date: "actualRetrieveDate",
  status: "status",
  deploy_slot_id: "deploySlotId",
  retrieve_slot_id: "retrieveSlotId",
  notes: "notes",
};

const REVERSE_HEADER_MAP = Object.fromEntries(
  Object.entries(HEADER_MAP).map(([k, v]) => [v, k])
);

function parseRow(headers: string[], values: string[]): ScheduleRow {
  const raw: Record<string, string> = {};
  headers.forEach((h, i) => {
    raw[h] = values[i] ?? "";
  });

  return {
    deploymentId: raw.deployment_id ?? "",
    siteId: raw.site_id ?? "",
    siteName: raw.site_name ?? "",
    habitatType: raw.habitat_type ?? "",
    visitNumber: parseInt(raw.visit_number, 10) || 0,
    season: raw.season ?? "",
    plannedDeployDate: raw.planned_deploy_date || null,
    plannedRetrieveDate: raw.planned_retrieve_date || null,
    actualDeployDate: raw.actual_deploy_date || null,
    actualRetrieveDate: raw.actual_retrieve_date || null,
    status: (raw.status as ScheduleRow["status"]) || "scheduled",
    deploySlotId: raw.deploy_slot_id ? parseInt(raw.deploy_slot_id, 10) : null,
    retrieveSlotId: raw.retrieve_slot_id ? parseInt(raw.retrieve_slot_id, 10) : null,
    notes: raw.notes ?? "",
  };
}

// ============================================================
// Public API
// ============================================================

/**
 * Load all schedule rows from the main (first) sheet tab.
 */
export async function loadSchedule(): Promise<ScheduleRow[]> {
  const sheets = getSheets();
  const spreadsheetId = requireSheetId();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Sheet1",
  });

  const rows = res.data.values;
  if (!rows || rows.length < 2) return [];

  const headers = rows[0] as string[];
  return rows.slice(1).map((row) => parseRow(headers, row as string[]));
}

/**
 * Overwrite the entire schedule sheet with new data.
 *
 * Write-then-clear: writes new data first, then clears leftover rows below.
 * If the process crashes between write and clear, stale rows may remain at
 * the bottom but no data is lost. This is recoverable, unlike clear-then-write
 * which can destroy all data on crash.
 */
export async function saveSchedule(rows: ScheduleRow[]): Promise<void> {
  const sheets = getSheets();
  const spreadsheetId = requireSheetId();

  // Build header from REVERSE_HEADER_MAP keys in the original column order
  const headers = Object.keys(HEADER_MAP);
  const dataRows = rows.map((row) =>
    headers.map((h) => {
      const field = HEADER_MAP[h];
      const val = row[field];
      return val === null || val === undefined ? "" : String(val);
    })
  );

  const newValues = [headers, ...dataRows];
  const newRowCount = newValues.length;

  // Step 1: Read current row count to know what to clean up
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Sheet1",
  });
  const oldRowCount = existing.data.values?.length ?? 0;

  // Step 2: Write new data (overwrites existing rows in range)
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: "Sheet1!A1",
    valueInputOption: "RAW",
    requestBody: { values: newValues },
  });

  // Step 3: Clear leftover rows below new data (if old sheet was longer)
  if (oldRowCount > newRowCount) {
    await sheets.spreadsheets.values.clear({
      spreadsheetId,
      range: `Sheet1!A${newRowCount + 1}:${String.fromCharCode(64 + headers.length)}${oldRowCount}`,
    });
  }
}

/**
 * Update specific fields on specific rows (by deploymentId).
 */
export async function updateScheduleRows(
  updates: ScheduleRowUpdate[]
): Promise<void> {
  const sheets = getSheets();
  const spreadsheetId = requireSheetId();

  // Read all data to find row indices
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Sheet1",
  });

  const allRows = res.data.values;
  if (!allRows || allRows.length < 2) return;

  const headers = allRows[0] as string[];
  const deploymentIdCol = headers.indexOf("deployment_id");
  if (deploymentIdCol === -1) return;

  const batchUpdates: sheets_v4.Schema$ValueRange[] = [];

  for (const update of updates) {
    // Find the row index (0-based in data, +2 for 1-indexed header)
    const rowIdx = allRows.findIndex(
      (row, i) => i > 0 && row[deploymentIdCol] === update.deploymentId
    );
    if (rowIdx === -1) continue;

    const sheetRow = rowIdx + 1; // 1-indexed

    for (const [field, value] of Object.entries(update.fields)) {
      const colHeader = REVERSE_HEADER_MAP[field] ?? field;
      const colIdx = headers.indexOf(colHeader);
      if (colIdx === -1) continue;

      const colLetter = String.fromCharCode(65 + colIdx); // A=0, B=1, etc.
      batchUpdates.push({
        range: `Sheet1!${colLetter}${sheetRow}`,
        values: [[value === null ? "" : String(value)]],
      });
    }
  }

  if (batchUpdates.length > 0) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId,
      requestBody: {
        valueInputOption: "RAW",
        data: batchUpdates,
      },
    });
  }
}

/**
 * Load the SlotTemplate tab — maps slot IDs to calendar dates.
 */
export async function loadSlotTemplate(): Promise<SlotRow[]> {
  const sheets = getSheets();
  const spreadsheetId = requireSheetId();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "SlotTemplate",
  });

  const rows = res.data.values;
  if (!rows || rows.length < 2) return [];

  const headers = rows[0] as string[];
  return rows.slice(1).map((row) => {
    const raw: Record<string, string> = {};
    headers.forEach((h, i) => {
      raw[h] = (row as string[])[i] ?? "";
    });
    return {
      slotId: parseInt(raw.slot_id, 10) || 0,
      slotDate: raw.slot_date ?? "",
      yearMonth: raw.year_month ?? "",
      dayOfMonth: parseInt(raw.day_of_month, 10) || 0,
    };
  });
}
