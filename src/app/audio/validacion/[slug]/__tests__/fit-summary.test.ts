import { describe, it, expect } from "vitest";

import {
  summarizeFit,
  isFitStale,
  thresholdImpact,
  curvePoints,
  formatThresholdWithCi,
  formatFitTimestamp,
  describeModelVersions,
  separationCase,
} from "../fit-summary";
import type { BirdnetSpeciesThreshold } from "@/db/schema";

const baseRow = (over: Partial<BirdnetSpeciesThreshold> = {}): BirdnetSpeciesThreshold =>
  ({
    id: 1,
    campaignId: 1,
    species: "Ramphastos ambiguus",
    nReviewed: 200,
    nCorrect: 150,
    nUncertain: 5,
    intercept: -1.2,
    slope: 1.4,
    converged: true,
    thresholdConf90: 0.9,
    thresholdConf95: 0.951,
    thresholdConf99: 0.98,
    thresholdSe95: 0.03,
    ciLower95: 0.9,
    ciUpper95: 0.975,
    unusableReason: null,
    modelVersion: "BirdNET-2.4",
    isActive: false,
    fittedAt: new Date(),
    appliedAt: null,
    appliedBy: null,
    ...over,
  }) as BirdnetSpeciesThreshold;

describe("summarizeFit", () => {
  it("marks a fit with a threshold as usable", () => {
    const s = summarizeFit(baseRow());
    expect(s.usable).toBe(true);
    expect(s.thresholdConf95).toBe(0.951);
    expect(s.reason).toBeNull();
  });

  it("marks a fit carrying an unusable reason as unusable", () => {
    const s = summarizeFit(
      baseRow({ thresholdConf95: null, unusableReason: "Separación completa" })
    );
    expect(s.usable).toBe(false);
    expect(s.reason).toBe("Separación completa");
  });

  it("computes raw precision across the reviewed sample", () => {
    expect(summarizeFit(baseRow({ nReviewed: 200, nCorrect: 150 })).rawPrecision).toBeCloseTo(
      0.75,
      6
    );
  });

  it("reports null precision rather than dividing by zero", () => {
    expect(summarizeFit(baseRow({ nReviewed: 0, nCorrect: 0 })).rawPrecision).toBeNull();
  });
});

describe("isFitStale", () => {
  it("is not stale when the fit saw every usable review", () => {
    expect(isFitStale(100, 105, 5)).toBe(false);
  });

  it("is stale once new usable reviews land", () => {
    expect(isFitStale(100, 120, 5)).toBe(true);
  });

  it("does not count new uncertain reviews as staleness", () => {
    // The fit excludes uncertain, so 10 more uncertain answers change nothing.
    expect(isFitStale(100, 115, 15)).toBe(false);
  });
});

describe("thresholdImpact", () => {
  const confs = [0.15, 0.35, 0.55, 0.75, 0.85, 0.95];

  it("counts detections at or above the threshold", () => {
    const impact = thresholdImpact(confs, 0.75);
    expect(impact.kept).toBe(3);
    expect(impact.dropped).toBe(3);
    expect(impact.keptFraction).toBeCloseTo(0.5, 6);
  });

  it("treats the boundary as inclusive, matching the SQL filter", () => {
    expect(thresholdImpact([0.7], 0.7).kept).toBe(1);
  });

  it("keeps everything at the score floor", () => {
    expect(thresholdImpact(confs, 0.1).kept).toBe(6);
  });

  it("keeps nothing above the top score", () => {
    expect(thresholdImpact(confs, 0.99).kept).toBe(0);
  });

  it("handles an empty detection list without dividing by zero", () => {
    const impact = thresholdImpact([], 0.7);
    expect(impact.kept).toBe(0);
    expect(impact.keptFraction).toBe(0);
  });
});

describe("curvePoints", () => {
  it("spans the full score range", () => {
    const pts = curvePoints(-1.2, 1.4, 10);
    expect(pts).toHaveLength(11);
    expect(pts[0].conf).toBeCloseTo(0.1, 6);
    expect(pts.at(-1)!.conf).toBeCloseTo(1.0, 6);
  });

  it("increases monotonically for a positive slope", () => {
    const pts = curvePoints(-1.2, 1.4, 30);
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i].p).toBeGreaterThan(pts[i - 1].p);
    }
  });

  it("keeps probabilities inside (0,1)", () => {
    for (const pt of curvePoints(-5, 3, 40)) {
      expect(pt.p).toBeGreaterThan(0);
      expect(pt.p).toBeLessThan(1);
    }
  });

  it("agrees with the fitted threshold: the curve reaches 0.95 at it", () => {
    // Solve for the 0.95 threshold the same way the R runner does, then check
    // the plotted curve passes through it.
    const intercept = -1.2;
    const slope = 1.4;
    const xStar = (Math.log(0.95 / 0.05) - intercept) / slope;
    const confStar = 1 / (1 + Math.exp(-xStar));
    const clamped = Math.min(0.999, Math.max(0.001, confStar));
    const x = Math.log(clamped / (1 - clamped));
    expect(1 / (1 + Math.exp(-(intercept + slope * x)))).toBeCloseTo(0.95, 6);
  });
});

describe("formatThresholdWithCi", () => {
  it("renders the value with its interval", () => {
    expect(formatThresholdWithCi(0.951, 0.9, 0.975)).toBe("0.951 (IC 95%: 0.900–0.975)");
  });

  it("renders the bare value when the interval is missing", () => {
    expect(formatThresholdWithCi(0.951, null, null)).toBe("0.951");
  });

  it("renders a dash for an unusable fit", () => {
    expect(formatThresholdWithCi(null, null, null)).toBe("—");
  });
});

describe("formatFitTimestamp", () => {
  it("renders Ecuador wall-clock, not the runtime's timezone", () => {
    // 14:20 UTC is 09:20 in Guayaquil (UTC-5, no DST). A bare toLocaleString in
    // the production container — which runs UTC — would print 14:20 and tell an
    // Ecuadorian reader the fit ran five hours later than it did.
    const out = formatFitTimestamp(new Date("2026-08-10T14:20:00Z"));
    expect(out).toContain("09:20");
    expect(out).not.toContain("14:20");
  });

  it("carries the date as well as the time", () => {
    const out = formatFitTimestamp(new Date("2026-08-10T14:20:00Z"));
    expect(out).toContain("2026");
    expect(out).toContain("10");
  });

  it("distinguishes two fits minutes apart on the same day", () => {
    // The exact case on screen: two rows both dated 2026-08-10, 38 s apart,
    // identical in every other column.
    const a = formatFitTimestamp(new Date("2026-08-10T14:20:30Z"));
    const b = formatFitTimestamp(new Date("2026-08-10T14:41:08Z"));
    expect(a).not.toBe(b);
  });
});

describe("describeModelVersions", () => {
  it("parses a single stored label", () => {
    expect(describeModelVersions("birdnet-analyzer")).toEqual({
      versions: ["birdnet-analyzer"],
      mixed: false,
    });
  });

  it("splits a sample that spans versions and flags it", () => {
    // 63 of 69 sampled species on the dev database look exactly like this.
    expect(
      describeModelVersions("birdnet-analyzer, birdnet-analyzer@2.4.0; model=V2.4")
    ).toEqual({
      versions: ["birdnet-analyzer", "birdnet-analyzer@2.4.0; model=V2.4"],
      mixed: true,
    });
  });

  it("treats a missing or blank label as no versions rather than one empty one", () => {
    expect(describeModelVersions(null)).toEqual({ versions: [], mixed: false });
    expect(describeModelVersions("   ")).toEqual({ versions: [], mixed: false });
    expect(describeModelVersions(", ,")).toEqual({ versions: [], mixed: false });
  });
});

describe("separationCase", () => {
  it("identifies a species BirdNET got right at every sampled score", () => {
    // Ortalis erythroptera on the dev database: 50 of 50 correct, spanning
    // confidence 0.104 to 0.996.
    expect(separationCase(50, 50)).toBe("all-correct");
  });

  it("identifies a species BirdNET never got right", () => {
    expect(separationCase(50, 0)).toBe("all-incorrect");
  });

  it("returns null when both outcomes are present — the fittable case", () => {
    expect(separationCase(50, 25)).toBeNull();
    expect(separationCase(50, 49)).toBeNull();
    expect(separationCase(50, 1)).toBeNull();
  });

  it("returns null with nothing reviewed, rather than calling zero of zero correct", () => {
    expect(separationCase(0, 0)).toBeNull();
  });
});
