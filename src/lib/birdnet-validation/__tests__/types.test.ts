import { describe, it, expect } from "vitest";

import {
  confidenceToLogit,
  logitToConfidence,
  binEdges,
  binIndexFor,
  UNUSABLE_REASON_ES,
  DEFAULT_BIN_COUNT,
  SCORE_FLOOR,
  SCORE_CEILING,
  LOGIT_CLAMP_MAX,
  type UnusableReasonCode,
} from "../types";

describe("confidenceToLogit", () => {
  it("maps 0.5 to 0", () => {
    expect(confidenceToLogit(0.5)).toBeCloseTo(0, 12);
  });

  it("is the exact inverse of BirdNET's sigmoid at sensitivity 1.0", () => {
    // scripts/birdnet-runner.py runs with sensitivity=1.0, so the confidence
    // score is sigmoid(logit) with no scaling.
    for (const conf of [0.15, 0.3, 0.62, 0.88]) {
      expect(logitToConfidence(confidenceToLogit(conf))).toBeCloseTo(conf, 12);
    }
  });

  it("clamps confidence of exactly 1.0 instead of returning Infinity", () => {
    // Real data has these: 13 rows at exactly 1.0 for Ramphastos ambiguus.
    const logit = confidenceToLogit(1.0);
    expect(Number.isFinite(logit)).toBe(true);
    expect(logit).toBeCloseTo(Math.log(LOGIT_CLAMP_MAX / (1 - LOGIT_CLAMP_MAX)), 12);
  });

  it("clamps confidence of exactly 0 instead of returning -Infinity", () => {
    expect(Number.isFinite(confidenceToLogit(0))).toBe(true);
  });

  it("increases monotonically across the score range", () => {
    const scores = [0.1, 0.25, 0.5, 0.75, 0.9, 1.0];
    const logits = scores.map(confidenceToLogit);
    for (let i = 1; i < logits.length; i++) {
      expect(logits[i]).toBeGreaterThan(logits[i - 1]);
    }
  });
});

describe("binEdges", () => {
  it("produces contiguous bins spanning the full score range", () => {
    const edges = binEdges(DEFAULT_BIN_COUNT);
    expect(edges).toHaveLength(DEFAULT_BIN_COUNT);
    expect(edges[0].lo).toBeCloseTo(SCORE_FLOOR, 12);
    expect(edges.at(-1)!.hi).toBeCloseTo(SCORE_CEILING, 12);
    for (let i = 1; i < edges.length; i++) {
      expect(edges[i].lo).toBeCloseTo(edges[i - 1].hi, 12);
    }
  });

  it("handles a single bin", () => {
    expect(binEdges(1)).toEqual([{ lo: SCORE_FLOOR, hi: SCORE_CEILING }]);
  });
});

describe("binIndexFor", () => {
  it("places the score floor in the first bin", () => {
    expect(binIndexFor(0.1, DEFAULT_BIN_COUNT)).toBe(0);
  });

  it("places confidence of exactly 1.0 in the last bin, not outside", () => {
    // The naive floor() lands 1.0 at index binCount, which would silently drop
    // every top-scoring detection from sampling.
    expect(binIndexFor(1.0, DEFAULT_BIN_COUNT)).toBe(DEFAULT_BIN_COUNT - 1);
  });

  it("assigns mid-range scores to the expected bin", () => {
    expect(binIndexFor(0.15, 10)).toBe(0);
    expect(binIndexFor(0.55, 10)).toBe(5);
    expect(binIndexFor(0.95, 10)).toBe(9);
  });

  it("returns -1 for scores outside the range", () => {
    expect(binIndexFor(0.05, DEFAULT_BIN_COUNT)).toBe(-1);
    expect(binIndexFor(1.5, DEFAULT_BIN_COUNT)).toBe(-1);
  });

  it("agrees with binEdges for every bin boundary", () => {
    const edges = binEdges(DEFAULT_BIN_COUNT);
    edges.forEach((edge, i) => {
      expect(binIndexFor(edge.lo, DEFAULT_BIN_COUNT)).toBe(i);
    });
  });
});

describe("UNUSABLE_REASON_ES", () => {
  it("covers every unusable reason code", () => {
    // Coverage guard: an unusable outcome with no Spanish copy would surface
    // as "undefined" to the reviewer.
    const codes: UnusableReasonCode[] = [
      "insufficient_sample",
      "complete_separation",
      "non_monotonic",
      "threshold_out_of_range",
      "fit_failed",
    ];
    for (const code of codes) {
      expect(UNUSABLE_REASON_ES[code]).toBeTruthy();
      expect(typeof UNUSABLE_REASON_ES[code]).toBe("string");
    }
    expect(Object.keys(UNUSABLE_REASON_ES).sort()).toEqual([...codes].sort());
  });
});
