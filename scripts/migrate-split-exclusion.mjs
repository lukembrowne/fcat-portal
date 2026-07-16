/**
 * Split biochoco_deployments.excluded into excluded_audio + excluded_camera.
 *
 * The single `excluded` flag was written by BOTH the audio and camera-trap QA
 * panels and read by BOTH occupancy streams, so excluding a deployment for one
 * stream (e.g. a failed audio recorder on CCN-010, camera fine) also dropped it
 * from the other. This migration replaces it with two per-stream flags.
 *
 * Steps (each idempotent — safe to re-run):
 *   1. ADD COLUMN excluded_audio / excluded_camera (skipped if present)
 *   2. Backfill BOTH from the old `excluded` value (preserve current behavior:
 *      an existing excluded=1 row becomes excluded_audio=1 AND excluded_camera=1)
 *   3. DROP COLUMN excluded (SQLite >= 3.35; better-sqlite3 bundles far newer)
 *
 * After this runs, the operator re-includes per stream where appropriate
 * (e.g. CCN-010 -> excluded_audio only).
 *
 * Usage (ALWAYS via the container — a bare host run corrupts the WAL under
 * Docker on macOS bind mounts; see the project SQLite-corruption gotcha):
 *   docker compose exec -T portal node scripts/migrate-split-exclusion.mjs
 *   docker compose exec -T portal node scripts/migrate-split-exclusion.mjs --commit
 *
 * Without --commit it runs a DRY RUN (reports what WOULD change, no writes).
 * Run scripts/push-schema.mjs first so the new columns exist in prod, then this.
 */
import Database from "better-sqlite3";
import path from "path";

const commit = process.argv.slice(2).includes("--commit");
const DB_PATH = process.env.DB_PATH || "data/portal.db";
const dbPath = path.isAbsolute(DB_PATH) ? DB_PATH : path.join(process.cwd(), DB_PATH);

const db = new Database(dbPath);
db.pragma("busy_timeout = 5000");

const cols = db.prepare(`PRAGMA table_info(biochoco_deployments)`).all().map((c) => c.name);
const hasExcluded = cols.includes("excluded");
const hasAudio = cols.includes("excluded_audio");
const hasCamera = cols.includes("excluded_camera");

console.log(`DB: ${dbPath}`);
console.log(`Columns present — excluded:${hasExcluded} excluded_audio:${hasAudio} excluded_camera:${hasCamera}`);

if (!hasExcluded && hasAudio && hasCamera) {
  console.log("Already migrated (no `excluded` column, both new columns present). Nothing to do.");
  db.close();
  process.exit(0);
}

// Report the backfill impact from the old column while it still exists.
if (hasExcluded) {
  const n = db.prepare(`SELECT COUNT(*) AS n FROM biochoco_deployments WHERE excluded = 1`).get().n;
  const total = db.prepare(`SELECT COUNT(*) AS n FROM biochoco_deployments`).get().n;
  console.log(`${n} of ${total} deployments have excluded=1 -> will set excluded_audio=1 AND excluded_camera=1`);
}

if (!commit) {
  console.log("\nDRY RUN — re-run with --commit to apply.");
  db.close();
  process.exit(0);
}

const migrate = db.transaction(() => {
  if (!hasAudio) db.exec(`ALTER TABLE biochoco_deployments ADD COLUMN excluded_audio INTEGER NOT NULL DEFAULT 0`);
  if (!hasCamera) db.exec(`ALTER TABLE biochoco_deployments ADD COLUMN excluded_camera INTEGER NOT NULL DEFAULT 0`);
  if (hasExcluded) {
    db.exec(`UPDATE biochoco_deployments SET excluded_audio = excluded, excluded_camera = excluded`);
    db.exec(`ALTER TABLE biochoco_deployments DROP COLUMN excluded`);
  }
});
migrate();

const after = db.prepare(`PRAGMA table_info(biochoco_deployments)`).all().map((c) => c.name);
console.log(`\nDone. Columns now — excluded:${after.includes("excluded")} excluded_audio:${after.includes("excluded_audio")} excluded_camera:${after.includes("excluded_camera")}`);
db.close();
