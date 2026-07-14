/**
 * Cross-species effect-size assembly (U13): collect one covariate's occupancy
 * (ψ) slope per species into a forest-plot-ready list, with 95% CIs and a simple
 * inverse-variance group summary (descriptive, not a formal random-effects model).
 */
export interface SpeciesSlopeInput {
  species: string;
  stream: string;
  estimate: number;
  se: number | null;
}

export interface SpeciesSlope extends SpeciesSlopeInput {
  lower: number | null;
  upper: number | null;
}

const Z95 = 1.959964;

/** Build forest-plot rows (with CIs) sorted by effect size (descending). */
export function toForestPlot(rows: SpeciesSlopeInput[]): SpeciesSlope[] {
  return rows
    .map((r) => ({
      ...r,
      lower: r.se != null ? r.estimate - Z95 * r.se : null,
      upper: r.se != null ? r.estimate + Z95 * r.se : null,
    }))
    .sort((a, b) => b.estimate - a.estimate);
}

/**
 * The "preferred" model among ψ variants (geo vs habitat) for one species: the
 * one with the lowest AIC. Both variants share the same detection history and
 * `p~effort` detection model, so their AICs compare like-for-like. A null AIC
 * (unfitted / degenerate) sorts last; all-null returns the first variant.
 */
export function preferredByAic<T extends { aic: number | null }>(variants: T[]): T | null {
  if (variants.length === 0) return null;
  return variants.reduce((best, v) => {
    const a = v.aic ?? Number.POSITIVE_INFINITY;
    const b = best.aic ?? Number.POSITIVE_INFINITY;
    return a < b ? v : best;
  });
}

/** Inverse-variance weighted mean of the slopes (rows with a usable SE only). */
export function inverseVarianceMean(rows: SpeciesSlopeInput[]): number | null {
  let wsum = 0;
  let wxsum = 0;
  for (const r of rows) {
    if (r.se == null || r.se <= 0) continue;
    const w = 1 / (r.se * r.se);
    wsum += w;
    wxsum += w * r.estimate;
  }
  return wsum > 0 ? wxsum / wsum : null;
}
