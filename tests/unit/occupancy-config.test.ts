import { describe, it, expect } from "vitest";
import { buildDetectionFrame, type OccupancySite } from "@/lib/occupancy/detection-history";
import { assembleRunConfig } from "@/lib/occupancy/config";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

function frameOf(nSites: number) {
  const sites: OccupancySite[] = Array.from({ length: nSites }, (_, i) => ({
    siteId: `S${i}`,
    siteName: `S${i}`,
    latitude: 0,
    longitude: 0,
    windowStart: utc(2026, 1, 1),
    windowEnd: utc(2026, 1, 12),
  }));
  return buildDetectionFrame(sites, [], { binWidth: 5 });
}

describe("assembleRunConfig", () => {
  it("standardizes continuous covariates and records back-transform params", () => {
    const frame = frameOf(4);
    const { config, standardizations } = assembleRunConfig(frame, {
      species: "X",
      stream: "camera",
      siteCovariates: [
        { name: "forest", kind: "continuous", values: [0, 10, 20, 30] },
        { name: "habitat", kind: "factor", values: ["a", "b", "a", "b"] },
      ],
    });
    // mean 15, sd = sqrt(125) ~ 11.18
    expect(standardizations.forest.mean).toBeCloseTo(15, 10);
    const z = config.siteCovs.forest as number[];
    expect(z.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 10);
    expect(config.siteFactors).toEqual(["habitat"]);
    expect(config.siteCovs.habitat).toEqual(["a", "b", "a", "b"]);
    expect(config.psiFormula).toBe("~forest + habitat");
    expect(config.detFormula).toBe("~effort");
    // Effort is a CONTINUOUS detection covariate now — never a factor.
    expect(config.obsFactors).toEqual([]);
    expect(config.grid).toBeNull();
  });

  it("passes effort as a numeric obs covariate when it varies (12-day window → 5,5,2)", () => {
    const frame = frameOf(3); // window 01-01→01-12, bin 5 → nDays [5,5,2] per site
    const { config, dropped } = assembleRunConfig(frame, {
      species: "X",
      stream: "camera",
      siteCovariates: [],
    });
    expect(config.detFormula).toBe("~effort");
    expect(config.obsFactors).toEqual([]);
    // The obs covariate matrix is numeric (active days), not bucketed labels.
    const effRow = (config.obsCovs.effort as (number | null)[][])[0];
    expect(effRow).toEqual([5, 5, 2]);
    expect(dropped.find((d) => d.name === "effort")).toBeUndefined();
  });

  it("drops effort (→ ~1) when it is constant (10-day window → 5,5 everywhere)", () => {
    const sites: OccupancySite[] = Array.from({ length: 3 }, (_, i) => ({
      siteId: `S${i}`,
      siteName: `S${i}`,
      latitude: 0,
      longitude: 0,
      windowStart: utc(2026, 1, 1),
      windowEnd: utc(2026, 1, 10), // exactly two full 5-day bins → nDays [5,5]
    }));
    const frame = buildDetectionFrame(sites, [], { binWidth: 5 });
    const { config, dropped } = assembleRunConfig(frame, {
      species: "X",
      stream: "camera",
      siteCovariates: [],
    });
    expect(config.detFormula).toBe("~1");
    expect(config.obsCovs).toEqual({});
    expect(dropped.find((d) => d.name === "effort")?.reason).toMatch(/esfuerzo constante/);
  });

  it("standardizes the grid with SITE-fitted params, not the grid's own moments", () => {
    const frame = frameOf(2);
    const { config } = assembleRunConfig(frame, {
      species: "X",
      stream: "camera",
      siteCovariates: [{ name: "forest", kind: "continuous", values: [0, 10] }], // mean 5 sd 5
      gridCovariates: [{ name: "forest", kind: "continuous", values: [5, 10, 0] }],
    });
    // grid standardized with mean 5 sd 5 → [0, 1, -1]
    expect(config.grid!.forest).toEqual([0, 1, -1]);
  });

  it("carries factor grid values through as strings", () => {
    const frame = frameOf(2);
    const { config } = assembleRunConfig(frame, {
      species: "X",
      stream: "camera",
      siteCovariates: [{ name: "habitat", kind: "factor", values: ["a", "b"] }],
      gridCovariates: [{ name: "habitat", kind: "factor", values: ["a", "a", "b"] }],
    });
    expect(config.grid!.habitat).toEqual(["a", "a", "b"]);
  });

  it("throws when a covariate length does not match the site count", () => {
    const frame = frameOf(3);
    expect(() =>
      assembleRunConfig(frame, {
        species: "X",
        stream: "camera",
        siteCovariates: [{ name: "forest", kind: "continuous", values: [1, 2] }],
      }),
    ).toThrow(/3 sites/);
  });

  it("passes the frame's detection history and effort matrix straight through", () => {
    const frame = frameOf(2);
    const { config } = assembleRunConfig(frame, {
      species: "X",
      stream: "audio",
      siteCovariates: [],
    });
    expect(config.y).toBe(frame.y);
    expect(config.obsCovs.effort).toBe(frame.effort);
    expect(config.psiFormula).toBe("~1");
    expect(config.stream).toBe("audio");
  });
});
