/**
 * Backfill biochoco_images.file_modified for video-derived frame rows.
 *
 * Frames extracted from camera-trap videos were inserted with a NULL
 * file_modified (and often NULL exif_timestamp), so occupancy's capture-date
 * resolver dropped them as dateless. The source video's file_modified (the SD-
 * card mtime = camera clock) is the correct capture-day signal and already
 * lives in biochoco_videos. This copies it onto each frame row.
 *
 * SCOPED to the BioChoco camera-trap project only (matching how occupancy
 * scopes deployments: biochoco_deployments.ct_project_id -> ct_projects.name).
 * Older/other projects' video frames are deliberately left untouched. Override
 * with --project "<name>", or --all-projects to touch every project.
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

const argv = process.argv.slice(2);
const commit = argv.includes("--commit");
const allProjects = argv.includes("--all-projects");
const projIdx = argv.indexOf("--project");
const projectName = projIdx !== -1 ? argv[projIdx + 1] : "BioChoco";

const db = new Database("data/portal.db");

// Restrict to one project's deployments unless --all-projects is passed.
// Empty string => no restriction.
const scopeSql = allProjects
  ? ""
  : `AND img.deployment_id IN (
       SELECT id FROM biochoco_deployments
       WHERE ct_project_id = (SELECT id FROM ct_projects WHERE name = @projectName)
     )`;

const scopeArgs = allProjects ? {} : { projectName };

console.log(
  allProjects
    ? "Scope: ALL camera-trap projects"
    : `Scope: project "${projectName}" only`,
);

const candidates = db
  .prepare(
    `SELECT COUNT(*) AS n
     FROM biochoco_images img
     JOIN biochoco_videos v ON v.id = img.video_id
     WHERE img.file_modified IS NULL
       AND img.video_id IS NOT NULL
       AND v.file_modified IS NOT NULL
       ${scopeSql}`,
  )
  .get(scopeArgs);

const stillNull = db
  .prepare(
    `SELECT COUNT(*) AS n
     FROM biochoco_images img
     WHERE img.file_modified IS NULL
       AND img.video_id IS NOT NULL
       AND img.video_id NOT IN (SELECT id FROM biochoco_videos WHERE file_modified IS NOT NULL)
       ${scopeSql}`,
  )
  .get(scopeArgs);

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
       )
       ${allProjects ? "" : `AND biochoco_images.deployment_id IN (
         SELECT id FROM biochoco_deployments
         WHERE ct_project_id = (SELECT id FROM ct_projects WHERE name = @projectName)
       )`}`,
  )
  .run(scopeArgs);

console.log(`\nUpdated ${info.changes} frame rows.`);
