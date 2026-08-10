/**
 * Cohen's kappa and percent agreement between two reviewers.
 *
 * The degenerate branches matter as much as the arithmetic: pe = 1 makes kappa
 * 0/0, and returning NaN there would render as a blank cell that looks like
 * "not computed yet" rather than "trivially perfect and uninformative".
 */

import { describe, expect, it } from "vitest";
import { computeAgreement, type ReviewPair } from "../agreement";

/** Expand a 3x3 contingency table into the pair list the function takes. */
function pairsFromTable(table: number[][]): ReviewPair[] {
  const categories = ["correct", "incorrect", "uncertain"] as const;
  const pairs: ReviewPair[] = [];
  let id = 0;
  table.forEach((row, b) => {
    row.forEach((count, a) => {
      for (let i = 0; i < count; i++) {
        pairs.push({
          sampleId: id++,
          primary: categories[a],
          other: categories[b],
        });
      }
    });
  });
  return pairs;
}

describe("computeAgreement", () => {
  it("matches a hand-worked contingency table", () => {
    // Rows = trainee, columns = primary; diagonal 84 + 71 + 16 of 200.
    const result = computeAgreement(
      pairsFromTable([
        [84, 6, 3],
        [9, 71, 4],
        [2, 5, 16],
      ])
    );

    expect(result.n).toBe(200);
    expect(result.agreed).toBe(171);
    expect(result.percentAgreement).toBeCloseTo(0.855, 6);
    expect(result.kappa).toBeCloseTo(0.7558, 4);
    expect(result.kappaReason).toBeNull();
  });

  it("returns kappa 1 for perfect agreement across several categories", () => {
    const result = computeAgreement(
      pairsFromTable([
        [10, 0, 0],
        [0, 8, 0],
        [0, 0, 5],
      ])
    );

    expect(result.percentAgreement).toBe(1);
    expect(result.kappa).toBeCloseTo(1, 10);
    expect(result.kappaReason).toBeNull();
  });

  it("reports no variation rather than a number when both used one category", () => {
    // pe = 1, so kappa is 0/0. Agreement is trivially perfect and says nothing
    // about whether the reviewers can actually tell the categories apart.
    const result = computeAgreement(
      pairsFromTable([
        [40, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ])
    );

    expect(result.percentAgreement).toBe(1);
    expect(result.kappa).toBeNull();
    expect(result.kappaReason).toBe("no_variation");
  });

  it("returns a negative kappa when reviewers disagree systematically", () => {
    const result = computeAgreement(
      pairsFromTable([
        [0, 20, 0],
        [20, 0, 0],
        [0, 0, 0],
      ])
    );

    expect(result.percentAgreement).toBe(0);
    expect(result.kappa).toBeLessThan(0);
    expect(result.kappaReason).toBeNull();
  });

  it("reports no overlap for an empty pair list", () => {
    const result = computeAgreement([]);

    expect(result.n).toBe(0);
    expect(result.agreed).toBe(0);
    expect(result.percentAgreement).toBeNull();
    expect(result.kappa).toBeNull();
    expect(result.kappaReason).toBe("no_overlap");
  });

  it("lands near zero when agreement is at chance", () => {
    // Independent marginals: each reviewer splits 50/50 with no association.
    const result = computeAgreement(
      pairsFromTable([
        [25, 25, 0],
        [25, 25, 0],
        [0, 0, 0],
      ])
    );

    expect(result.kappa).toBeCloseTo(0, 6);
  });

  it("counts uncertain-versus-answered as a disagreement", () => {
    const result = computeAgreement([
      { sampleId: 1, primary: "correct", other: "uncertain" },
      { sampleId: 2, primary: "correct", other: "correct" },
    ]);

    expect(result.n).toBe(2);
    expect(result.agreed).toBe(1);
    expect(result.percentAgreement).toBe(0.5);
  });

  it("keeps uncertain as its own category rather than collapsing it", () => {
    // Both reviewers said uncertain — that is agreement, not an excluded row.
    const result = computeAgreement([
      { sampleId: 1, primary: "uncertain", other: "uncertain" },
      { sampleId: 2, primary: "correct", other: "correct" },
    ]);

    expect(result.n).toBe(2);
    expect(result.agreed).toBe(2);
    expect(result.percentAgreement).toBe(1);
  });
});
