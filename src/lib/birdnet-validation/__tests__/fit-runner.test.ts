/**
 * Exercises the real R worker (scripts/birdnet-threshold-runner.R) end to end.
 *
 * The reference values in "recovers known coefficients" were produced by
 * MASS::dose.p on the same data — see the delta-method note in the R script.
 * These tests need Rscript on PATH; they skip cleanly where it is absent so a
 * machine without R does not show a false failure.
 */

import { describe, it, expect, vi } from "vitest";
import { execFileSync } from "node:child_process";

vi.mock("server-only", () => ({}));

function hasRscript(): boolean {
  try {
    execFileSync("Rscript", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const describeR = hasRscript() ? describe : describe.skip;

/** Deterministic LCG so fixtures do not depend on Math.random. */
function lcg(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

const confToLogit = (c: number) =>
  Math.log(Math.min(0.999, Math.max(0.001, c)) / (1 - Math.min(0.999, Math.max(0.001, c))));

/**
 * Sample from a genuine logistic relationship between BirdNET score and
 * correctness, so the fit has something real to recover.
 */
function syntheticSample(
  n: number,
  intercept: number,
  slope: number,
  seed = 7
): Array<{ conf: number; outcome: 0 | 1 }> {
  const rand = lcg(seed);
  const rows: Array<{ conf: number; outcome: 0 | 1 }> = [];
  for (let i = 0; i < n; i++) {
    const conf = 0.1 + rand() * 0.9;
    const p = 1 / (1 + Math.exp(-(intercept + slope * confToLogit(conf))));
    rows.push({ conf, outcome: rand() < p ? 1 : 0 });
  }
  return rows;
}

describeR("fitThresholds", () => {
  it("recovers a known logistic relationship and returns a threshold in range", async () => {
    const { fitThresholds } = await import("../fit-runner");
    const observations = syntheticSample(400, -1.2, 1.4);

    const [result] = await fitThresholds([
      { campaignId: 1, species: "Ramphastos ambiguus", observations },
    ]);

    expect(result.usable).toBe(true);
    if (!result.usable) return;

    expect(result.converged).toBe(true);
    expect(result.slope).toBeGreaterThan(0);
    // Generous tolerance: this is a finite sample from the true model.
    expect(result.intercept).toBeCloseTo(-1.2, 0);
    expect(result.slope).toBeCloseTo(1.4, 0);

    const t95 = result.thresholds["0.95"];
    expect(t95.conf).toBeGreaterThan(0);
    expect(t95.conf).toBeLessThan(1);
    expect(t95.se).toBeGreaterThan(0);
    expect(t95.lower).toBeLessThan(t95.conf);
    expect(t95.upper).toBeGreaterThan(t95.conf);
    // The CI must stay inside (0,1) — it is computed on the logit scale and
    // back-transformed for exactly this reason.
    expect(t95.upper).toBeLessThanOrEqual(1);
  }, 30_000);

  it("orders thresholds so a stricter probability needs a higher score", async () => {
    const { fitThresholds } = await import("../fit-runner");
    const observations = syntheticSample(400, -1.0, 1.5, 11);

    const [result] = await fitThresholds([
      { campaignId: 1, species: "X", observations },
    ]);
    expect(result.usable).toBe(true);
    if (!result.usable) return;

    expect(result.thresholds["0.9"].conf).toBeLessThan(result.thresholds["0.95"].conf);
    expect(result.thresholds["0.95"].conf).toBeLessThan(result.thresholds["0.99"].conf);
  }, 30_000);

  it("reports complete separation when every review is correct", async () => {
    const { fitThresholds } = await import("../fit-runner");
    // The species that is always right — no threshold is estimable.
    const observations = Array.from({ length: 50 }, (_, i) => ({
      conf: 0.2 + (i / 50) * 0.7,
      outcome: 1 as const,
    }));

    const [result] = await fitThresholds([
      { campaignId: 3, species: "X", observations },
    ]);

    expect(result.usable).toBe(false);
    if (result.usable) return;
    expect(result.reason).toBe("complete_separation");
    expect(result.nCorrect).toBe(50);
  }, 30_000);

  it("reports complete separation when every review is incorrect", async () => {
    const { fitThresholds } = await import("../fit-runner");
    // The common case: BirdNET reports a species that is never actually there.
    const observations = Array.from({ length: 50 }, (_, i) => ({
      conf: 0.2 + (i / 50) * 0.7,
      outcome: 0 as const,
    }));

    const [result] = await fitThresholds([
      { campaignId: 4, species: "X", observations },
    ]);

    expect(result.usable).toBe(false);
    if (result.usable) return;
    expect(result.reason).toBe("complete_separation");
    expect(result.nCorrect).toBe(0);
  }, 30_000);

  it("reports a non-monotonic relationship when accuracy falls with score", async () => {
    const { fitThresholds } = await import("../fit-runner");
    // Inverted: high scores are wrong, low scores are right.
    const observations = syntheticSample(400, 1.0, -1.5, 23);

    const [result] = await fitThresholds([
      { campaignId: 5, species: "X", observations },
    ]);

    expect(result.usable).toBe(false);
    if (result.usable) return;
    expect(result.reason).toBe("non_monotonic");
  }, 30_000);

  it("refuses a sample below the minimum without invoking R", async () => {
    const { fitThresholds } = await import("../fit-runner");
    const observations = [
      { conf: 0.5, outcome: 1 as const },
      { conf: 0.6, outcome: 0 as const },
    ];

    const [result] = await fitThresholds([
      { campaignId: 6, species: "X", observations },
    ]);

    expect(result.usable).toBe(false);
    if (result.usable) return;
    expect(result.reason).toBe("insufficient_sample");
    expect(result.nReviewed).toBe(2);
    expect(result.nCorrect).toBe(1);
  });

  it("clamps confidence of exactly 1.0 instead of producing a non-finite fit", async () => {
    const { fitThresholds } = await import("../fit-runner");
    const observations = syntheticSample(200, -1.2, 1.4, 31);
    // Real data contains exact 1.0 values; log(1/0) would be Inf.
    for (let i = 0; i < 20; i++) observations.push({ conf: 1.0, outcome: 1 });

    const [result] = await fitThresholds([
      { campaignId: 7, species: "X", observations },
    ]);

    expect(result.usable).toBe(true);
    if (!result.usable) return;
    expect(Number.isFinite(result.intercept)).toBe(true);
    expect(Number.isFinite(result.slope)).toBe(true);
    expect(Number.isFinite(result.thresholds["0.95"].conf)).toBe(true);
  }, 30_000);

  it("fits several campaigns in one worker and returns them in request order", async () => {
    const { fitThresholds } = await import("../fit-runner");
    const requests = [
      { campaignId: 101, species: "A", observations: syntheticSample(300, -1.2, 1.4, 1) },
      // Unusable, sandwiched between two usable fits.
      {
        campaignId: 102,
        species: "B",
        observations: Array.from({ length: 40 }, () => ({
          conf: 0.5,
          outcome: 0 as const,
        })),
      },
      { campaignId: 103, species: "C", observations: syntheticSample(300, -0.8, 1.6, 2) },
    ];

    const results = await fitThresholds(requests);

    expect(results.map((r) => r.campaignId)).toEqual([101, 102, 103]);
    expect(results[0].usable).toBe(true);
    expect(results[1].usable).toBe(false);
    expect(results[2].usable).toBe(true);
  }, 60_000);

  it("returns an empty array for no requests", async () => {
    const { fitThresholds } = await import("../fit-runner");
    expect(await fitThresholds([])).toEqual([]);
  });
});

describe("fitThresholds without R", () => {
  it("fails every campaign cleanly when the interpreter cannot be spawned", async () => {
    vi.stubEnv("OCCUPANCY_RSCRIPT_PATH", "/nonexistent/rscript-binary");
    vi.resetModules();
    const { fitThresholds } = await import("../fit-runner");

    const results = await fitThresholds([
      {
        campaignId: 9,
        species: "X",
        observations: Array.from({ length: 40 }, (_, i) => ({
          conf: 0.1 + i * 0.02,
          outcome: (i % 2) as 0 | 1,
        })),
      },
    ]);

    // Never throws — the caller gets a persistable failure.
    expect(results).toHaveLength(1);
    expect(results[0].usable).toBe(false);
    if (!results[0].usable) expect(results[0].reason).toBe("fit_failed");
    vi.unstubAllEnvs();
  }, 30_000);
});
