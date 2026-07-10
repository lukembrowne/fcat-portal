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
