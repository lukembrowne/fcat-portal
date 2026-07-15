/**
 * Backfill biochoco_images.file_modified for video-derived frame rows.
 *
 * Frames extracted from camera-trap videos were inserted with a NULL
 * file_modified (and often NULL exif_timestamp), so occupancy's capture-date
 * resolver dropped them as dateless. The source video's file_modified (the SD-
 * card mtime = camera clock) is the correct capture-day signal and already
 * lives in biochoco_videos. This copies it onto each frame row.
 *
 * Both columns store Unix SECONDS, so the value is copied verbatim — no
 * conversion. Idempotent: only touches rows still NULL, so it's safe to re-run.
 *
 * Usage (always via the container to avoid host/Docker SQLite corruption):
 *   docker compose exec -T portal node scripts/backfill-frame-file-modified.mjs
 *   docker compose exec -T portal node scripts/backfill-frame-file-modified.mjs --commit
 *
 * Without --commit it runs a dry run (reports what WOULD change, no writes).
 */
import Database from "better-sqlite3";

const commit = process.argv.includes("--commit");
const db = new Database("data/portal.db");

const candidates = db
  .prepare(
    `SELECT COUNT(*) AS n
     FROM biochoco_images img
     JOIN biochoco_videos v ON v.id = img.video_id
     WHERE img.file_modified IS NULL
       AND img.video_id IS NOT NULL
       AND v.file_modified IS NOT NULL`,
  )
  .get();

const stillNull = db
  .prepare(
    `SELECT COUNT(*) AS n
     FROM biochoco_images img
     WHERE img.file_modified IS NULL
       AND img.video_id IS NOT NULL
       AND (img.video_id NOT IN (SELECT id FROM biochoco_videos WHERE file_modified IS NOT NULL))`,
  )
  .get();

console.log(`Frame rows to backfill (source video has a mtime): ${candidates.n}`);
console.log(`Frame rows that will REMAIN null (source video mtime also null): ${stillNull.n}`);

if (!commit) {
  console.log("\nDry run — no changes written. Re-run with --commit to apply.");
  process.exit(0);
}

const info = db
  .prepare(
    `UPDATE biochoco_images
     SET file_modified = (
       SELECT v.file_modified FROM biochoco_videos v WHERE v.id = biochoco_images.video_id
     )
     WHERE biochoco_images.file_modified IS NULL
       AND biochoco_images.video_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM biochoco_videos v
         WHERE v.id = biochoco_images.video_id AND v.file_modified IS NOT NULL
       )`,
  )
  .run();

console.log(`\nUpdated ${info.changes} frame rows.`);
