import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import nodePath from "node:path";

// server-only throws outside a Next server bundle; neutralize it (same pattern as
// occupancy-runner-r.test.ts). log is stubbed so pool diagnostics are inert.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

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

// A node stand-in for the R worker: emits `ready`, then behaves per STUB_MODE.
// Lets us exercise dispatch/timeout/crash/respawn deterministically without R.
const STUB_SRC = `
import fs from 'node:fs';
import readline from 'node:readline';
const mode = process.env.STUB_MODE || 'fakefit';
// crashstart: die before emitting ready — simulates a worker that can never boot
// (e.g. Rscript missing), which should trip the pool's respawn backstop.
if (mode === 'crashstart') process.exit(1);
process.stdout.write(JSON.stringify({ type: 'ready', unmarked: '9.9', R: '4.4' }) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  const cfg = JSON.parse(t);
  if (mode === 'hang') return;
  if (mode === 'crashjob') process.exit(1);
  if (mode === 'crashthenwork') {
    const f = process.env.STUB_COUNTER_FILE;
    let n = 0;
    try { n = parseInt(fs.readFileSync(f, 'utf8')) || 0; } catch {}
    n++;
    fs.writeFileSync(f, String(n));
    if (n === 1) process.exit(1);
  }
  process.stdout.write(JSON.stringify({
    type: 'result', id: cfg.id, species: cfg.species, stream: cfg.stream,
    nSites: 1, nOccasions: 1, convergence: 0, aic: 1, fitSeconds: 0,
    naiveOccupancy: 0, estimatedOccupancy: 0.5, occupancyLower: 0.1,
    occupancyUpper: 0.9, meanDetection: 0.5, effects: [],
  }) + '\\n');
});
`;

let tmpDir: string;
let stubPath: string;
const cfg = (species: string): import("@/lib/occupancy/runner").OccupancyRunConfig => ({
  species,
  stream: "camera",
  binWidth: 5,
  y: [[0]],
  siteCovs: {},
  siteFactors: [],
  obsCovs: {},
  obsFactors: [],
  psiFormula: "~1",
  detFormula: "~1",
  grid: null,
});

beforeAll(() => {
  tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "occ-pool-"));
  stubPath = nodePath.join(tmpDir, "pool-stub.mjs");
  fs.writeFileSync(stubPath, STUB_SRC);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.STUB_MODE;
  delete process.env.STUB_COUNTER_FILE;
  delete process.env.OCCUPANCY_WORKERS;
});

function stubSpawn() {
  return { command: "node", args: [stubPath] };
}

describe("occupancy pool — dispatch & correlation (node stub)", () => {
  it("fits more jobs than workers, reusing workers, with ids/species correlated", async () => {
    process.env.STUB_MODE = "fakefit";
    const { createOccupancyPool } = await import("@/lib/occupancy/pool");
    const pool = createOccupancyPool({ size: 3, spawn: stubSpawn() });
    const species = ["A", "B", "C", "D", "E", "F"];
    const results = await Promise.all(species.map((s) => pool.submit(cfg(s))));
    await pool.shutdown();

    expect(results.every((r) => r.success)).toBe(true);
    const got = results.map((r) => (r.success ? r.result.species : null)).sort();
    expect(got).toEqual(species.slice().sort());
  }, 30_000);

  it("resolves a failure (never throws) when a model times out, and respawns", async () => {
    process.env.STUB_MODE = "hang";
    const { createOccupancyPool } = await import("@/lib/occupancy/pool");
    const pool = createOccupancyPool({ size: 1, timeoutMs: 300, spawn: stubSpawn() });
    const res = await pool.submit(cfg("Slow"));
    await pool.shutdown();
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error).toMatch(/died mid-fit|timed out|signal/i);
  }, 30_000);

  it("fails only the in-flight model on a worker crash and keeps dispatching", async () => {
    process.env.STUB_MODE = "crashjob";
    const { createOccupancyPool } = await import("@/lib/occupancy/pool");
    const pool = createOccupancyPool({ size: 1, spawn: stubSpawn() });
    const first = await pool.submit(cfg("One"));
    // A second submit must still resolve (dispatched to the respawned worker,
    // which also crashes) rather than hang forever.
    const second = await pool.submit(cfg("Two"));
    await pool.shutdown();
    expect(first.success).toBe(false);
    expect(second.success).toBe(false);
  }, 30_000);

  it("respawn restores working capacity — a crash then a successful fit", async () => {
    process.env.STUB_MODE = "crashthenwork";
    process.env.STUB_COUNTER_FILE = nodePath.join(tmpDir, `counter-${Date.now()}.txt`);
    const { createOccupancyPool } = await import("@/lib/occupancy/pool");
    const pool = createOccupancyPool({ size: 1, spawn: stubSpawn() });
    const first = await pool.submit(cfg("Crash")); // counter=1 → crash
    const second = await pool.submit(cfg("Works")); // respawned worker, counter=2 → success
    await pool.shutdown();
    expect(first.success).toBe(false);
    expect(second.success).toBe(true);
    if (second.success) expect(second.result.species).toBe("Works");
  }, 30_000);

  it("fails fast once workers can't stay alive (respawn backstop)", async () => {
    process.env.STUB_MODE = "crashstart";
    const { createOccupancyPool } = await import("@/lib/occupancy/pool");
    const pool = createOccupancyPool({ size: 1, spawn: stubSpawn() });
    // The queued job resolves failure once the respawn limit trips...
    const first = await pool.submit(cfg("Doomed"));
    expect(first.success).toBe(false);
    // ...and a later submit fails fast (broken guard) rather than hanging.
    const second = await pool.submit(cfg("AlsoDoomed"));
    expect(second.success).toBe(false);
    if (!second.success) expect(second.error).toMatch(/unavailable|crashes/i);
    await pool.shutdown();
  }, 30_000);

  it("rejects submits after shutdown", async () => {
    process.env.STUB_MODE = "fakefit";
    const { createOccupancyPool } = await import("@/lib/occupancy/pool");
    const pool = createOccupancyPool({ size: 1, spawn: stubSpawn() });
    await pool.shutdown();
    const res = await pool.submit(cfg("Late"));
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error).toMatch(/shutting down/i);
  }, 30_000);
});

describe("resolvePoolSize", () => {
  it("honors OCCUPANCY_WORKERS, floors at 1, caps at core count", async () => {
    const { resolvePoolSize } = await import("@/lib/occupancy/pool");
    const cores = Math.max(1, os.availableParallelism());

    process.env.OCCUPANCY_WORKERS = "2";
    expect(resolvePoolSize()).toBe(Math.min(2, cores));

    process.env.OCCUPANCY_WORKERS = "0";
    expect(resolvePoolSize()).toBe(1); // floored

    process.env.OCCUPANCY_WORKERS = "9999";
    expect(resolvePoolSize()).toBe(cores); // capped

    process.env.OCCUPANCY_WORKERS = "garbage";
    expect(resolvePoolSize()).toBe(Math.min(4, cores)); // falls back to default 4
  });

  it("defaults to 4 (capped at cores) when OCCUPANCY_WORKERS is unset", async () => {
    const { resolvePoolSize } = await import("@/lib/occupancy/pool");
    const cores = Math.max(1, os.availableParallelism());
    expect(resolvePoolSize()).toBe(Math.min(4, cores));
  });
});

describe.skipIf(!rReady())("occupancy pool — real R workers", () => {
  it("fits several configs across a 2-worker pool", async () => {
    const { buildDetectionFrame } = await import("@/lib/occupancy/detection-history");
    const { assembleRunConfig } = await import("@/lib/occupancy/config");
    const { createOccupancyPool } = await import("@/lib/occupancy/pool");

    const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));
    function makeConfig(id: number) {
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
      return assembleRunConfig(frame, {
        species: `Sp${id}`,
        stream: "camera",
        siteCovariates: [{ name: "forest", kind: "continuous", values: forest }],
      }).config;
    }

    const pool = createOccupancyPool({ size: 2 });
    const results = await Promise.all([1, 2, 3].map((i) => pool.submit(makeConfig(i))));
    await pool.shutdown();

    expect(results.every((r) => r.success)).toBe(true);
    for (const r of results) {
      if (r.success) {
        expect(r.version.unmarked).toMatch(/^\d+\./);
        expect(r.result.nSites).toBe(25);
      }
    }
  }, 90_000);
});
