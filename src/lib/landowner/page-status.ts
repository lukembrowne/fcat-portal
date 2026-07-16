// ---------------------------------------------------------------------------
// Landowner public-page status derivation (pure, dependency-free)
// ---------------------------------------------------------------------------
//
// A finca's public-page status is DERIVED, never stored, so it can't drift from
// the underlying data (KTD-2). This helper is intentionally free of any DB /
// framework imports so it is trivially unit-testable.

export type SitePageStatusKey = "sin_empezar" | "publicado" | "visto";

export interface SitePageStatus {
  key: SitePageStatusKey;
  /** True when the team curated blocks beyond the default (pageConfig != null). */
  personalized: boolean;
  /** The last time the landowner opened the page (only set for "visto"). */
  viewedAt: Date | null;
}

/**
 * Sort rank for the status pill: least-done first so "sin_empezar" (needs work)
 * surfaces at the top when sorting by status ascending.
 */
export const STATUS_RANK: Record<SitePageStatusKey, number> = {
  sin_empezar: 0,
  publicado: 1,
  visto: 2,
};

/**
 * Derive the public-page status of a finca from existing data:
 *   - no active share token           → "sin_empezar"
 *   - active token, never opened       → "publicado"
 *   - active token, opened at least 1× → "visto" (carries the last view date)
 *
 * `personalized` reflects whether a curated pageConfig exists (non-null).
 */
export function deriveSitePageStatus(input: {
  hasActiveToken: boolean;
  lastViewedAt: Date | null;
  pageConfig: string | null;
}): SitePageStatus {
  if (!input.hasActiveToken) {
    return { key: "sin_empezar", personalized: false, viewedAt: null };
  }

  const personalized = input.pageConfig != null;

  if (input.lastViewedAt == null) {
    return { key: "publicado", personalized, viewedAt: null };
  }

  return { key: "visto", personalized, viewedAt: input.lastViewedAt };
}
