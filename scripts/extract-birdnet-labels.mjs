#!/usr/bin/env node

/**
 * Extract the BirdNET scientific↔common name reference from the installed
 * `birdnet_analyzer` package (English + Spanish locales) into a small vendored
 * CSV: `data/birdnet-species-names.csv` with columns
 *   scientific_name,common_name,spanish_name
 *
 * This is a NAMES-ONLY reference artifact — NOT a bulk import of table rows.
 * The seed (scripts/seed-detected-species.mjs) and the per-run auto-add
 * (src/lib/birdnet-runner.ts, via src/lib/birdnet-taxonomy.ts) read it to
 * resolve names for the species we actually detect. The `biochoco_species`
 * table only ever holds detected species.
 *
 * MUST run inside the container — the venv (data/ml-venv) is built there and is
 * not usable from the host (false ModuleNotFoundError on host runs):
 *   docker compose exec portal node scripts/extract-birdnet-labels.mjs
 *
 * Regenerate after a BirdNET model upgrade so newly-added taxa resolve to names.
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Pure logic (unit-tested)
// ---------------------------------------------------------------------------

/**
 * Parse one BirdNET label file. Lines are `Genus species_Common Name`
 * (underscore separates the scientific binomial from the common name; common
 * names never contain an underscore). Returns [{ scientificName, commonName }].
 */
export function parseLabelFile(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const idx = line.indexOf("_");
    if (idx === -1) continue; // malformed line — skip
    const scientificName = line.slice(0, idx).trim();
    const commonName = line.slice(idx + 1).trim();
    if (!scientificName || !commonName) continue;
    out.push({ scientificName, commonName });
  }
  return out;
}

/**
 * Pair English + Spanish label files by SCIENTIFIC NAME (a map, not line
 * position — robust to ordering differences and missing Spanish entries).
 * English is authoritative for row membership; Spanish is attached when present.
 * Returns [{ scientificName, commonName, spanishName }] (spanishName may be "").
 */
export function pairLocales(enText, esText) {
  const en = parseLabelFile(enText);
  const esByName = new Map(
    parseLabelFile(esText).map((r) => [r.scientificName, r.commonName]),
  );
  return en.map((r) => ({
    scientificName: r.scientificName,
    commonName: r.commonName,
    spanishName: esByName.get(r.scientificName) ?? "",
  }));
}

/** CSV-escape a field (quote when it contains a comma, quote, or newline). */
function csvField(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  const lines = ["scientific_name,common_name,spanish_name"];
  for (const r of rows) {
    lines.push([r.scientificName, r.commonName, r.spanishName].map(csvField).join(","));
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// File discovery (container-side)
// ---------------------------------------------------------------------------

/** Recursively collect files under `dir` whose basename matches `re`. */
function findFiles(dir, re, acc = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) findFiles(full, re, acc);
    else if (re.test(e.name)) acc.push(full);
  }
  return acc;
}

function findPackageDir() {
  const venv = process.env.ML_VENV_PATH || path.join(process.cwd(), "data/ml-venv");
  // site-packages lives at data/ml-venv/lib/python3.X/site-packages/birdnet_analyzer
  const libRoot = path.join(venv, "lib");
  let found = null;
  try {
    for (const py of fs.readdirSync(libRoot)) {
      const cand = path.join(libRoot, py, "site-packages", "birdnet_analyzer");
      if (fs.existsSync(cand)) {
        found = cand;
        break;
      }
    }
  } catch {
    /* fall through to error below */
  }
  return found;
}

/** Pick the label file for a locale, preferring the file whose name names the model. */
function pickLabelFile(files, localeTokens) {
  const matches = files.filter((f) => {
    const base = path.basename(f).toLowerCase();
    return localeTokens.some((t) => base.includes(t));
  });
  if (matches.length === 0) return null;
  // Prefer a GLOBAL_6K label file when several locales/models are present.
  const preferred = matches.find((f) => /global_6k/i.test(path.basename(f)));
  return preferred ?? matches[0];
}

function main() {
  const pkgDir = findPackageDir();
  if (!pkgDir) {
    console.error(
      "[extract-birdnet-labels] birdnet_analyzer package not found under the ML venv.\n" +
        "Run inside the container (docker compose exec portal ...) after the ML venv is installed.",
    );
    process.exit(1);
  }

  const labelFiles = findFiles(pkgDir, /labels.*\.txt$/i);
  // BirdNET label filenames carry a locale token, e.g. ..._Labels_en_us.txt / ..._es.txt.
  const enFile = pickLabelFile(labelFiles, ["_en_us", "_en.", "_en_uk", "_en-"]);
  const esFile = pickLabelFile(labelFiles, ["_es.", "_es_", "_es-"]);

  if (!enFile) {
    console.error(
      "[extract-birdnet-labels] No English label file found under " +
        pkgDir +
        ". Check the installed birdnet_analyzer version/model.",
    );
    process.exit(1);
  }
  if (!esFile) {
    console.error(
      "[extract-birdnet-labels] No Spanish label file found under " +
        pkgDir +
        ". Check the installed birdnet_analyzer version/model.",
    );
    process.exit(1);
  }

  const enText = fs.readFileSync(enFile, "utf-8");
  const esText = fs.readFileSync(esFile, "utf-8");
  const rows = pairLocales(enText, esText);

  const outPath = path.join(process.cwd(), "data", "birdnet-species-names.csv");
  fs.writeFileSync(outPath, toCsv(rows), "utf-8");
  console.log(
    `[extract-birdnet-labels] Wrote ${rows.length} rows to ${outPath}\n` +
      `  en: ${enFile}\n  es: ${esFile}`,
  );
}

// Run only when invoked directly (not when imported by the unit test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
