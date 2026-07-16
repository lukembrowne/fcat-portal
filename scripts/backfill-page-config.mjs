#!/usr/bin/env node

/**
 * One-shot backfill: seed site_share_tokens.page_config from the legacy
 * per-token curation fields (hero_image_id, landowner_note, featured_audio_id).
 *
 * The page-builder reads page_config; before it existed, curation lived in those
 * three columns. This folds them into an equivalent config (in the default
 * render order) so no live landowner page changes appearance at cutover.
 *
 * Runs on ACTIVE tokens only (revoked_at IS NULL). Idempotent: rows that already
 * have a page_config are skipped, so re-running is safe and re-runs pick up any
 * tokens created between runs.
 *
 *   docker compose exec portal node scripts/backfill-page-config.mjs
 *   DRY_RUN=1 docker compose exec portal node scripts/backfill-page-config.mjs
 *
 * MUST run INSIDE the container (bare host scripts against data/portal.db while
 * the container holds it open can corrupt SQLite on macOS bind mounts).
 */

import Database from "better-sqlite3";
import path from "path";

const DB_PATH = process.env.DB_PATH || "data/portal.db";
const DRY_RUN = process.env.DRY_RUN === "1";
const dbPath = path.isAbsolute(DB_PATH)
  ? DB_PATH
  : path.join(process.cwd(), DB_PATH);

// Keep in lockstep with src/lib/landowner/page-config.ts.
const PAGE_CONFIG_VERSION = 1;
const NOTE_MAX = 800;

/** Build the default config from the legacy columns (mirrors defaultConfigFromLegacy). */
function defaultConfigFromLegacy({ heroImageId, landownerNote, featuredAudioId }) {
  const blocks = [{ type: "hero", imageId: heroImageId ?? null }];
  const note = (landownerNote ?? "").trim();
  if (note) blocks.push({ type: "note", text: note.slice(0, NOTE_MAX) });
  if (featuredAudioId != null) {
    blocks.push({ type: "featuredAudio", audioId: featuredAudioId });
  }
  return { version: PAGE_CONFIG_VERSION, blocks };
}

function main() {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");

  const rows = db
    .prepare(
      `SELECT id, biochoco_site_id, hero_image_id, landowner_note, featured_audio_id
         FROM site_share_tokens
        WHERE revoked_at IS NULL
          AND page_config IS NULL`,
    )
    .all();

  console.log(
    `[backfill-page-config] ${rows.length} active token(s) without page_config` +
      (DRY_RUN ? " (DRY RUN — no writes)" : ""),
  );

  const update = db.prepare(
    `UPDATE site_share_tokens SET page_config = ? WHERE id = ?`,
  );

  let written = 0;
  for (const row of rows) {
    const config = defaultConfigFromLegacy({
      heroImageId: row.hero_image_id,
      landownerNote: row.landowner_note,
      featuredAudioId: row.featured_audio_id,
    });
    const json = JSON.stringify(config);
    console.log(
      `  site ${row.biochoco_site_id} (token #${row.id}): ${config.blocks
        .map((b) => b.type)
        .join(", ")}`,
    );
    if (!DRY_RUN) {
      update.run(json, row.id);
      written++;
    }
  }

  console.log(
    `[backfill-page-config] Done. ${DRY_RUN ? 0 : written} token(s) updated.`,
  );
  db.close();
}

main();
