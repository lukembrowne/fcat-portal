#!/usr/bin/env node

/**
 * Database Backup Script
 *
 * Uses SQLite's online backup API via better-sqlite3 for safe, hot backups.
 * Safe to run while the portal is serving requests.
 *
 * Retention policy:
 * - All hourly backups from last 48 hours
 * - One daily backup (newest of the day) for 7 days
 * - Everything older is deleted
 *
 * Usage:
 *   node scripts/backup-db.mjs
 *   docker compose exec portal node scripts/backup-db.mjs
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import zlib from "zlib";
import { pipeline } from "stream/promises";
import { execFileSync } from "child_process";

const DB_PATH = process.env.DB_PATH || "data/portal.db";
const dbPath = path.isAbsolute(DB_PATH) ? DB_PATH : path.join(process.cwd(), DB_PATH);
const backupDir = path.join(path.dirname(dbPath), "backups");

// --- Space offload config (S3-compatible; see docs/operations/disk-space-runbook.md) ---
const OFFLOAD_ENABLED =
  process.env.BACKUP_OFFLOAD_ENABLED === "true" &&
  !!process.env.SPACES_BUCKET &&
  !!process.env.SPACES_KEY &&
  !!process.env.SPACES_SECRET &&
  !!process.env.SPACES_ENDPOINT;
const SPACES_BUCKET = process.env.SPACES_BUCKET || "";
// Local window kept on the box when offload succeeds: newest N hourly + newest daily.
// The Space holds the long-term history; older local files are pruned only after
// their upload is confirmed. Tunable via env without a redeploy.
const LOCAL_KEEP_HOURLY = parseInt(process.env.BACKUP_LOCAL_KEEP_HOURLY || "6", 10);
const LOCAL_KEEP_DAILY = parseInt(process.env.BACKUP_LOCAL_KEEP_DAILY || "1", 10);

/** Common s3cmd flags (auth + DO Spaces host). Returns an argv array. */
function s3Flags() {
  const endpoint = process.env.SPACES_ENDPOINT || "";
  return [
    `--access_key=${process.env.SPACES_KEY || ""}`,
    `--secret_key=${process.env.SPACES_SECRET || ""}`,
    `--host=${endpoint}`,
    `--host-bucket=%(bucket)s.${endpoint}`,
  ];
}

/** Gzip a file to `${src}.gz` (streamed — bounds memory on the ~700 MB DB). */
async function gzipFile(src) {
  const dest = `${src}.gz`;
  await pipeline(
    fs.createReadStream(src),
    zlib.createGzip({ level: 6 }),
    fs.createWriteStream(dest),
  );
  return dest;
}

/** Upload a local backup to the Space. Throws on non-zero exit. */
function s3Put(localPath) {
  const name = path.basename(localPath);
  execFileSync(
    "s3cmd",
    ["put", localPath, `s3://${SPACES_BUCKET}/${name}`, ...s3Flags()],
    { stdio: "pipe" },
  );
}

/** Set of backup filenames currently present in the Space (empty on failure). */
function s3ListNames() {
  try {
    const out = execFileSync(
      "s3cmd",
      ["ls", `s3://${SPACES_BUCKET}/`, ...s3Flags()],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    const names = new Set();
    for (const line of out.split("\n")) {
      const m = line.trim().match(/(portal-[^/\s]+\.db\.gz)\s*$/);
      if (m) names.add(m[1]);
    }
    return names;
  } catch {
    return null; // signal "could not list" — callers must not prune
  }
}

/**
 * Insert a `system_events` row into the main DB. Mirrors `recordEvent` in
 * src/lib/system-events.ts but uses raw SQL because this script runs as plain
 * Node (no TS, no Drizzle). Best-effort: any failure logs to stderr and
 * returns — never throws.
 */
function recordEventSql({ source, eventType, summary, severity, durationMs, details }) {
  try {
    const writer = new Database(dbPath);
    writer.pragma("busy_timeout = 5000");
    writer
      .prepare(
        `INSERT INTO system_events
           (event_type, source, severity, actor_email, summary, duration_ms, details)
         VALUES (?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        eventType,
        source,
        severity ?? "info",
        summary,
        durationMs ?? null,
        details ? JSON.stringify(details) : null,
      );
    writer.close();
  } catch (e) {
    console.error(`[backup] Failed to record system_event: ${e.message}`);
  }
}

async function main() {
  // Ensure backup directory exists
  fs.mkdirSync(backupDir, { recursive: true });

  // Check source DB exists
  if (!fs.existsSync(dbPath)) {
    console.error(`[backup] Source database not found: ${dbPath}`);
    process.exit(1);
  }

  // Generate backup filename with Eastern time timestamp
  const now = new Date();
  const startTime = Date.now();
  const timestamp = now
    .toLocaleString("sv-SE", { timeZone: "America/New_York" })
    .replace(/[:.]/g, "-")
    .replace(" ", "T");
  const backupFilename = `portal-${timestamp}.db`;
  const backupPath = path.join(backupDir, backupFilename);

  // Perform backup using SQLite's online backup API
  console.log(`[backup] Starting backup: ${backupFilename}`);
  let sizeBytes = 0;
  try {
    const source = new Database(dbPath, { readonly: true });
    await source.backup(backupPath);
    source.close();

    const stat = fs.statSync(backupPath);
    sizeBytes = stat.size;
    console.log(`[backup] Backup complete: ${(stat.size / 1024 / 1024).toFixed(1)}MB`);

    // Verify backup integrity
    const backup = new Database(backupPath, { readonly: true });
    const integrity = backup.pragma("integrity_check");
    backup.close();

    if (integrity[0]?.integrity_check !== "ok") {
      console.error("[backup] WARNING: Backup failed integrity check!");
      fs.unlinkSync(backupPath);
      recordEventSql({
        source: "cron",
        eventType: "cron_db_backup",
        severity: "error",
        summary: `Respaldo falló verificación de integridad: ${backupFilename}`,
        durationMs: Date.now() - startTime,
        details: { backupFilename, reason: "integrity_check_failed" },
      });
      process.exit(1);
    }
    console.log("[backup] Integrity check: ok");
  } catch (e) {
    console.error(`[backup] Backup failed: ${e.message}`);
    // Clean up partial backup
    if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath);
    recordEventSql({
      source: "cron",
      eventType: "cron_db_backup",
      severity: "error",
      summary: `Respaldo falló: ${e.message}`,
      durationMs: Date.now() - startTime,
      details: { backupFilename, error: e.message },
    });
    process.exit(1);
  }

  // Compress the verified backup. Integrity was checked on the uncompressed .db
  // above (it needs a live SQLite handle); compress only after "ok".
  let gzPath;
  let gzBytes = 0;
  const gzFilename = `${backupFilename}.gz`;
  try {
    gzPath = await gzipFile(backupPath);
    gzBytes = fs.statSync(gzPath).size;
    fs.unlinkSync(backupPath); // remove the uncompressed copy
    // The integrity check opened the WAL-mode backup, creating -wal/-shm
    // sidecars. The .db is gone now, so clean up its orphaned sidecars too.
    for (const ext of ["-wal", "-shm"]) {
      const sidecar = backupPath + ext;
      if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
    }
    console.log(
      `[backup] Compressed: ${gzFilename} (${(gzBytes / 1024 / 1024).toFixed(1)}MB, ` +
        `${((1 - gzBytes / sizeBytes) * 100).toFixed(0)}% smaller)`,
    );
  } catch (e) {
    console.error(`[backup] Compression failed: ${e.message}`);
    // Leave the verified .db in place (still a valid backup); next run's
    // conservative cleanup handles it. Don't offload/prune on a failed compress.
    recordEventSql({
      source: "cron",
      eventType: "cron_db_backup",
      severity: "error",
      summary: `Respaldo comprimido falló: ${e.message}`,
      durationMs: Date.now() - startTime,
      details: { backupFilename, error: e.message },
    });
    process.exit(1);
  }

  // Offload to the Space (if enabled), then prune. NEVER prune a file that isn't
  // confirmed in the Space: upload-verify-then-prune.
  let offloaded = false;
  let offloadError = null;
  if (OFFLOAD_ENABLED) {
    try {
      s3Put(gzPath);
      offloaded = true;
      console.log(`[backup] Uploaded to Space: s3://${SPACES_BUCKET}/${gzFilename}`);
    } catch (e) {
      offloadError = e.message;
      console.error(`[backup] Space upload failed: ${e.message}`);
    }
  }

  if (OFFLOAD_ENABLED && offloaded) {
    // Tight local window — but only delete local files confirmed present in the Space.
    const spaceNames = s3ListNames();
    if (spaceNames) {
      pruneLocalWindow(spaceNames);
    } else {
      console.warn("[backup] Could not list Space — skipping local prune this run");
    }
  } else {
    // Offload disabled OR upload failed: keep the conservative local retention
    // so we never drop history that isn't safely offloaded.
    cleanupConservative();
  }

  if (OFFLOAD_ENABLED && !offloaded) {
    recordEventSql({
      source: "cron",
      eventType: "cron_db_backup",
      severity: "warn",
      summary: `Respaldo local OK pero la subida al Space falló: ${offloadError}`,
      durationMs: Date.now() - startTime,
      details: { backupFilename: gzFilename, gzBytes, offloadError },
    });
  }

  recordEventSql({
    source: "cron",
    eventType: "cron_db_backup",
    severity: "success",
    summary:
      `Respaldo completado: ${gzFilename} (${(gzBytes / 1024 / 1024).toFixed(1)} MB` +
      `${offloaded ? ", subido al Space" : OFFLOAD_ENABLED ? ", NO subido" : ""})`,
    durationMs: Date.now() - startTime,
    details: { backupFilename: gzFilename, sizeBytes, gzBytes, offloaded, offloadEnabled: OFFLOAD_ENABLED },
  });
}

/**
 * Tight local retention used when a backup was successfully offloaded: keep the
 * newest LOCAL_KEEP_HOURLY backups + LOCAL_KEEP_DAILY newest-per-day extras.
 * Deletes older local files ONLY when they are confirmed present in the Space.
 */
function pruneLocalWindow(spaceNames) {
  const files = listBackupFiles(); // newest first
  const keep = new Set();
  const daysKept = new Set();

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (keep.size < LOCAL_KEEP_HOURLY) {
      keep.add(f.name);
      daysKept.add(dayOf(f.mtime));
    }
  }
  // Keep up to LOCAL_KEEP_DAILY newest files whose day isn't already covered.
  let dailyExtra = 0;
  for (const f of files) {
    if (dailyExtra >= LOCAL_KEEP_DAILY) break;
    if (keep.has(f.name)) continue;
    const day = dayOf(f.mtime);
    if (!daysKept.has(day)) {
      keep.add(f.name);
      daysKept.add(day);
      dailyExtra++;
    }
  }

  let deleted = 0;
  for (const f of files) {
    if (keep.has(f.name)) continue;
    // Safety: never delete a local file that isn't confirmed in the Space.
    if (!spaceNames.has(f.name)) continue;
    deleteBackupFile(f.name);
    deleted++;
  }
  if (deleted > 0) {
    console.log(
      `[backup] Pruned ${deleted} local backup(s) (offloaded); ${keep.size} kept locally`,
    );
  }
}

function dayOf(mtimeMs) {
  return new Date(mtimeMs).toLocaleDateString("sv-SE", {
    timeZone: "America/New_York",
  });
}

/** All local backups (compressed .db.gz and legacy .db), newest first. */
function listBackupFiles() {
  return fs
    .readdirSync(backupDir)
    .filter(
      (f) => f.startsWith("portal-") && (f.endsWith(".db.gz") || f.endsWith(".db")),
    )
    .map((f) => {
      const stat = fs.statSync(path.join(backupDir, f));
      return { name: f, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/** Delete a backup file plus any legacy WAL/SHM sidecars (only legacy .db has them). */
function deleteBackupFile(name) {
  const filePath = path.join(backupDir, name);
  fs.unlinkSync(filePath);
  if (name.endsWith(".db")) {
    for (const ext of ["-wal", "-shm"]) {
      const extra = filePath + ext;
      if (fs.existsSync(extra)) fs.unlinkSync(extra);
    }
  }
}

/**
 * Conservative local retention used when offload is OFF or an upload failed:
 * keep all hourly backups from the last 48h + one newest-per-day for 7 days.
 * Handles both compressed (.db.gz) and legacy (.db) files.
 */
function cleanupConservative() {
  const now = Date.now();
  const HOURS_48 = 48 * 60 * 60 * 1000;
  const DAYS_7 = 7 * 24 * 60 * 60 * 1000;

  const files = listBackupFiles(); // newest first
  let deleted = 0;
  const dailyKept = new Set();

  for (const file of files) {
    const age = now - file.mtime;
    if (age <= HOURS_48) continue; // keep all recent hourlies
    if (age <= DAYS_7) {
      const date = dayOf(file.mtime);
      if (!dailyKept.has(date)) {
        dailyKept.add(date);
        continue;
      }
    }
    deleteBackupFile(file.name);
    deleted++;
  }

  if (deleted > 0) {
    console.log(
      `[backup] Cleaned up ${deleted} old backup(s), ${files.length - deleted} remaining`,
    );
  }
}

main().catch((e) => {
  console.error(`[backup] Fatal error: ${e.message}`);
  process.exit(1);
});
