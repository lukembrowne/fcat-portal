/**
 * Unit tests for the pure selection algebra behind `useRowRangeSelection`.
 *
 * We don't pull in @testing-library/react just to exercise this — the
 * stateful bits are isolated to `computeRangeSelection`, which is a plain
 * function over (selectionMap, anchorId, currentId, orderedIds, checked).
 */

import { describe, it, expect } from "vitest";
import { computeRangeSelection } from "@/hooks/use-row-range-selection";

describe("computeRangeSelection", () => {
  it("returns null when there's no anchor", () => {
    expect(
      computeRangeSelection({}, null, 3, [1, 2, 3, 4], true)
    ).toBeNull();
  });

  it("returns null when current === anchor", () => {
    expect(
      computeRangeSelection({}, 3, 3, [1, 2, 3, 4], true)
    ).toBeNull();
  });

  it("returns null when anchor isn't in the visible order", () => {
    expect(
      computeRangeSelection({}, 99, 3, [1, 2, 3, 4], true)
    ).toBeNull();
  });

  it("returns null when current isn't in the visible order", () => {
    expect(
      computeRangeSelection({}, 1, 99, [1, 2, 3, 4], true)
    ).toBeNull();
  });

  it("selects forward range inclusive of both endpoints", () => {
    const next = computeRangeSelection({}, 2, 5, [1, 2, 3, 4, 5], true);
    expect(next).toEqual({ "2": true, "3": true, "4": true, "5": true });
  });

  it("selects backward range (current before anchor) inclusive", () => {
    const next = computeRangeSelection({}, 5, 2, [1, 2, 3, 4, 5], true);
    expect(next).toEqual({ "2": true, "3": true, "4": true, "5": true });
  });

  it("preserves selections outside the range", () => {
    const prev = { "1": true, "10": true };
    const next = computeRangeSelection(prev, 3, 5, [1, 2, 3, 4, 5, 10], true);
    expect(next).toEqual({
      "1": true,
      "3": true,
      "4": true,
      "5": true,
      "10": true,
    });
  });

  it("clears the range when checked is false", () => {
    const prev = { "1": true, "2": true, "3": true, "4": true, "5": true };
    const next = computeRangeSelection(prev, 2, 4, [1, 2, 3, 4, 5], false);
    expect(next).toEqual({ "1": true, "5": true });
  });

  it("respects the visible order, not the numeric value", () => {
    // Reverse-ordered list (e.g. sorted descending by some column)
    const next = computeRangeSelection({}, 5, 2, [5, 4, 3, 2, 1], true);
    expect(next).toEqual({ "5": true, "4": true, "3": true, "2": true });
  });

  it("does not mutate the prev selection map", () => {
    const prev: Record<string, boolean> = { "1": true };
    Object.freeze(prev);
    expect(() =>
      computeRangeSelection(prev, 2, 4, [1, 2, 3, 4, 5], true)
    ).not.toThrow();
  });

  it("only toggles ids inside the range, never outside", () => {
    const prev = { "9": true };
    const next = computeRangeSelection(prev, 2, 4, [1, 2, 3, 4, 5, 9], true);
    expect(next).toEqual({ "2": true, "3": true, "4": true, "9": true });
  });
});
