/**
 * Covariate standardization for occupancy models.
 *
 * `unmarked` fits are far better-behaved when continuous covariates are
 * z-standardized (mean 0, sd 1). We standardize in TS before handing data to R,
 * and persist the `mean`/`sd` so the R side can back-transform response curves
 * onto the raw covariate scale (e.g. plot ψ vs. real forest-cover proportion,
 * not vs. z-scores) and so the AOI prediction grid is standardized with the
 * SAME parameters the model was fit on. Never re-standardize the grid on its own
 * moments — that would silently shift predictions.
 */

export interface Standardization {
  mean: number;
  sd: number;
}

/** Population mean/sd (sd uses N, not N-1, matching how we apply it to the grid). */
export function fitStandardization(values: number[]): Standardization {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return { mean: 0, sd: 1 };
  const mean = finite.reduce((a, b) => a + b, 0) / finite.length;
  const variance =
    finite.reduce((a, b) => a + (b - mean) ** 2, 0) / finite.length;
  const sd = Math.sqrt(variance);
  // Guard the degenerate constant-covariate case: sd 0 → divide-by-zero → NaN.
  // Fall back to sd 1 so every standardized value becomes 0 (no information),
  // which is the correct behaviour for a covariate with no variation.
  return { mean, sd: sd > 0 ? sd : 1 };
}

export function standardizeValue(value: number, s: Standardization): number {
  return (value - s.mean) / s.sd;
}

export function standardizeArray(values: number[], s: Standardization): number[] {
  return values.map((v) => standardizeValue(v, s));
}

/** Map a standardized (z) value back to the raw covariate scale. */
export function backTransformValue(z: number, s: Standardization): number {
  return z * s.sd + s.mean;
}
