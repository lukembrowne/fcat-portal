// ---------------------------------------------------------------------------
// Finca public-pages table: row shape + sortable-column allowlist
// ---------------------------------------------------------------------------
//
// Kept in a plain (non-"use server") module so BOTH the server action and the
// client table can import the row type + SORTABLE_COLUMNS map. A "use server"
// file may only export async functions, so the runtime SORTABLE_COLUMNS object
// cannot live in actions.ts. The accessors are pure and client-safe (no server
// deps), so the SSR table can also reuse them.

import { STATUS_RANK, type SitePageStatus } from "@/lib/landowner/page-status";
import type { SiteReadiness } from "../resultados/types";

/** One finca in the public-pages status table. */
export interface SitePublicPageRow {
  siteId: string;
  siteName: string;
  habitat: string;
  deploymentCount: number;
  status: SitePageStatus;
  /** Per-datatype readiness (cameras/audio/temperature/habitat) for the Datos column. */
  readiness: SiteReadiness;
  /** When the active token was created (no separate config-updated column). */
  lastEditedAt: Date | null;
  lastViewedAt: Date | null;
  viewCount: number;
  hasActiveToken: boolean;
}

/** Allowed sort columns → a comparable-value accessor for a row. */
export const SORTABLE_COLUMNS = {
  finca: (r: SitePublicPageRow) => r.siteName.toLowerCase(),
  estado: (r: SitePublicPageRow) => STATUS_RANK[r.status.key],
  editado: (r: SitePublicPageRow) => r.lastEditedAt?.getTime() ?? 0,
  vistas: (r: SitePublicPageRow) => r.viewCount,
} as const;

export type SitePublicPagesSortColumn = keyof typeof SORTABLE_COLUMNS;
export type SortDirection = "asc" | "desc";

/** Default: status rank descending → most-progressed ("visto") first. */
export const DEFAULT_SORT_BY: SitePublicPagesSortColumn = "estado";
export const DEFAULT_SORT_DIR: SortDirection = "desc";

/**
 * Sort rows by a validated column + direction with a stable siteId tiebreaker.
 * Unknown sort values fall back to the defaults (caller passes raw params).
 */
export function sortSitePublicPageRows(
  rows: SitePublicPageRow[],
  sort?: { sortBy?: string; sortDir?: string }
): SitePublicPageRow[] {
  const sortBy: SitePublicPagesSortColumn =
    sort && sort.sortBy && sort.sortBy in SORTABLE_COLUMNS
      ? (sort.sortBy as SitePublicPagesSortColumn)
      : DEFAULT_SORT_BY;
  const sortDir: SortDirection =
    sort?.sortDir === "asc" || sort?.sortDir === "desc"
      ? sort.sortDir
      : DEFAULT_SORT_DIR;

  const accessor = SORTABLE_COLUMNS[sortBy];
  const factor = sortDir === "asc" ? 1 : -1;

  return [...rows].sort((a, b) => {
    const cmp = compareValues(accessor(a), accessor(b));
    if (cmp !== 0) return cmp * factor;
    // Stable tiebreaker (always ascending for determinism).
    return a.siteId.localeCompare(b.siteId);
  });
}

function compareValues(a: string | number, b: string | number): number {
  if (typeof a === "string" && typeof b === "string") {
    return a.localeCompare(b);
  }
  return Number(a) - Number(b);
}
