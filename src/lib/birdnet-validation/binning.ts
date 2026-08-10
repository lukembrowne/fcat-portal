/**
 * Bin allocation for score-stratified validation sampling.
 *
 * Pure — no database, no I/O. Given how many detections exist in each
 * confidence bin and how many clips we want in total, decide how many to draw
 * from each bin.
 *
 * WHY UNIFORM RATHER THAN PROPORTIONAL: BirdNET score distributions are
 * strongly U-shaped. Ramphastos ambiguus has 28,069 detections in [0.1, 0.2)
 * and 50,435 in [0.9, 1.0), but only ~11,000 in each middle bin. A sample drawn
 * proportionally mirrors that shape and starves the transition zone — exactly
 * the region where the threshold sits and where the logistic fit needs
 * resolution. Drawing equal numbers per bin is what makes the threshold
 * estimate stable (Panwar, in prep.; Symes, pers. comm. 2026).
 */

/**
 * Distribute `target` draws across bins, capped by each bin's availability.
 *
 * Starts from an even split, then hands any shortfall (from bins with fewer
 * detections than their share) to the bins that still have headroom, one draw
 * at a time in round-robin order.
 *
 * The round-robin spread is deliberate. Handing the shortfall out in proportion
 * to remaining availability would concentrate the extra draws in the already-
 * dense extreme bins, drifting the design back toward the proportional sample
 * this whole approach exists to avoid. Round-robin keeps the realised
 * allocation as close to uniform as each bin's availability permits.
 *
 * Returns an array parallel to `available`. Sums to `target`, or to
 * `sum(available)` when the species has fewer detections than requested.
 */
export function allocateBins(available: number[], target: number): number[] {
  const n = available.length;
  const alloc = new Array<number>(n).fill(0);
  if (n === 0 || target <= 0) return alloc;

  const base = Math.floor(target / n);
  for (let i = 0; i < n; i++) {
    alloc[i] = Math.min(Math.max(0, available[i]), base);
  }

  let remaining = target - alloc.reduce((sum, v) => sum + v, 0);

  while (remaining > 0) {
    let handedOut = 0;
    for (let i = 0; i < n && remaining > 0; i++) {
      if (alloc[i] < available[i]) {
        alloc[i]++;
        remaining--;
        handedOut++;
      }
    }
    // No bin had headroom: total availability is below the target. The caller
    // gets everything that exists, which is the honest outcome for a species
    // with few detections.
    if (handedOut === 0) break;
  }

  return alloc;
}

/** Per-bin allocation report, for surfacing the realised design in the UI. */
export interface BinAllocation {
  binIndex: number;
  lo: number;
  hi: number;
  available: number;
  allocated: number;
}

/** Pair bin edges with availability and allocation for display. */
export function describeAllocation(
  edges: Array<{ lo: number; hi: number }>,
  available: number[],
  allocated: number[]
): BinAllocation[] {
  return edges.map((edge, i) => ({
    binIndex: i,
    lo: edge.lo,
    hi: edge.hi,
    available: available[i] ?? 0,
    allocated: allocated[i] ?? 0,
  }));
}
