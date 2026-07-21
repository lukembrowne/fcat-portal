#!/usr/bin/env node
// Audit: recompute each assessed species' GLOBAL-scope Red List category from
// the IUCN v4 API and diff against the stored biochoco_species.iucn_status.
// Read-only by default; pass --fix to correct rows to the Global category (and
// NULL rows whose only assessments are regional). Companion to
// backfill-iucn-status.mjs — use it to catch regional-scope leaks like the
// Osprey (Pandion haliaetus) Mediterranean-EN vs Global-LC case.
//
//   IUCN_API_TOKEN=... docker compose exec portal node scripts/iucn-scope-audit.mjs [--fix]
import Database from "better-sqlite3";
import path from "path";

const TOKEN = process.env.IUCN_API_TOKEN;
const THROTTLE_MS = Number(process.env.IUCN_THROTTLE_MS || 700);
const FIX = process.argv.includes("--fix");
const DB_PATH = process.env.DB_PATH || "data/portal.db";
const dbPath = path.isAbsolute(DB_PATH) ? DB_PATH : path.join(process.cwd(), DB_PATH);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isGlobal = (s) =>
  s?.code === "1" || /global/i.test(s?.description?.en || s?.description || "");

function globalCategory(assessments) {
  const glob = (assessments || []).filter((x) => (x.scopes || []).some(isGlobal));
  if (glob.length === 0) return { code: null, hadAny: (assessments || []).length > 0 };
  const pick =
    glob.find((x) => x.latest === true) ??
    [...glob].sort((a, b) => (Number(b.year_published) || 0) - (Number(a.year_published) || 0))[0];
  return { code: pick?.red_list_category_code ?? null, hadAny: true };
}

async function main() {
  if (!TOKEN) { console.error("IUCN_API_TOKEN not set"); process.exit(1); }
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");
  const rows = db
    .prepare(
      "SELECT id, scientific_name, iucn_status FROM biochoco_species " +
        "WHERE iucn_status IS NOT NULL AND taxonomic_rank = 'species' ORDER BY scientific_name"
    )
    .all();
  const update = db.prepare("UPDATE biochoco_species SET iucn_status = ? WHERE id = ?");
  console.log(`Auditing ${rows.length} assessed species (fix=${FIX})\n`);

  const diffs = [];
  for (const r of rows) {
    const parts = r.scientific_name.trim().split(/\s+/);
    if (parts.length < 2) continue;
    try {
      const res = await fetch(
        `https://api.iucnredlist.org/api/v4/taxa/scientific_name?genus_name=${encodeURIComponent(parts[0])}&species_name=${encodeURIComponent(parts[1])}`,
        { headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/json" } }
      );
      if (!res.ok) { console.log(`  ! ${r.scientific_name} HTTP ${res.status}`); await sleep(THROTTLE_MS); continue; }
      const j = await res.json();
      const { code, hadAny } = globalCategory(j.assessments);
      const stored = r.iucn_status;
      if (code !== stored) {
        const note = code == null ? (hadAny ? "(only regional assessments)" : "(no assessment)") : "";
        diffs.push({ name: r.scientific_name, stored, global: code, note });
        console.log(`  DIFF ${r.scientific_name}: stored=${stored} -> global=${code ?? "NULL"} ${note}`);
        if (FIX) update.run(code, r.id);
      }
    } catch (e) {
      console.log(`  ! ${r.scientific_name} ERROR ${e.message}`);
    }
    await sleep(THROTTLE_MS);
  }
  db.close();
  console.log(`\n=== ${diffs.length} discrepancies ===`);
  for (const d of diffs) console.log(`${(d.stored||"?").padEnd(4)} -> ${(d.global||"NULL").padEnd(4)} ${d.name} ${d.note}`);
  if (!FIX && diffs.length) console.log("\n(Re-run with --fix to correct these in the DB.)");
}
main().catch((e) => { console.error("Fatal", e.message); process.exit(1); });
