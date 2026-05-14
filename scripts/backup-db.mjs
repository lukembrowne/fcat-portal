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

const DB_PATH = process.env.DB_PATH || "data/portal.db";
const dbPath = path.isAbsolute(DB_PATH) ? DB_PATH : path.join(process.cwd(), DB_PATH);
const backupDir = path.join(path.dirname(dbPath), "backups");

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

  // Run retention cleanup
  cleanupOldBackups();

  recordEventSql({
    source: "cron",
    eventType: "cron_db_backup",
    severity: "success",
    summary: `Respaldo completado: ${backupFilename} (${(sizeBytes / 1024 / 1024).toFixed(1)} MB)`,
    durationMs: Date.now() - startTime,
    details: { backupFilename, sizeBytes },
  });
}

function cleanupOldBackups() {
  const now = Date.now();
  const HOURS_48 = 48 * 60 * 60 * 1000;
  const DAYS_7 = 7 * 24 * 60 * 60 * 1000;

  const files = fs
    .readdirSync(backupDir)
    .filter((f) => f.startsWith("portal-") && f.endsWith(".db"))
    .map((f) => {
      const stat = fs.statSync(path.join(backupDir, f));
      return { name: f, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime); // newest first

  let deleted = 0;
  const dailyKept = new Set();

  for (const file of files) {
    const age = now - file.mtime;

    // Keep all hourly backups from last 48 hours
    if (age <= HOURS_48) {
      continue;
    }

    // Keep one per day (newest) for 7 days
    if (age <= DAYS_7) {
      const date = new Date(file.mtime)
        .toLocaleDateString("sv-SE", { timeZone: "America/New_York" });
      if (!dailyKept.has(date)) {
        dailyKept.add(date);
        continue;
      }
    }

    // Delete everything else
    const filePath = path.join(backupDir, file.name);
    fs.unlinkSync(filePath);
    // Clean up any associated WAL/SHM files
    for (const ext of ["-wal", "-shm"]) {
      const extra = filePath + ext;
      if (fs.existsSync(extra)) fs.unlinkSync(extra);
    }
    deleted++;
  }

  if (deleted > 0) {
    console.log(
      `[backup] Cleaned up ${deleted} old backup(s), ${files.length - deleted} remaining`
    );
  }
}

main().catch((e) => {
  console.error(`[backup] Fatal error: ${e.message}`);
  process.exit(1);
});
