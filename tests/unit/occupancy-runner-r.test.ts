import { describe, it, expect, vi } from "vitest";
import { spawnSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import nodePath from "node:path";

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

/**
 * Drive the R worker-loop directly: spawn one Rscript, write each config as its
 * own line, close stdin, and collect every parsed NDJSON message. Exercises the
 * persistent-loop contract the pool (src/lib/occupancy/pool.ts) relies on — one
 * `ready`, then one result/error per config, all from a SINGLE process.
 */
function runLoop(
  configs: Record<string, unknown>[],
): Promise<{ messages: { type: string; id?: number | null; [k: string]: unknown }[]; code: number | null }> {
  return new Promise((resolve) => {
    const script = nodePath.join(process.cwd(), "scripts", "occupancy-runner.R");
    const proc = spawn("Rscript", [script], { stdio: ["pipe", "pipe", "pipe"] });
    const messages: { type: string; id?: number | null; [k: string]: unknown }[] = [];
    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      const t = line.trim();
      if (!t) return;
      try {
        messages.push(JSON.parse(t));
      } catch {
        /* ignore non-JSON noise */
      }
    });
    proc.on("close", (code) => resolve({ messages, code }));
    for (const c of configs) proc.stdin.write(JSON.stringify(c) + "\n");
    proc.stdin.end();
  });
}

/** A minimal, fittable single-covariate config (25 sites, forest gradient). */
async function fittableConfig(id: number): Promise<Record<string, unknown>> {
  const { buildDetectionFrame } = await import("@/lib/occupancy/detection-history");
  const { assembleRunConfig } = await import("@/lib/occupancy/config");
  const sites = Array.from({ length: 25 }, (_, i) => ({
    siteId: `S${i}`,
    siteName: `S${i}`,
    latitude: 0,
    longitude: 0,
    windowStart: utc(2026, 1, 1),
    windowEnd: utc(2026, 1, 30),
  }));
  const forest = sites.map((_, i) => i / 25);
  let seed = 7 + id;
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
    species: `Sp${id}`,
    stream: "camera",
    siteCovariates: [{ name: "forest", kind: "continuous", values: forest }],
  });
  return { ...config, id };
}

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

describe.skipIf(!rReady())("occupancy-runner.R worker loop", () => {
  it("loads unmarked once and fits many configs from a single process", async () => {
    const { messages, code } = await runLoop([
      await fittableConfig(1),
      await fittableConfig(2),
      await fittableConfig(3),
    ]);
    expect(code).toBe(0);
    // Exactly one ready line, carrying the unmarked version.
    const ready = messages.filter((m) => m.type === "ready");
    expect(ready.length).toBe(1);
    expect(String(ready[0].unmarked)).toMatch(/^\d+\./);
    // One result per config, ids echoed and correlated.
    const results = messages.filter((m) => m.type === "result");
    expect(results.length).toBe(3);
    expect(results.map((r) => r.id).sort()).toEqual([1, 2, 3]);
  }, 90_000);

  it("isolates a per-config fit failure — the worker survives and keeps fitting", async () => {
    // Bad config (id=1): one site, one occasion, no covariates → occu cannot fit.
    const bad = {
      id: 1,
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
    };
    const good = await fittableConfig(2);
    const { messages, code } = await runLoop([bad, good]);
    expect(code).toBe(0);
    // The bad config emits a tagged error; the worker did NOT exit — the next
    // config still returns a result.
    const err = messages.find((m) => m.type === "error");
    expect(err?.id).toBe(1);
    const ok = messages.find((m) => m.type === "result");
    expect(ok?.id).toBe(2);
  }, 90_000);

  it("does not emit a grid prediction when no grid is supplied", async () => {
    // fittableConfig passes no gridCovariates → cfg.grid is null → the expensive
    // per-cell-SE grid predict must NOT run (the gradient-only guard, verified at
    // the R layer). Habitat/null variants rely on this.
    const { messages } = await runLoop([await fittableConfig(1)]);
    const result = messages.find((m) => m.type === "result");
    expect(result).toBeDefined();
    expect(result!.prediction).toBeUndefined();
  }, 90_000);
});
