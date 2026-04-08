import { describe, it, expect } from "vitest";
import { quantiles, boxPlotStats } from "@/lib/stats";

describe("quantiles", () => {
  it("returns null for empty input", () => {
    expect(quantiles([], [0.25, 0.5, 0.75])).toBeNull();
  });

  it("computes standard quartiles on [1..5] (R type 7)", () => {
    // R: quantile(1:5, c(.25,.5,.75)) -> 2, 3, 4
    expect(quantiles([1, 2, 3, 4, 5], [0.25, 0.5, 0.75])).toEqual([2, 3, 4]);
  });

  it("interpolates linearly between order statistics", () => {
    // n=4: h = 3 * 0.5 = 1.5 -> (sorted[1] + sorted[2]) / 2
    expect(quantiles([10, 20, 30, 40], [0.5])).toEqual([25]);
  });

  it("handles a single value", () => {
    expect(quantiles([7], [0, 0.5, 1])).toEqual([7, 7, 7]);
  });

  it("sorts input before computing", () => {
    expect(quantiles([5, 1, 3, 4, 2], [0.5])).toEqual([3]);
  });

  it("clamps probs <= 0 to min and >= 1 to max", () => {
    expect(quantiles([1, 2, 3], [-0.5, 1.5])).toEqual([1, 3]);
  });
});

describe("boxPlotStats", () => {
  it("returns null for empty input", () => {
    expect(boxPlotStats([])).toBeNull();
  });

  it("collapses to a single value for n=1", () => {
    const s = boxPlotStats([42])!;
    expect(s.min).toBe(42);
    expect(s.max).toBe(42);
    expect(s.q1).toBe(42);
    expect(s.median).toBe(42);
    expect(s.q3).toBe(42);
    expect(s.iqr).toBe(0);
    expect(s.whiskerLow).toBe(42);
    expect(s.whiskerHigh).toBe(42);
    expect(s.n).toBe(1);
  });

  it("handles n=2 via linear interpolation", () => {
    const s = boxPlotStats([10, 20])!;
    // sorted[0]=10, sorted[1]=20; q1 h=0.25 -> 10+0.25*10 = 12.5
    expect(s.q1).toBe(12.5);
    expect(s.median).toBe(15);
    expect(s.q3).toBe(17.5);
    expect(s.whiskerLow).toBe(10);
    expect(s.whiskerHigh).toBe(20);
  });

  it("computes Tukey whiskers on a standard sample", () => {
    const s = boxPlotStats([1, 2, 3, 4, 5])!;
    expect(s.q1).toBe(2);
    expect(s.median).toBe(3);
    expect(s.q3).toBe(4);
    expect(s.iqr).toBe(2);
    // fences: q1 - 3 = -1, q3 + 3 = 7 -> no outliers
    expect(s.whiskerLow).toBe(1);
    expect(s.whiskerHigh).toBe(5);
  });

  it("caps whiskers at the fences when outliers are present", () => {
    // [1..9] + outlier 100: q1=3, q3=7, iqr=4, hiFence=13, loFence=-3
    const s = boxPlotStats([1, 2, 3, 4, 5, 6, 7, 8, 9, 100])!;
    expect(s.whiskerLow).toBe(1);
    expect(s.whiskerHigh).toBe(9);
    expect(s.max).toBe(100);
  });

  it("records the full sample min and max regardless of whiskers", () => {
    const s = boxPlotStats([-50, 1, 2, 3, 4, 5, 6, 7, 8, 9, 100])!;
    expect(s.min).toBe(-50);
    expect(s.max).toBe(100);
  });
});
