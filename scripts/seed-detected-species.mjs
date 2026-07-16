#!/usr/bin/env node

/**
 * Seed the shared species lookup with the BirdNET (audio) species we have
 * ACTUALLY detected — not the full ~6,000-taxon label set.
 *
 * For each distinct `audio_identifications` species (honoring corrected_species)
 * that is missing from `biochoco_species`, insert a row with names resolved from
 * the reference file `data/birdnet-species-names.csv`
 * (scripts/extract-birdnet-labels.mjs), tagged `type='bird'` and
 * `camera_selectable=0` so it never floods the camera-trap annotation picker.
 * Names absent from the reference fall back to the scientific string.
 *
 * Idempotent: existing species (any type) are left untouched — the seed never
 * clobbers iucn_status or an existing camera_selectable flag.
 *
 * Standalone (no `src/` imports) so it runs in the prod container. Run inside
 * the container — host runs can corrupt SQLite on the bind mount:
 *   docker compose exec portal node scripts/seed-detected-species.mjs
 */

import Database from "better-sqlite3";
import { readFileSync } from "fs";
import path from "path";

// Non-species detection labels that must never become lookup rows.
export const EXCLUDED_SPECIES = new Set([
  "homo sapiens",
  "unknown",
  "aves",
  "blank",
  "noise",
  "human vocal",
  "human non-vocal",
  "human whistle",
  "dog",
  "engine",
  "environmental",
  "fireworks",
  "gun",
  "power tools",
  "siren",
]);

/** Parse one CSV line honoring double-quoted fields (kept in sync with birdnet-taxonomy.ts). */
export function parseCsvLine(line) {
  const out = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  out.push(field);
  return out;
}

/** Parse the reference CSV into a scientific→{commonName, spanishName} map. */
export function parseReferenceCsv(text) {
  const map = new Map();
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const [sci, common, spanish] = parseCsvLine(lines[i]);
    const scientificName = (sci ?? "").trim();
    if (!scientificName) continue;
    map.set(scientificName, {
      commonName: (common ?? "").trim(),
      spanishName: (spanish ?? "").trim() || null,
    });
  }
  return map;
}

/**
 * Pure: given detected scientific names, the set already present in the lookup,
 * and the reference name map, return the rows to insert. Filters excluded
 * non-species labels (case-insensitive) and species already present.
 */
export function buildSeedRows(detectedNames, existingSet, nameMap) {
  const rows = [];
  for (const raw of detectedNames) {
    const name = (raw ?? "").trim();
    if (!name) continue;
    if (EXCLUDED_SPECIES.has(name.toLowerCase())) continue;
    if (existingSet.has(name)) continue;
    const info = nameMap.get(name);
    rows.push({
      scientificName: name,
      commonName: info?.commonName || name, // fallback: scientific string
      spanishName: info?.spanishName ?? null,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Runner (skipped when imported by the unit test)
// ---------------------------------------------------------------------------

function main() {
  const dbPath = process.env.DB_PATH || "data/portal.db";
  const fullDbPath = path.isAbsolute(dbPath) ? dbPath : path.join(process.cwd(), dbPath);
  const refPath = path.join(process.cwd(), "data", "birdnet-species-names.csv");

  let refText;
  try {
    refText = readFileSync(refPath, "utf-8");
  } catch {
    console.error(
      `[seed-detected-species] Reference file not found at ${refPath}.\n` +
        "Run scripts/extract-birdnet-labels.mjs first (in the container).",
    );
    process.exit(1);
  }
  const nameMap = parseReferenceCsv(refText);

  const db = new Database(fullDbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  const detected = db
    .prepare(
      `SELECT DISTINCT COALESCE(NULLIF(corrected_species, ''), species) AS name
       FROM audio_identifications`,
    )
    .all()
    .map((r) => r.name);

  const existing = new Set(
    db.prepare(`SELECT scientific_name FROM biochoco_species`).all().map((r) => r.scientific_name),
  );

  const rows = buildSeedRows(detected, existing, nameMap);

  const insert = db.prepare(
    `INSERT INTO biochoco_species
       (scientific_name, common_name, spanish_name, type, taxonomic_rank, camera_selectable)
     VALUES (?, ?, ?, 'bird', 'species', 0)
     ON CONFLICT(scientific_name) DO NOTHING`,
  );

  let inserted = 0;
  let fellBack = 0;
  const txn = db.transaction((toInsert) => {
    for (const row of toInsert) {
      const res = insert.run(row.scientificName, row.commonName, row.spanishName);
      if (res.changes > 0) {
        inserted++;
        if (row.commonName === row.scientificName) fellBack++;
      }
    }
  });
  txn(rows);

  console.log(
    `[seed-detected-species] detected=${detected.length} existing=${existing.size} ` +
      `inserted=${inserted} (name-fallbacks=${fellBack})`,
  );
  db.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
