/**
 * URL slug helpers for species pages.
 *
 * Slugs are lowercase, diacritic-stripped, hyphen-separated. Example:
 *   "Ramphastos ambiguus"  → "ramphastos-ambiguus"
 *   "Cebus aequatorialis"  → "cebus-aequatorialis"
 *
 * Resolution is in-memory against the species table — the table is small
 * (≤500 rows) and reads are cached by Next.js. Returns null when 0 or >1
 * scientific names slugify to the requested slug (caller renders notFound).
 */

import { db } from "@/db";
import { species } from "@/db/schema";
import type { Species } from "@/db/schema";

export function speciesSlug(scientificName: string): string {
  return scientificName
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function resolveSpeciesFromSlug(
  slug: string
): Promise<Species | null> {
  const target = slug.toLowerCase();
  const all = await db.select().from(species);
  const matches = all.filter((s) => speciesSlug(s.scientificName) === target);
  return matches.length === 1 ? matches[0]! : null;
}
