import { describe, it, expect, vi } from "vitest";
import { spawnSync } from "node:child_process";

// server-only throws outside a Next server bundle; neutralize it (same pattern as
// tests/unit/system-events.test.ts). log is stubbed so the bridge's debug call is inert.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Only run when Rscript + unmarked are actually installed. In CI (until R lands in
// the image) this whole suite auto-skips instead of failing.
function rReady(): boolean {
  try {
    const r = spawnSync("Rscript", ["-e", 'cat(requireNamespace("unmarked", quietly=TRUE))'], {
      encoding: "utf8",
      timeout: 30_000,
    });
    return r.status === 0 && String(r.stdout).includes("TRUE");
  } catch {
    return false;
  }
}

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

describe.skipIf(!rReady())("runOccupancyModel (real R subprocess)", () => {
  it("fits occu end-to-end and returns effects + grid predictions", async () => {
    const { buildDetectionFrame } = await import("@/lib/occupancy/detection-history");
    const { assembleRunConfig } = await import("@/lib/occupancy/config");
    const { runOccupancyModel } = await import("@/lib/occupancy/runner");

    const sites = Array.from({ length: 25 }, (_, i) => ({
      siteId: `S${i}`,
      siteName: `S${i}`,
      latitude: 0,
      longitude: 0,
      windowStart: utc(2026, 1, 1),
      windowEnd: utc(2026, 1, 30),
    }));
    const forest = sites.map((_, i) => i / 25);
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const events: { siteId: string; captureDay: Date }[] = [];
    sites.forEach((s, i) => {
      if (rnd() < forest[i] * 0.9 + 0.05) {
        for (let o = 0; o < 6; o++) {
          if (rnd() < 0.45) events.push({ siteId: s.siteId, captureDay: utc(2026, 1, 2 + o * 5) });
        }
      }
    });

    const frame = buildDetectionFrame(sites, events, { binWidth: 5 });
    const { config } = assembleRunConfig(frame, {
      species: "Prueba",
      stream: "camera",
      siteCovariates: [{ name: "forest", kind: "continuous", values: forest }],
      gridCovariates: [
        { name: "forest", kind: "continuous", values: Array.from({ length: 50 }, (_, k) => k / 50) },
      ],
    });

    const res = await runOccupancyModel(config);
    if (!res.success) console.error("occupancy R error:", res.error);
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.version.unmarked).toMatch(/^\d+\./);
    expect(res.result.nSites).toBe(25);
    expect(res.result.nOccasions).toBe(6);
    expect(res.result.effects.some((e) => e.param.includes("forest"))).toBe(true);
    expect(res.result.prediction?.psi.length).toBe(50);
    expect(res.result.prediction?.se.length).toBe(50);
    for (const v of res.result.prediction!.psi) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }

    // Grid predictions carry a 95% CI.
    expect(res.result.prediction?.lower.length).toBe(50);
    expect(res.result.prediction?.upper.length).toBe(50);

    // Headline occupancy CI is emitted and brackets the point estimate.
    const { estimatedOccupancy, occupancyLower, occupancyUpper } = res.result;
    expect(occupancyLower).not.toBeNull();
    expect(occupancyUpper).not.toBeNull();
    expect(occupancyLower!).toBeLessThanOrEqual(estimatedOccupancy!);
    expect(estimatedOccupancy!).toBeLessThanOrEqual(occupancyUpper!);

    // Response curve for forest is predicted with CIs, in RAW x units (0..1).
    const forestCurve = res.result.curves?.forest;
    expect(forestCurve && forestCurve.length).toBeGreaterThan(1);
    for (const p of forestCurve!) {
      expect(p.x).toBeGreaterThanOrEqual(-0.01);
      expect(p.x).toBeLessThanOrEqual(1.01);
      expect(p.lower).toBeLessThanOrEqual(p.psi);
      expect(p.psi).toBeLessThanOrEqual(p.upper);
    }
  }, 60_000);

  it("returns a failure result (never throws) on an unfittable frame", async () => {
    const { runOccupancyModel } = await import("@/lib/occupancy/runner");
    // One site, one occasion, no covariates → occu cannot fit.
    const res = await runOccupancyModel({
      species: "Bad",
      stream: "camera",
      binWidth: 5,
      y: [[0]],
      siteCovs: {},
      siteFactors: [],
      obsCovs: { effort: [["full"]] },
      obsFactors: ["effort"],
      psiFormula: "~1",
      detFormula: "~effort",
      grid: null,
    });
    expect(res.success).toBe(false);
  }, 60_000);
});
