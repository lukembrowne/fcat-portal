/**
 * Import species from a CSV file into the biochoco_species table.
 *
 * Usage: node scripts/import-species-csv.mjs path/to/western_ecuador.csv
 *
 * CSV format: species_id,common_name,scientific_name,type
 *
 * Uses INSERT ... ON CONFLICT(scientific_name) DO UPDATE to allow
 * re-imports with corrections. Infers taxonomic_rank from the data.
 */

import Database from "better-sqlite3";
import { readFileSync } from "fs";
import path from "path";

const csvPath = process.argv[2];
if (!csvPath) {
  console.error("Usage: node scripts/import-species-csv.mjs <path-to-csv>");
  process.exit(1);
}

const dbPath = process.env.DB_PATH || "data/portal.db";
const fullDbPath = path.isAbsolute(dbPath)
  ? dbPath
  : path.join(process.cwd(), dbPath);

const db = new Database(fullDbPath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Read and parse CSV
const raw = readFileSync(csvPath, "utf-8");
const lines = raw.trim().split("\n");
const header = lines[0].split(",");
const rows = lines.slice(1).map((line) => {
  const parts = line.split(",");
  return {
    species_id: parts[0]?.trim(),
    common_name: parts[1]?.trim(),
    scientific_name: parts[2]?.trim(),
    type: parts[3]?.trim(),
  };
});

// Known higher-taxonomy scientific names for rank inference
const CLASS_NAMES = new Set(["Aves"]);
const ORDER_NAMES = new Set(["Rodentia", "Accipitriformes"]);
const FAMILY_NAMES = new Set(["Tinamidae", "Sciuridae", "Cathartidae", "Trochilidae"]);

function inferRank(row) {
  const sci = row.scientific_name;
  const common = row.common_name;

  if (!sci || sci === "Unknown" || sci === "Blank") return "species";
  if (CLASS_NAMES.has(sci)) return "class";
  if (ORDER_NAMES.has(sci)) return "order";
  if (FAMILY_NAMES.has(sci)) return "family";
  if (sci.endsWith(" sp.")) return "genus";
  if (common?.includes("(unidentified)") && !sci.includes(" ")) return "family";
  return "species";
}

function normalizeType(type) {
  if (!type || type === "human") return "system";
  const valid = ["mammal", "bird", "reptile", "amphibian", "insect", "system"];
  return valid.includes(type) ? type : "mammal";
}

const upsert = db.prepare(`
  INSERT INTO biochoco_species (scientific_name, common_name, type, taxonomic_rank)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(scientific_name) DO UPDATE SET
    common_name = excluded.common_name,
    type = excluded.type,
    taxonomic_rank = excluded.taxonomic_rank
`);

let inserted = 0;
let updated = 0;
let skipped = 0;

const txn = db.transaction(() => {
  for (const row of rows) {
    // Skip rows without scientific name
    if (!row.scientific_name) {
      console.log(`  SKIP: "${row.common_name}" — no scientific name`);
      skipped++;
      continue;
    }

    // Skip duplicate scientific names within CSV (e.g., "human" duplicates "person")
    const rank = inferRank(row);
    const type = normalizeType(row.type);

    const existing = db
      .prepare("SELECT id FROM biochoco_species WHERE scientific_name = ?")
      .get(row.scientific_name);

    const result = upsert.run(
      row.scientific_name,
      row.common_name,
      type,
      rank
    );

    if (existing) {
      console.log(`  UPDATE: ${row.scientific_name} (${row.common_name}) [${rank}]`);
      updated++;
    } else {
      console.log(`  INSERT: ${row.scientific_name} (${row.common_name}) [${rank}]`);
      inserted++;
    }
  }
});

txn();

console.log(`\nImport complete: ${inserted} inserted, ${updated} updated, ${skipped} skipped`);

const total = db
  .prepare("SELECT COUNT(*) as cnt FROM biochoco_species")
  .get();
console.log(`Total species in database: ${total.cnt}`);

db.close();
