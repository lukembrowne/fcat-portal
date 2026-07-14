import type { CategoryByYear } from "./actions";

/**
 * One row of the annual "Gastos por Categoría por Año" long-list.
 *
 * `perYear` is keyed by the string form of the year (matching the column
 * accessors used by the table). `barFraction` is a [0,1] magnitude cue for the
 * inline ranking bar, scaled to the largest row total across the dataset.
 */
export interface CategoryYearRow {
  category: string;
  perYear: Record<string, number>;
  total: number;
  /** latest year − previous year; null when fewer than two years exist. */
  change: number | null;
  /** total / maxTotalAcrossRows, clamped to [0,1]; 0 when all totals are 0. */
  barFraction: number;
}

/**
 * Build the per-category rows for the annual comparison long-list.
 *
 * Pure and dependency-free so it runs under Vitest's node environment.
 * Rows are sorted by total spend descending, with the category name as a
 * stable tiebreaker.
 */
export function buildCategoryYearRows(
  data: CategoryByYear[],
  years: number[]
): CategoryYearRow[] {
  const yearKeys = years.map((y) => String(y));

  // Aggregate amounts per category/year (defaulting absent cells to 0).
  const byCategory = new Map<string, Record<string, number>>();
  for (const entry of data) {
    let perYear = byCategory.get(entry.category);
    if (!perYear) {
      perYear = {};
      for (const k of yearKeys) perYear[k] = 0;
      byCategory.set(entry.category, perYear);
    }
    const key = String(entry.year);
    if (key in perYear) perYear[key] = entry.amount;
  }

  const latestKey = yearKeys[yearKeys.length - 1];
  const prevKey = yearKeys[yearKeys.length - 2];

  const rows: CategoryYearRow[] = [];
  for (const [category, perYear] of byCategory) {
    const total = yearKeys.reduce((sum, k) => sum + (perYear[k] ?? 0), 0);
    const change =
      yearKeys.length >= 2
        ? (perYear[latestKey] ?? 0) - (perYear[prevKey] ?? 0)
        : null;
    rows.push({ category, perYear, total, change, barFraction: 0 });
  }

  const maxTotal = rows.reduce((max, r) => (r.total > max ? r.total : max), 0);
  for (const row of rows) {
    row.barFraction =
      maxTotal > 0 ? Math.min(1, Math.max(0, row.total / maxTotal)) : 0;
  }

  rows.sort((a, b) => b.total - a.total || a.category.localeCompare(b.category));
  return rows;
}
