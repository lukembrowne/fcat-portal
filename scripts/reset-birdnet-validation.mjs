#!/usr/bin/env node
/**
 * Drop every BirdNET threshold-validation table so push-schema can rebuild them.
 *
 * Written for the 2026-08-10 removal of the triage stage, which dropped three
 * columns and a status value. SQLite cannot drop a column from a table with a
 * CHECK constraint referencing it without a full table rebuild, and the module
 * had never been committed or deployed — so there was no production data to
 * migrate and a clean rebuild was the honest option.
 *
 * This DESTROYS every campaign, sample, review, roster entry and fitted
 * threshold. It refuses to run against a database holding an APPLIED threshold,
 * because that would silently change species counts, charts, exports and
 * occupancy inputs across the whole portal.
 *
 * Run inside the container so the WAL is the one the app is using:
 *   docker compose exec portal node scripts/reset-birdnet-validation.mjs
 *   docker compose exec portal node scripts/push-schema.mjs
 *
 * Take a backup first — see the db-backup-restore skill.
 */

import Database from "better-sqlite3";

// Children before parents: birdnet_species_thresholds and
// birdnet_validation_samples both FK to campaigns, and reviews FK to samples.
const TABLES = [
  "birdnet_validation_reviews",
  "birdnet_validation_samples",
  "birdnet_validation_campaign_reviewers",
  "birdnet_species_thresholds",
  "birdnet_validation_campaigns",
];

const db = new Database("data/portal.db");

function tableExists(name) {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(name) != null
  );
}

function count(name) {
  if (!tableExists(name)) return null;
  return db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n;
}

// An applied threshold is live everywhere in the portal, not just in this
// module. Dropping one would change what every species page reports with no
// trace of why, so it must be reverted deliberately first.
if (tableExists("birdnet_species_thresholds")) {
  const active = db
    .prepare("SELECT species FROM birdnet_species_thresholds WHERE is_active = 1")
    .all();
  if (active.length > 0) {
    console.error(
      `REFUSED: ${active.length} threshold(s) are applied and filtering detections portal-wide:`
    );
    for (const row of active) console.error(`  - ${row.species}`);
    console.error(
      'Revert them from each species page ("Revertir umbral") before wiping.'
    );
    process.exit(1);
  }
}

console.log("Dropping BirdNET validation tables:");
for (const table of TABLES) {
  const n = count(table);
  console.log(`  ${table}: ${n === null ? "(absent)" : `${n} rows`}`);
}

db.pragma("foreign_keys = OFF");
const drop = db.transaction(() => {
  for (const table of TABLES) db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
});
drop();
db.pragma("foreign_keys = ON");

console.log("\nDone. Now run: node scripts/push-schema.mjs");
db.close();
