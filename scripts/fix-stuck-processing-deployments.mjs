#!/usr/bin/env node

/**
 * One-time cleanup: unstick camera-trap deployments stranded at status
 * "processing".
 *
 * Background: the deployment "processing" state used to be a denormalized
 * `biochoco_deployments.status = "processing"` flag set when an ML job started
 * and reset when it ended. If a job was killed or cancelled through a path that
 * didn't reset the column (or raced with cancelJob), the deployment was
 * stranded showing "Procesando" forever — its reprocess button stayed disabled.
 *
 * Processing state is now derived live from the active-job query, and the column
 * is never set to "processing" again. This script reconciles any rows that still
 * have the legacy value persisted: each becomes "processed" if a completed ML
 * job exists for it, otherwise "scanned" (the same rule cancelJob uses).
 *
 * Idempotent — safe to run repeatedly.
 *
 * Usage:
 *   node scripts/fix-stuck-processing-deployments.mjs
 *   docker compose exec -T portal node scripts/fix-stuck-processing-deployments.mjs
 */

import Database from "better-sqlite3";
import path from "path";

const DB_PATH = process.env.DB_PATH || "data/portal.db";
const dbPath = path.isAbsolute(DB_PATH) ? DB_PATH : path.join(process.cwd(), DB_PATH);

const db = new Database(dbPath);
db.pragma("busy_timeout = 5000");

const stuck = db
  .prepare(
    `SELECT id, name FROM biochoco_deployments WHERE status = 'processing' ORDER BY id`,
  )
  .all();

if (stuck.length === 0) {
  console.log("No deployments stuck at 'processing'. Nothing to do.");
  db.close();
  process.exit(0);
}

const hasCompletedMlJob = db.prepare(
  `SELECT 1 FROM biochoco_processing_jobs
     WHERE deployment_id = ?
       AND status = 'completed'
       AND job_type IN ('ml', 'ml_incremental')
     LIMIT 1`,
);
const update = db.prepare(
  `UPDATE biochoco_deployments SET status = ?, updated_at = ? WHERE id = ?`,
);

// Drizzle stores `mode: "timestamp"` columns as Unix seconds, not ms.
const now = Math.floor(Date.now() / 1000);
const fix = db.transaction((rows) => {
  for (const row of rows) {
    const completed = hasCompletedMlJob.get(row.id);
    const newStatus = completed ? "processed" : "scanned";
    update.run(newStatus, now, row.id);
    console.log(`  #${row.id} ${row.name}: processing → ${newStatus}`);
  }
});

console.log(`Found ${stuck.length} deployment(s) stuck at 'processing':`);
fix(stuck);
console.log(`Done. Reconciled ${stuck.length} deployment(s).`);

db.close();
