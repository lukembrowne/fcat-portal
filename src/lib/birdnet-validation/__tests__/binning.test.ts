import { describe, it, expect } from "vitest";

import { allocateBins, describeAllocation } from "../binning";
import { binEdges } from "../types";

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("allocateBins", () => {
  it("splits evenly when every bin has ample availability", () => {
    const alloc = allocateBins(new Array(10).fill(1000), 200);
    expect(alloc).toEqual(new Array(10).fill(20));
    expect(sum(alloc)).toBe(200);
  });

  it("redistributes a thin bin's shortfall and still hits the target", () => {
    // Mirrors real Ramphastos ambiguus data: the [1.0, 1.0] bin holds 13 rows.
    const available = [28069, 16519, 12665, 11111, 10819, 11641, 13402, 18967, 50435, 13];
    const alloc = allocateBins(available, 200);

    expect(sum(alloc)).toBe(200);
    expect(alloc[9]).toBe(13);
    alloc.forEach((a, i) => expect(a).toBeLessThanOrEqual(available[i]));
  });

  it("spreads the shortfall evenly rather than favouring the densest bins", () => {
    // The failure mode this guards: handing the shortfall out proportionally to
    // availability would pile the extra draws onto the huge extreme bins,
    // recreating the proportional sample the design exists to avoid.
    const available = [1000, 1000, 5, 1000, 100000];
    const alloc = allocateBins(available, 100);

    expect(sum(alloc)).toBe(100);
    expect(alloc[2]).toBe(5);
    // The 15 orphaned draws land evenly, not all in the 100k bin.
    const others = [alloc[0], alloc[1], alloc[3], alloc[4]];
    expect(Math.max(...others) - Math.min(...others)).toBeLessThanOrEqual(1);
  });

  it("returns everything available when the species has too few detections", () => {
    const available = [3, 0, 5, 2, 0];
    const alloc = allocateBins(available, 200);
    expect(alloc).toEqual([3, 0, 5, 2, 0]);
    expect(sum(alloc)).toBe(10);
  });

  it("handles an empty bin without stalling", () => {
    const alloc = allocateBins([100, 0, 100], 30);
    expect(sum(alloc)).toBe(30);
    expect(alloc[1]).toBe(0);
  });

  it("puts the whole target in the only non-empty bin", () => {
    const alloc = allocateBins([0, 0, 500, 0], 200);
    expect(alloc).toEqual([0, 0, 200, 0]);
  });

  it("distributes a remainder that does not divide evenly", () => {
    const alloc = allocateBins(new Array(3).fill(100), 100);
    expect(sum(alloc)).toBe(100);
    expect(Math.max(...alloc) - Math.min(...alloc)).toBeLessThanOrEqual(1);
  });

  it("never exceeds any bin's availability", () => {
    const available = [1, 2, 3, 4, 5];
    const alloc = allocateBins(available, 1000);
    alloc.forEach((a, i) => expect(a).toBeLessThanOrEqual(available[i]));
    expect(sum(alloc)).toBe(15);
  });

  it("returns zeros for a non-positive target", () => {
    expect(allocateBins([10, 10], 0)).toEqual([0, 0]);
    expect(allocateBins([10, 10], -5)).toEqual([0, 0]);
  });

  it("returns an empty array when there are no bins", () => {
    expect(allocateBins([], 200)).toEqual([]);
  });

  it("treats negative availability as zero rather than allocating into it", () => {
    const alloc = allocateBins([-5, 100], 20);
    expect(alloc[0]).toBe(0);
    expect(sum(alloc)).toBe(20);
  });
});

describe("describeAllocation", () => {
  it("pairs edges with availability and allocation", () => {
    const edges = binEdges(3);
    const rows = describeAllocation(edges, [10, 20, 30], [5, 5, 5]);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ binIndex: 0, available: 10, allocated: 5 });
    expect(rows[2].hi).toBeCloseTo(1.0, 12);
  });
});
