#!/usr/bin/env node

/**
 * One-shot backfill: populate biochoco_species.iucn_status from the IUCN
 * Red List API v4.
 *
 * For each species with a binomial scientific_name, we resolve the taxon, take
 * its latest assessment, and store the Red List category code (LC/NT/VU/EN/CR/
 * DD/EW/EX) on the row. Species with no match or an API error are left NULL and
 * reported in the summary — never a crash.
 *
 * The IUCN v4 API is a TWO-step lookup:
 *   1. GET /api/v4/taxa/scientific_name?genus_name=&species_name=  -> assessments[]
 *   2. GET /api/v4/assessments/{id}                                -> red_list_category.code
 *
 * Requires an IUCN v4 token (generate at https://api.iucnredlist.org/):
 *   IUCN_API_TOKEN=... docker compose exec portal node scripts/backfill-iucn-status.mjs
 *
 * Non-commercial / education-research use only (FCAT is a conservation nonprofit).
 * The API is rate-limited, so we throttle ~1 request/second.
 *
 * Idempotent: re-running overwrites with the same value; no duplicate rows.
 * MUST run INSIDE the container (bare host scripts against data/portal.db while
 * the container holds it open can corrupt SQLite on macOS bind mounts).
 */

import Database from "better-sqlite3";
import path from "path";

const API_BASE = "https://api.iucnredlist.org/api/v4";
const TOKEN = process.env.IUCN_API_TOKEN;
const THROTTLE_MS = Number(process.env.IUCN_THROTTLE_MS || 1100);

const DB_PATH = process.env.DB_PATH || "data/portal.db";
const dbPath = path.isAbsolute(DB_PATH) ? DB_PATH : path.join(process.cwd(), DB_PATH);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apiGet(pathAndQuery) {
  const res = await fetch(`${API_BASE}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" },
  });
  if (res.status === 404) return null; // taxon/assessment not found
  if (!res.ok) {
    throw new Error(`IUCN API ${res.status} for ${pathAndQuery}`);
  }
  return res.json();
}

/**
 * Resolve a binomial scientific name to its latest Red List category code.
 * Returns the code string, or null when the taxon has no (matched) assessment.
 */
async function resolveCategory(scientificName) {
  const parts = scientificName.trim().split(/\s+/);
  if (parts.length < 2) return null; // not a binomial (genus-only / higher rank)
  const [genus, species] = parts;

  const taxon = await apiGet(
    `/taxa/scientific_name?genus_name=${encodeURIComponent(genus)}&species_name=${encodeURIComponent(species)}`
  );
  const assessments = taxon?.assessments;
  if (!Array.isArray(assessments) || assessments.length === 0) return null;

  // Prefer the flagged latest assessment, else the newest by year_published.
  const latest =
    assessments.find((a) => a.latest === true) ??
    [...assessments].sort(
      (a, b) => (b.year_published ?? 0) - (a.year_published ?? 0)
    )[0];
  const assessmentId = latest?.assessment_id;
  if (assessmentId == null) return null;

  await sleep(THROTTLE_MS);
  const assessment = await apiGet(`/assessments/${assessmentId}`);
  const code = assessment?.red_list_category?.code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

async function main() {
  if (!TOKEN) {
    console.error(
      "[iucn] IUCN_API_TOKEN not set. Generate a v4 token at https://api.iucnredlist.org/ and pass it in the environment."
    );
    process.exit(1);
  }

  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");

  // Only binomial species rows (skip higher taxa and the 'system' pseudo-type).
  const rows = db
    .prepare(
      `SELECT id, scientific_name FROM biochoco_species
       WHERE taxonomic_rank = 'species' AND type != 'system'
       ORDER BY scientific_name`
    )
    .all();

  const update = db.prepare(
    `UPDATE biochoco_species SET iucn_status = ? WHERE id = ?`
  );

  let matched = 0;
  let unmatched = 0;
  let errored = 0;
  const unmatchedNames = [];
  const erroredNames = [];

  console.log(`[iucn] ${rows.length} species to check (throttle ${THROTTLE_MS}ms)`);

  for (const row of rows) {
    try {
      const code = await resolveCategory(row.scientific_name);
      if (code) {
        update.run(code, row.id);
        matched++;
        console.log(`[iucn] ${row.scientific_name} -> ${code}`);
      } else {
        unmatched++;
        unmatchedNames.push(row.scientific_name);
        console.log(`[iucn] ${row.scientific_name} -> (no assessment)`);
      }
    } catch (err) {
      errored++;
      erroredNames.push(row.scientific_name);
      console.warn(`[iucn] ${row.scientific_name} -> ERROR: ${err.message}`);
    }
    await sleep(THROTTLE_MS);
  }

  db.close();

  console.log("\n[iucn] === Summary ===");
  console.log(`[iucn] matched:   ${matched}`);
  console.log(`[iucn] unmatched: ${unmatched}`);
  console.log(`[iucn] errored:   ${errored}`);
  if (unmatchedNames.length) {
    console.log(`[iucn] unmatched names: ${unmatchedNames.join(", ")}`);
  }
  if (erroredNames.length) {
    console.log(`[iucn] errored names:   ${erroredNames.join(", ")}`);
  }
}

main().catch((err) => {
  console.error(`[iucn] Fatal: ${err.message}`);
  process.exit(1);
});
