/**
 * Pure filter/sort logic for the "Fichas de especies" card list.
 *
 * Kept out of the client component because the repo runs vitest with
 * `environment: "node"` and has no jsdom / @testing-library — component tests
 * can only assert static markup (see `tests/unit/landowner-pages-table.test.tsx`).
 * Extracting the logic here is the same move `paginas-publicas/sort.ts` and
 * `lib/finance/sueldos-fields.ts` make, and it's what lets the interesting
 * behaviour (diacritics, the records tiebreak, dirty-card pinning) be tested at
 * all.
 */

import type { SpeciesContentRow } from "./content-types";

export const TYPE_LABELS: Record<string, string> = {
  mammal: "Mamífero",
  bird: "Ave",
  reptile: "Reptil",
  amphibian: "Anfibio",
  insect: "Insecto",
  system: "Sistema",
};

/**
 * "withRecords" is the default: of ~607 species rows, only ~63 have a verified
 * detection and can therefore appear on a finca page. The rest is the BirdNET
 * audio-only bird tail, which is legitimately in the table (name/IUCN
 * resolution joins it) but never needs a ficha.
 */
export type SpeciesScope = "withRecords" | "all";

export type SortKey = "name" | "type" | "records" | "status";
export type SortDir = "asc" | "desc";

export interface ListOptions {
  search: string;
  scope: SpeciesScope;
  sortKey: SortKey;
  sortDir: SortDir;
  /**
   * Species ids that must stay visible regardless of search/scope — the cards
   * holding unsaved text. Filtering a dirty card out of the DOM would unmount
   * it and silently discard the draft.
   */
  alwaysInclude?: ReadonlySet<number>;
}

export function displayName(s: SpeciesContentRow): string {
  return s.spanishName || s.commonName || s.scientificName;
}

export function typeLabel(s: SpeciesContentRow): string {
  return TYPE_LABELS[s.type] || s.type;
}

/** Lowercase + strip combining marks, so "guatuso" matches "Guatusó" both ways. */
export function stripDiacritics(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

export function matchesSearch(s: SpeciesContentRow, query: string): boolean {
  const needle = stripDiacritics(query.trim());
  if (!needle) return true;
  return [s.scientificName, s.commonName, s.spanishName ?? ""].some((h) =>
    stripDiacritics(h).includes(needle)
  );
}

function inScope(s: SpeciesContentRow, scope: SpeciesScope): boolean {
  return scope === "all" || s.detectionCount > 0;
}

/**
 * Sort comparator. Ties always fall back to display name ASCENDING regardless of
 * `dir` (then id), so flipping the sort never scrambles the long 0-registro tail
 * into arbitrary order.
 */
export function compareSpecies(
  a: SpeciesContentRow,
  b: SpeciesContentRow,
  key: SortKey,
  dir: SortDir
): number {
  const sign = dir === "asc" ? 1 : -1;
  let primary = 0;

  if (key === "records") {
    primary = a.detectionCount - b.detectionCount;
  } else if (key === "status") {
    primary = (a.hasContent ? 0 : 1) - (b.hasContent ? 0 : 1);
  } else if (key === "type") {
    primary = typeLabel(a).localeCompare(typeLabel(b), "es");
  } else {
    primary = displayName(a).localeCompare(displayName(b), "es");
  }

  if (primary !== 0) return sign * primary;
  return displayName(a).localeCompare(displayName(b), "es") || a.id - b.id;
}

export interface VisibleSections {
  /** Rows passing both search and scope, sorted. */
  matching: SpeciesContentRow[];
  /**
   * Rows kept only because they are pinned (dirty). Rendered after `matching`
   * and — importantly — outside the chunk cap, so a pinned card can never be
   * pushed past the render window and unmounted anyway.
   */
  pinned: SpeciesContentRow[];
}

export function buildVisibleSections(
  rows: readonly SpeciesContentRow[],
  { search, scope, sortKey, sortDir, alwaysInclude }: ListOptions
): VisibleSections {
  const matching: SpeciesContentRow[] = [];
  const pinned: SpeciesContentRow[] = [];

  for (const row of rows) {
    if (inScope(row, scope) && matchesSearch(row, search)) matching.push(row);
    else if (alwaysInclude?.has(row.id)) pinned.push(row);
  }

  const cmp = (a: SpeciesContentRow, b: SpeciesContentRow) =>
    compareSpecies(a, b, sortKey, sortDir);
  matching.sort(cmp);
  pinned.sort(cmp);

  return { matching, pinned };
}

/** Flat view of {@link buildVisibleSections}: matching rows first, then pinned. */
export function buildVisibleList(
  rows: readonly SpeciesContentRow[],
  options: ListOptions
): SpeciesContentRow[] {
  const { matching, pinned } = buildVisibleSections(rows, options);
  return [...matching, ...pinned];
}
