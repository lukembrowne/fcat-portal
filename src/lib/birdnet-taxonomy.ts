/**
 * App-side BirdNET name resolution.
 *
 * Reads the vendored name-reference file `data/birdnet-species-names.csv`
 * (generated once from the installed birdnet_analyzer package by
 * scripts/extract-birdnet-labels.mjs) into a cached scientific→names map.
 * Used by the per-run auto-add hook (src/lib/birdnet-runner.ts) so a
 * newly-detected species can be inserted into `biochoco_species` with its
 * English + Spanish common names.
 *
 * The seed script (scripts/seed-detected-species.mjs) intentionally does NOT
 * import this module — it runs in the prod container where `src/` is absent, so
 * it parses the same CSV inline. Keep the CSV format in sync with both.
 */

import fs from "node:fs";
import path from "node:path";

export interface BirdnetName {
  commonName: string;
  spanishName: string | null;
}

let cache: Map<string, BirdnetName> | null = null;

/** Path to the vendored reference file (in the persistent data volume). */
export function referenceCsvPath(): string {
  return path.join(process.cwd(), "data", "birdnet-species-names.csv");
}

/** Parse one CSV line into fields, honoring double-quoted fields with commas. */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
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

/** Parse the reference CSV text into a scientific→names map. */
export function parseReferenceCsv(text: string): Map<string, BirdnetName> {
  const map = new Map<string, BirdnetName>();
  const lines = text.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    // skip header row 0
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

/** Lazily load + cache the reference map. Missing file → empty map (callers fall back). */
export function loadBirdnetNames(): Map<string, BirdnetName> {
  if (cache) return cache;
  try {
    cache = parseReferenceCsv(fs.readFileSync(referenceCsvPath(), "utf-8"));
  } catch {
    cache = new Map();
  }
  return cache;
}

/** Resolve names for a scientific name, or null when absent from the reference. */
export function resolveBirdnetName(scientificName: string): BirdnetName | null {
  return loadBirdnetNames().get(scientificName) ?? null;
}

/** Test hook: reset the module cache. */
export function __resetBirdnetNameCache(): void {
  cache = null;
}

/**
 * Non-species detection labels that must never become lookup rows (BirdNET
 * emits a handful of non-avian/noise classes). Kept in sync with the seed
 * script's EXCLUDED_SPECIES (which duplicates this — the seed can't import
 * `src/` in the prod container).
 */
export const NON_SPECIES_LABELS = new Set([
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

export function isNonSpeciesLabel(name: string): boolean {
  return NON_SPECIES_LABELS.has(name.trim().toLowerCase());
}
