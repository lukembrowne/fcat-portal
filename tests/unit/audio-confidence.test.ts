import { describe, expect, it } from "vitest";
import {
  CONFIDENCE_MAX,
  CONFIDENCE_MIN,
  DEFAULT_CONFIDENCE_THRESHOLD,
  applyConfidenceFilter,
  canonicalThreshold,
  formatThreshold,
  parseThresholdParam,
} from "@/lib/audio-confidence";

describe("parseThresholdParam", () => {
  it("returns the default for missing inputs", () => {
    expect(parseThresholdParam(undefined)).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
    expect(parseThresholdParam(null)).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
    expect(parseThresholdParam("")).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
    expect(parseThresholdParam("   ")).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
  });

  it("returns the default for non-numeric values", () => {
    expect(parseThresholdParam("abc")).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
    expect(parseThresholdParam("NaN")).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
    expect(parseThresholdParam("0.5x")).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
  });

  it("clamps below the minimum", () => {
    expect(parseThresholdParam("0.05")).toBe(CONFIDENCE_MIN);
    expect(parseThresholdParam("-1")).toBe(CONFIDENCE_MIN);
    expect(parseThresholdParam("0")).toBe(CONFIDENCE_MIN);
  });

  it("clamps above the maximum", () => {
    expect(parseThresholdParam("2")).toBe(CONFIDENCE_MAX);
    expect(parseThresholdParam("1.5")).toBe(CONFIDENCE_MAX);
    expect(parseThresholdParam("999")).toBe(CONFIDENCE_MAX);
  });

  it("rounds to two decimal places", () => {
    expect(parseThresholdParam("0.7000000001")).toBe(0.7);
    expect(parseThresholdParam("0.555")).toBeCloseTo(0.56, 5);
    expect(parseThresholdParam("0.554")).toBeCloseTo(0.55, 5);
  });

  it("accepts in-range values verbatim", () => {
    expect(parseThresholdParam("0.5")).toBe(0.5);
    expect(parseThresholdParam("0.85")).toBe(0.85);
    expect(parseThresholdParam("0.70")).toBe(0.7);
  });

  it("handles the Next.js array search-param shape", () => {
    expect(parseThresholdParam(["0.85"])).toBe(0.85);
    expect(parseThresholdParam(["abc"])).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
  });
});

describe("canonicalThreshold", () => {
  it("falls back to default on non-finite values", () => {
    expect(canonicalThreshold(Number.NaN)).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
    expect(canonicalThreshold(Number.POSITIVE_INFINITY)).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
    expect(canonicalThreshold(Number.NEGATIVE_INFINITY)).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
  });

  it("rounds to two decimals", () => {
    expect(canonicalThreshold(0.7000001)).toBe(0.7);
    expect(canonicalThreshold(0.123456)).toBe(0.12);
  });

  it("clamps to [MIN, MAX]", () => {
    expect(canonicalThreshold(-0.5)).toBe(CONFIDENCE_MIN);
    expect(canonicalThreshold(5)).toBe(CONFIDENCE_MAX);
  });
});

describe("formatThreshold", () => {
  it("always renders two decimals", () => {
    expect(formatThreshold(0.7)).toBe("0.70");
    expect(formatThreshold(0.5)).toBe("0.50");
    expect(formatThreshold(1)).toBe("1.00");
    expect(formatThreshold(0.1)).toBe("0.10");
  });

  it("canonicalises before formatting", () => {
    expect(formatThreshold(5)).toBe("1.00");
    expect(formatThreshold(Number.NaN)).toBe(formatThreshold(DEFAULT_CONFIDENCE_THRESHOLD));
  });
});

describe("applyConfidenceFilter", () => {
  it("returns a Drizzle SQL fragment without throwing on edge inputs", () => {
    expect(() => applyConfidenceFilter(0.7)).not.toThrow();
    expect(() => applyConfidenceFilter(Number.NaN)).not.toThrow();
    expect(() => applyConfidenceFilter(-1)).not.toThrow();
    expect(() => applyConfidenceFilter(2)).not.toThrow();
  });

  it("returns a defined object", () => {
    const fragment = applyConfidenceFilter(0.7);
    expect(fragment).toBeDefined();
    expect(typeof fragment).toBe("object");
  });
});
