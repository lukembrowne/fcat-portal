/**
 * Presentation order must carry no information about the BirdNET score.
 *
 * WHY THIS EXISTS: `drawStratifiedSample` emits candidates bin by bin in
 * ascending order and `drawTopScoring` emits them score-descending. Assigning
 * `order_index` from that emission order — which is what the code did — meant a
 * reviewer walked the sample from the lowest score band to the highest. The
 * first clips all sat in [0.1, 0.2) and the last in [0.9, 1.0), and the sample
 * composition table on the species page states the bands are equal-sized, so
 * position mapped to score band by inspection.
 *
 * That is the anchoring the review UI's blinding exists to prevent, and it is
 * worse than showing the number: a reviewer notices monotonically improving
 * audio within a dozen clips whether or not they reason about it consciously.
 */

import { describe, it, expect } from "vitest";

import { presentationOrder } from "../sampling";
import type { SampleCandidate } from "../sampling";

const candidate = (id: number, confidence: number): SampleCandidate => ({
  audioIdentificationId: id,
  confidence,
  binIndex: Math.min(8, Math.floor((confidence - 0.1) / 0.1)),
  deploymentId: 1,
  siteName: "SITE-001",
});

/** Ascending-confidence candidates, the shape the stratified draw produces. */
function ascending(n: number): SampleCandidate[] {
  return Array.from({ length: n }, (_, i) =>
    candidate(i + 1, 0.1 + (0.9 * i) / Math.max(1, n - 1))
  );
}

/** Spearman rank correlation between array position and confidence. */
function positionConfidenceCorrelation(rows: SampleCandidate[]): number {
  const n = rows.length;
  const byConf = [...rows].sort((a, b) => a.confidence - b.confidence);
  const confRank = new Map(byConf.map((r, i) => [r.audioIdentificationId, i]));

  let sumD2 = 0;
  rows.forEach((row, position) => {
    const d = position - confRank.get(row.audioIdentificationId)!;
    sumD2 += d * d;
  });
  return 1 - (6 * sumD2) / (n * (n * n - 1));
}

describe("presentationOrder", () => {
  it("breaks the correlation between queue position and confidence", () => {
    // The assertion that fails against the old behaviour: feeding it a
    // perfectly ascending list must not give a perfectly ascending list back.
    const input = ascending(60);
    expect(positionConfidenceCorrelation(input)).toBeCloseTo(1, 5);

    const ordered = presentationOrder(input, 12345);

    expect(Math.abs(positionConfidenceCorrelation(ordered))).toBeLessThan(0.5);
  });

  it("returns a permutation — same ids, same length, nothing lost", () => {
    const input = ascending(40);
    const ordered = presentationOrder(input, 999);

    expect(ordered).toHaveLength(input.length);
    expect(new Set(ordered.map((r) => r.audioIdentificationId))).toEqual(
      new Set(input.map((r) => r.audioIdentificationId))
    );
  });

  it("preserves each candidate's own fields untouched", () => {
    // Only the ORDER changes. Confidence, bin and deployment are what the fit
    // and the coverage chart read; reordering must not disturb them.
    const input = ascending(10);
    const ordered = presentationOrder(input, 7);
    for (const row of ordered) {
      const original = input.find(
        (r) => r.audioIdentificationId === row.audioIdentificationId
      )!;
      expect(row).toEqual(original);
    }
  });

  it("is reproducible for the same seed", () => {
    const input = ascending(30);
    const a = presentationOrder(input, 4242).map((r) => r.audioIdentificationId);
    const b = presentationOrder(input, 4242).map((r) => r.audioIdentificationId);
    expect(a).toEqual(b);
  });

  it("produces a different order for a different seed", () => {
    const input = ascending(30);
    const a = presentationOrder(input, 1).map((r) => r.audioIdentificationId);
    const b = presentationOrder(input, 2).map((r) => r.audioIdentificationId);
    expect(a).not.toEqual(b);
  });

  it("gives a genuinely different order per seed, not one order rotated", () => {
    // The assertion that fails against `(id + seed) * M mod P`: that hash is
    // affine in the id, so the seed shifts every value by the same constant and
    // sorting returns ONE cyclic order started at a different point. Measured on
    // a real 200-clip sample, 5000 seeds produced 14 distinct orderings.
    const input = ascending(60);
    const seen = new Set(
      Array.from({ length: 300 }, (_, i) =>
        presentationOrder(input, i + 1)
          .map((r) => r.audioIdentificationId)
          .join(",")
      )
    );
    expect(seen.size).toBe(300);
  });

  it("keeps the position/confidence correlation near zero across seeds", () => {
    // The rotation failure mode is invisible to a single-seed check: every seed
    // inherited the SAME correlation (-0.152, sd 0.008) because every seed
    // produced the same relative order. A real shuffle scatters around zero
    // with sd ~= 1/sqrt(n-1), so both the mean and the spread are asserted.
    const input = ascending(60);
    const rhos = Array.from({ length: 200 }, (_, i) =>
      positionConfidenceCorrelation(presentationOrder(input, i + 1))
    );

    const mean = rhos.reduce((s, v) => s + v, 0) / rhos.length;
    const sd = Math.sqrt(
      rhos.reduce((s, v) => s + (v - mean) ** 2, 0) / rhos.length
    );

    expect(Math.abs(mean)).toBeLessThan(0.05);
    // Roughly 1/sqrt(59) = 0.13. A rotated order collapses this toward zero.
    expect(sd).toBeGreaterThan(0.05);
    expect(Math.max(...rhos.map(Math.abs))).toBeLessThan(0.6);
  });

  it("permutes an already-shuffled input rather than passing it through", () => {
    const input = [
      candidate(5, 0.5),
      candidate(1, 0.9),
      candidate(9, 0.2),
      candidate(3, 0.7),
      candidate(7, 0.3),
      candidate(2, 0.6),
    ];
    const ordered = presentationOrder(input, 31337).map((r) => r.audioIdentificationId);
    expect(ordered).not.toEqual(input.map((r) => r.audioIdentificationId));
  });

  it("does not mutate the input array", () => {
    const input = ascending(10);
    const before = input.map((r) => r.audioIdentificationId);
    presentationOrder(input, 5);
    expect(input.map((r) => r.audioIdentificationId)).toEqual(before);
  });

  it("handles empty and single-element inputs", () => {
    expect(presentationOrder([], 1)).toEqual([]);
    const one = [candidate(1, 0.5)];
    expect(presentationOrder(one, 1)).toEqual(one);
  });
});
