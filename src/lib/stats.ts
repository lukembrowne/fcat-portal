/**
 * Small statistical helpers used by the iButton temperature distributions
 * (and any future box plot / summary chart).
 *
 * No dependencies. Linear interpolation ("type 7", same as R default and
 * NumPy default).
 */

/**
 * Compute quantiles of `values` at the given probabilities (each in [0, 1]).
 * Uses linear interpolation between order statistics (R type 7 / NumPy default).
 *
 * Returns an array of the same length as `probs`, or `null` if `values` is empty.
 */
export function quantiles(
  values: readonly number[],
  probs: readonly number[],
): number[] | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return probs.map((p) => {
    if (p <= 0) return sorted[0];
    if (p >= 1) return sorted[n - 1];
    const h = (n - 1) * p;
    const lo = Math.floor(h);
    const hi = Math.ceil(h);
    if (lo === hi) return sorted[lo];
    return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
  });
}

export interface BoxPlotStats {
  /** Smallest value in the sample. */
  min: number;
  /** Largest value in the sample. */
  max: number;
  /** First quartile (25th percentile). */
  q1: number;
  /** Median (50th percentile). */
  median: number;
  /** Third quartile (75th percentile). */
  q3: number;
  /** Interquartile range: q3 - q1. */
  iqr: number;
  /** Lower Tukey whisker: smallest value >= q1 - 1.5 * iqr. */
  whiskerLow: number;
  /** Upper Tukey whisker: largest value <= q3 + 1.5 * iqr. */
  whiskerHigh: number;
  /** Number of samples. */
  n: number;
}

/**
 * Compute box plot statistics using the standard Tukey convention
 * (whiskers extend to the most extreme non-outlier).
 *
 * For n === 1, all quartiles collapse to the single value and the
 * whiskers equal that value. For n === 2, the median is the mean of
 * the two values and q1/q3 are the two values themselves (per linear
 * interpolation).
 *
 * Returns `null` if `values` is empty.
 */
export function boxPlotStats(values: readonly number[]): BoxPlotStats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const qs = quantiles(sorted, [0.25, 0.5, 0.75]);
  // quantiles() returned non-null because sorted.length > 0
  const [q1, median, q3] = qs as [number, number, number];
  const iqr = q3 - q1;
  const loFence = q1 - 1.5 * iqr;
  const hiFence = q3 + 1.5 * iqr;
  // Most extreme values still within the fences (Tukey whiskers).
  let whiskerLow = sorted[sorted.length - 1];
  for (const v of sorted) {
    if (v >= loFence) {
      whiskerLow = v;
      break;
    }
  }
  let whiskerHigh = sorted[0];
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i] <= hiFence) {
      whiskerHigh = sorted[i];
      break;
    }
  }
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    q1,
    median,
    q3,
    iqr,
    whiskerLow,
    whiskerHigh,
    n: sorted.length,
  };
}
