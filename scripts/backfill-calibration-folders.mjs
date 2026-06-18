/**
 * Backfill the `calibracion_de_audio` (Calibración de Audio) subfolder into
 * every existing BioChoco deployment folder, and record its Drive ID in
 * `biochoco_deployments.upload_calibration_folder_id`.
 *
 * New deployments get this folder automatically (createDeploymentFolder); this
 * one-off backfills the ones created before that change shipped.
 *
 * Idempotent + resume-safe: only touches rows with a non-null drive_folder_id
 * and a NULL upload_calibration_folder_id, and reuses an existing subfolder if
 * one is already there. Safe to re-run.
 *
 * Run INSIDE the container (never from the host while the container is up — that
 * corrupts the SQLite WAL over the macOS bind mount):
 *   docker compose exec portal node scripts/backfill-calibration-folders.mjs
 *
 * Plain .mjs using only better-sqlite3 + googleapis (no devDependencies), so it
 * runs in the standalone prod runner image without `--include=dev`.
 */

import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import path from "path";
import Database from "better-sqlite3";
import { google } from "googleapis";

const CALIBRATION_FOLDER = "calibracion_de_audio";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const CONCURRENCY = 10;

const DB_PATH = process.env.DB_PATH || "data/portal.db";
const dbPath = path.isAbsolute(DB_PATH) ? DB_PATH : path.join(process.cwd(), DB_PATH);

const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
if (!raw) {
  console.error("GOOGLE_SERVICE_ACCOUNT_KEY not set");
  process.exit(1);
}
const key = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
const auth = new google.auth.GoogleAuth({
  credentials: key,
  scopes: ["https://www.googleapis.com/auth/drive"],
});
const drive = google.drive({ version: "v3", auth });

const db = new Database(dbPath);
db.pragma("busy_timeout = 5000");

/** Retry a Drive call a few times on transient (429/5xx) errors. */
async function withRetry(fn, label, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const code = err?.code ?? err?.response?.status;
      const retriable = code === 429 || (typeof code === "number" && code >= 500);
      if (!retriable || i === attempts - 1) throw err;
      const delay = 500 * 2 ** i;
      console.warn(`  retry ${label} (attempt ${i + 1}, code ${code}) in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/** True if the deployment folder still exists and isn't trashed. */
async function parentIsLive(folderId) {
  try {
    const meta = await withRetry(
      () => drive.files.get({ fileId: folderId, fields: "id, trashed", supportsAllDrives: true }),
      `files.get(${folderId})`,
    );
    return !meta.data.trashed;
  } catch {
    return false;
  }
}

/** Ensure the calibration subfolder exists under the parent; return its ID. */
async function ensureCalibrationFolder(parentFolderId) {
  const existing = await withRetry(
    () =>
      drive.files.list({
        q: `'${parentFolderId}' in parents and name = '${CALIBRATION_FOLDER}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
        fields: "files(id)",
        pageSize: 1,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      }),
    `files.list(${parentFolderId})`,
  );
  const existingId = existing.data.files?.[0]?.id;
  if (existingId) return existingId;

  const created = await withRetry(
    () =>
      drive.files.create({
        requestBody: { name: CALIBRATION_FOLDER, mimeType: FOLDER_MIME, parents: [parentFolderId] },
        fields: "id",
        supportsAllDrives: true,
      }),
    `files.create(${parentFolderId})`,
  );
  return created.data.id ?? null;
}

const rows = db
  .prepare(
    `SELECT id, name, drive_folder_id AS driveFolderId
       FROM biochoco_deployments
      WHERE drive_folder_id IS NOT NULL
        AND upload_calibration_folder_id IS NULL`,
  )
  .all();

console.log(`Found ${rows.length} deployment(s) needing the calibration folder.\n`);

const updateStmt = db.prepare(
  `UPDATE biochoco_deployments SET upload_calibration_folder_id = ? WHERE id = ?`,
);

let ok = 0;
let skipped = 0;
let failed = 0;

async function processRow(row) {
  try {
    if (!(await parentIsLive(row.driveFolderId))) {
      console.warn(`  SKIP ${row.name}: deployment folder trashed/missing`);
      skipped++;
      return;
    }
    const folderId = await ensureCalibrationFolder(row.driveFolderId);
    if (!folderId) {
      console.error(`  FAIL ${row.name}: no folder ID returned`);
      failed++;
      return;
    }
    updateStmt.run(folderId, row.id);
    console.log(`  OK   ${row.name} → ${folderId}`);
    ok++;
  } catch (err) {
    console.error(`  FAIL ${row.name}: ${err?.message ?? err}`);
    failed++;
  }
}

// Bounded concurrency: process in batches of CONCURRENCY.
for (let i = 0; i < rows.length; i += CONCURRENCY) {
  const batch = rows.slice(i, i + CONCURRENCY);
  await Promise.all(batch.map(processRow));
}

db.close();

console.log(`\nDone. ${ok} created/linked, ${skipped} skipped, ${failed} failed.`);
if (failed > 0) process.exitCode = 1;
