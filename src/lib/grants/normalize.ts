/**
 * Funder-name normalization — the single source of truth for grant↔funder matching.
 *
 * Used by both the one-time importer (scripts/import-grants.ts) and the funder
 * server actions so a grant's typed funder name maps to the same key as the
 * funder record's stored `name_normalized`.
 *
 * Lowercase, trim, drop a leading "the ", collapse internal whitespace.
 * Deliberately conservative: multi-funder strings (e.g. "TNC, WCS") won't collapse
 * to a single funder and are left for manual linking.
 */
export function normalizeFunderName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/^the\s+/, "")
    .replace(/\s+/g, " ");
}
