/**
 * URL slug helpers for species pages — pure encoder only.
 *
 * Slugs are lowercase, diacritic-stripped, hyphen-separated. Example:
 *   "Ramphastos ambiguus"  → "ramphastos-ambiguus"
 *   "Cebus aequatorialis"  → "cebus-aequatorialis"
 *
 * This module is safe to import from Client Components. The server-only
 * `resolveSpeciesFromSlug` reverse lookup lives in `species-slug-server.ts`
 * to avoid dragging the DB driver (and its `server-only` guard) into the
 * client bundle.
 */

export function speciesSlug(scientificName: string): string {
  return scientificName
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
