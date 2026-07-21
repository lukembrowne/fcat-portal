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
 * The IUCN v4 API returns the category directly on the taxa lookup — each item
 * in `assessments[]` already carries `red_list_category_code` (e.g. "LC"/"VU"/
 * "EN"), so a single request per species suffices:
 *   GET /api/v4/taxa/scientific_name?genus_name=&species_name=  -> assessments[]
 * (An older two-step design fetched /assessments/{id} and read a *nested*
 * `red_list_category.code` that doesn't exist on the response — that returned
 * `undefined` for every species, i.e. a uniform "(no assessment)". Do not
 * reintroduce it.) We fall back to the detail endpoint only if the summary
 * assessment somehow lacks a code.
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
 * Pull a Red List category code out of an assessment-shaped object, tolerating
 * the field-name variants the v4 API and its wrappers use. The taxa summary
 * carries it flat as `red_list_category_code`; some payloads nest it under
 * `red_list_category.code`. Exported for testing.
 */
export function extractCategoryCode(obj) {
  if (!obj || typeof obj !== "object") return null;
  const candidates = [
    obj.red_list_category_code,
    obj.red_list_category?.code,
    obj.category,
    obj.code,
  ];
  const code = candidates.find((c) => typeof c === "string" && c.length > 0);
  return code ?? null;
}

/**
 * True when an assessment's `scopes[]` includes the GLOBAL scope. The v4 API
 * codes Global as scope `"1"` (description "Global"); we also match on the text
 * to be robust to code changes. Exported for testing.
 */
export function isGlobalScope(assessment) {
  const scopes = assessment?.scopes;
  if (!Array.isArray(scopes)) return false;
  return scopes.some(
    (s) => s?.code === "1" || /global/i.test(s?.description?.en || s?.description || "")
  );
}

/**
 * Pick the latest GLOBAL assessment from a taxa response's `assessments[]`.
 *
 * The API returns assessments across ALL scopes — Global plus regional ones
 * (Mediterranean, Europe, national Red Lists). A taxon can have MULTIPLE
 * assessments flagged `latest === true`, one per scope, and regional categories
 * routinely differ from the global one (e.g. Osprey is LC globally but EN in the
 * Mediterranean). The Red List "category" we surface must be the GLOBAL one, so
 * we filter to Global scope FIRST, then prefer `latest === true`, else newest by
 * `year_published`. Returns null when the taxon has no global assessment (a
 * regional-only match must not masquerade as the global category). Exported for
 * testing.
 */
export function pickLatestAssessment(assessments) {
  if (!Array.isArray(assessments) || assessments.length === 0) return null;
  const global = assessments.filter(isGlobalScope);
  if (global.length === 0) return null;
  return (
    global.find((a) => a?.latest === true) ??
    [...global].sort(
      (a, b) => (Number(b?.year_published) || 0) - (Number(a?.year_published) || 0)
    )[0]
  );
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
  const latest = pickLatestAssessment(taxon?.assessments);
  if (!latest) return null;

  // The category code is present on the summary assessment in the vast majority
  // of cases — no second request needed.
  const summaryCode = extractCategoryCode(latest);
  if (summaryCode) return summaryCode;

  // Fallback only when the summary lacks a code: fetch the full assessment.
  const assessmentId = latest.assessment_id;
  if (assessmentId == null) return null;
  await sleep(THROTTLE_MS);
  const assessment = await apiGet(`/assessments/${assessmentId}`);
  return extractCategoryCode(assessment);
}

/**
 * Build the species-selection query. With `onlyMissing`, restrict to rows whose
 * `iucn_status IS NULL` so re-runs (e.g. after new BirdNET species are added)
 * only fill gaps instead of re-hitting the API for already-assessed species.
 * Exported for testing.
 */
export function buildSpeciesQuery(onlyMissing) {
  const where = [
    "taxonomic_rank = 'species'",
    "type != 'system'",
    ...(onlyMissing ? ["iucn_status IS NULL"] : []),
  ];
  return (
    `SELECT id, scientific_name FROM biochoco_species\n` +
    `       WHERE ${where.join(" AND ")}\n` +
    `       ORDER BY scientific_name`
  );
}

async function main() {
  if (!TOKEN) {
    console.error(
      "[iucn] IUCN_API_TOKEN not set. Generate a v4 token at https://api.iucnredlist.org/ and pass it in the environment."
    );
    process.exit(1);
  }

  const onlyMissing = process.argv.includes("--only-missing");

  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");

  // Only binomial species rows (skip higher taxa and the 'system' pseudo-type).
  // With --only-missing, also skip rows that already carry an IUCN status.
  const rows = db.prepare(buildSpeciesQuery(onlyMissing)).all();

  const update = db.prepare(
    `UPDATE biochoco_species SET iucn_status = ? WHERE id = ?`
  );

  let matched = 0;
  let unmatched = 0;
  let errored = 0;
  const unmatchedNames = [];
  const erroredNames = [];

  console.log(
    `[iucn] ${rows.length} species to check (throttle ${THROTTLE_MS}ms)` +
      (onlyMissing ? " [--only-missing: unassessed rows only]" : "")
  );

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

// Run only when invoked directly (not when imported by the unit test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[iucn] Fatal: ${err.message}`);
    process.exit(1);
  });
}
