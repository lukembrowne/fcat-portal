import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "@/db/schema";
import { seedOccupancyDev } from "../../scripts/seed-occupancy-dev";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/log", () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
// Keep the run hermetic: the seeded sites carry habitat in field_notes, so the
// ODK habitat join must not reach out over the network here.
vi.mock("@/lib/habitat-lookup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/habitat-lookup")>()),
  loadSiteHabitatMap: vi.fn(async () => new Map<string, string>()),
}));

// Mock @/db to a per-test in-memory Drizzle instance (system-events.test.ts pattern).
const dbRef: { current: ReturnType<typeof drizzle> | null } = { current: null };
vi.mock("@/db", () => ({
  db: new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return undefined;
        const real = dbRef.current as unknown as Record<string | symbol, unknown>;
        const v = real[prop];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(real) : v;
      },
    },
  ),
}));

const DDL = `
  CREATE TABLE ct_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE
  );
  CREATE TABLE biochoco_deployments (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, ct_project_id INTEGER, name TEXT NOT NULL, site_name TEXT,
    latitude REAL, longitude REAL, date_start TEXT, date_end TEXT, valid_start TEXT, valid_end TEXT, status TEXT,
    excluded_audio INTEGER DEFAULT 0, excluded_camera INTEGER DEFAULT 0, field_notes TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()), updated_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE biochoco_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT, deployment_id INTEGER NOT NULL, filename TEXT NOT NULL,
    status TEXT, exif_timestamp TEXT, file_modified INTEGER
  );
  CREATE TABLE biochoco_detections (
    id INTEGER PRIMARY KEY AUTOINCREMENT, image_id INTEGER NOT NULL, bbox_x REAL, bbox_y REAL,
    bbox_width REAL, bbox_height REAL, detection_confidence REAL, detection_class INTEGER, model_version TEXT
  );
  CREATE TABLE biochoco_identifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT, detection_id INTEGER NOT NULL, species TEXT NOT NULL, confidence REAL,
    model_version TEXT, verification_status TEXT, corrected_species TEXT, verified_by TEXT, verified_at INTEGER
  );
  CREATE TABLE audio_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT, deployment_id INTEGER NOT NULL, filename TEXT NOT NULL, format TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE audio_detections (
    id INTEGER PRIMARY KEY AUTOINCREMENT, audio_file_id INTEGER NOT NULL, start_time REAL, end_time REAL,
    min_freq REAL, max_freq REAL, confidence REAL, model_version TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE audio_identifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT, audio_detection_id INTEGER NOT NULL, species TEXT NOT NULL, confidence REAL,
    model_version TEXT, verification_status TEXT, corrected_species TEXT
  );
  CREATE TABLE biochoco_processing_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, deployment_id INTEGER, job_type TEXT NOT NULL DEFAULT 'ml',
    status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE occupancy_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL DEFAULT 'pending', trigger TEXT DEFAULT 'manual',
    bin_width_days INTEGER, audio_confidence_threshold REAL, thresholds_json TEXT, n_models INTEGER DEFAULT 0,
    n_eligible INTEGER DEFAULT 0, duration_ms INTEGER, notes TEXT, created_by TEXT, started_at INTEGER,
    completed_at INTEGER, created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE occupancy_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, species TEXT NOT NULL, stream TEXT NOT NULL,
    variant TEXT NOT NULL DEFAULT 'combined',
    season TEXT, sufficient_data INTEGER NOT NULL DEFAULT 0, ineligible_reasons_json TEXT,
    n_sites INTEGER, n_sites_detected INTEGER, total_detections INTEGER, n_occasions INTEGER, naive_occupancy REAL,
    estimated_occupancy REAL, occupancy_lower REAL, occupancy_upper REAL, mean_detection REAL, aic REAL,
    convergence INTEGER, psi_formula TEXT, det_formula TEXT, fit_seconds REAL,
    dropped_covariates_json TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE occupancy_covariate_effects (
    id INTEGER PRIMARY KEY AUTOINCREMENT, model_id INTEGER NOT NULL, submodel TEXT NOT NULL, param TEXT NOT NULL,
    estimate REAL NOT NULL, se REAL, z REAL, p_value REAL
  );
  CREATE TABLE occupancy_site_covariates (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, stream TEXT NOT NULL, site_id TEXT NOT NULL,
    site_name TEXT, latitude REAL, longitude REAL, habitat TEXT, elevation REAL, forest_cover REAL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
`;

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

describe.skipIf(!rReady())("runOccupancyBuild (integration, real R)", () => {
  let sqlite: Database.Database;
  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.exec(DDL);
    seedOccupancyDev(sqlite, { nSites: 30, seed: 7, covariates: "synthetic" });
    dbRef.current = drizzle(sqlite, { schema });
  });

  it("fits eligible species, persists models + effects, records a completed run", async () => {
    const { runOccupancyBuild } = await import("@/lib/occupancy/build-run");
    const res = await runOccupancyBuild({ trigger: "manual", createdBy: "test@fcat" });

    expect(res.nModels).toBeGreaterThan(0);
    expect(res.nEligible).toBeGreaterThan(0);

    const run = sqlite.prepare("SELECT * FROM occupancy_runs WHERE id = ?").get(res.runId) as Record<string, unknown>;
    expect(run.status).toBe("completed");
    expect(run.n_eligible).toBe(res.nEligible);

    const fitted = sqlite
      .prepare("SELECT * FROM occupancy_models WHERE run_id = ? AND sufficient_data = 1")
      .all(res.runId) as Record<string, unknown>[];
    expect(fitted.length).toBeGreaterThan(0);
    // At least one converged with an occupancy estimate in [0,1].
    const converged = fitted.filter((m) => m.convergence === 0 && m.estimated_occupancy != null);
    expect(converged.length).toBeGreaterThan(0);
    for (const m of converged) {
      expect(m.estimated_occupancy as number).toBeGreaterThanOrEqual(0);
      expect(m.estimated_occupancy as number).toBeLessThanOrEqual(1);
    }

    // Effects were persisted and split into state/det submodels.
    const effects = sqlite
      .prepare(
        `SELECT DISTINCT submodel FROM occupancy_covariate_effects e
         JOIN occupancy_models m ON m.id = e.model_id WHERE m.run_id = ?`,
      )
      .all(res.runId) as { submodel: string }[];
    const submodels = effects.map((e) => e.submodel);
    expect(submodels).toContain("state");

    // Every fitted (sufficient_data=1) model is a real variant — never the
    // legacy 'combined'. Eligible species produce a gradient model + a ψ~1 null
    // baseline (habitat too when a usable factor exists).
    const fittedVariants = new Set(fitted.map((m) => m.variant as string));
    expect(fittedVariants.has("gradient")).toBe(true);
    expect(fittedVariants.has("null")).toBe(true);
    expect(fittedVariants.has("combined")).toBe(false);
    for (const m of fitted) {
      expect(["gradient", "habitat", "null"]).toContain(m.variant as string);
    }
    // The gradient variant carries forest/elevation state params; a habitat
    // variant (when present) carries habitat* params.
    const gradientParams = sqlite
      .prepare(
        `SELECT DISTINCT e.param FROM occupancy_covariate_effects e
         JOIN occupancy_models m ON m.id = e.model_id
         WHERE m.run_id = ? AND m.variant = 'gradient' AND e.submodel = 'state'`,
      )
      .all(res.runId) as { param: string }[];
    // gradient has at least an intercept; forest/elevation appear when they varied.
    expect(gradientParams.length).toBeGreaterThan(0);
    // The ψ~1 null baseline persists a state intercept and a "~1" ψ formula.
    const nullRows = sqlite
      .prepare(
        `SELECT psi_formula FROM occupancy_models WHERE run_id = ? AND variant = 'null' AND sufficient_data = 1`,
      )
      .all(res.runId) as { psi_formula: string }[];
    expect(nullRows.length).toBeGreaterThan(0);
    for (const r of nullRows) expect(r.psi_formula).toBe("~1");

    // Continuous effort: the detection block is a single numeric `effort` slope,
    // never the old per-level dummies (effort2d/effort4d/effortfull) that caused
    // separation. Where an effort term exists, it is exactly "effort".
    const detParams = sqlite
      .prepare(
        `SELECT DISTINCT e.param FROM occupancy_covariate_effects e
         JOIN occupancy_models m ON m.id = e.model_id
         WHERE m.run_id = ? AND e.submodel = 'det'`,
      )
      .all(res.runId) as { param: string }[];
    const effortParams = detParams.map((d) => d.param).filter((p) => p.startsWith("effort"));
    for (const p of effortParams) expect(p).toBe("effort"); // no bucketed levels

    // Site-covariate snapshot persisted for both streams.
    const snap = sqlite
      .prepare("SELECT DISTINCT stream FROM occupancy_site_covariates WHERE run_id = ?")
      .all(res.runId) as { stream: string }[];
    expect(snap.map((s) => s.stream).sort()).toEqual(["audio", "camera"]);
  }, 120_000);

  it("persists ineligible species with sufficient_data = 0 and reasons", async () => {
    const { runOccupancyBuild } = await import("@/lib/occupancy/build-run");
    // Tiny site pool → most species ineligible.
    sqlite.exec("DELETE FROM biochoco_deployments WHERE id > 3");
    const res = await runOccupancyBuild({});
    const ineligible = sqlite
      .prepare("SELECT * FROM occupancy_models WHERE run_id = ? AND sufficient_data = 0")
      .all(res.runId) as Record<string, unknown>[];
    expect(ineligible.length).toBeGreaterThan(0);
    expect(ineligible[0].ineligible_reasons_json).toBeTruthy();
    expect(ineligible[0].estimated_occupancy).toBeNull();
  }, 120_000);

  // Canonical projection of a run's models — everything that must be identical
  // regardless of HOW the fits were dispatched (fit_seconds excluded: it is
  // wall-clock and varies run to run).
  const projectModels = (runId: number) =>
    (
      sqlite
        .prepare(
          `SELECT species, stream, variant, sufficient_data, psi_formula, det_formula,
                  n_sites, n_sites_detected, total_detections, n_occasions,
                  ROUND(estimated_occupancy, 6) AS psi, ROUND(aic, 4) AS aic, convergence
           FROM occupancy_models WHERE run_id = ?
           ORDER BY species, stream, variant`,
        )
        .all(runId) as Record<string, unknown>[]
    );

  it("R3: warm-pool and serial paths produce an identical model row set", async () => {
    const { runOccupancyBuild } = await import("@/lib/occupancy/build-run");
    const saved = process.env.OCCUPANCY_WARM_POOL;
    try {
      // Warm pool (default).
      delete process.env.OCCUPANCY_WARM_POOL;
      const poolRun = await runOccupancyBuild({ createdBy: "pool@test" });
      const poolRows = projectModels(poolRun.runId);

      // Serial spawn-per-model fallback, same seeded inputs.
      process.env.OCCUPANCY_WARM_POOL = "false";
      const serialRun = await runOccupancyBuild({ createdBy: "serial@test" });
      const serialRows = projectModels(serialRun.runId);

      expect(poolRows.length).toBeGreaterThan(0);
      expect(poolRows).toEqual(serialRows);
      // Same total model count both ways.
      expect(poolRun.nModels).toBe(serialRun.nModels);
      expect(poolRun.nEligible).toBe(serialRun.nEligible);
    } finally {
      if (saved === undefined) delete process.env.OCCUPANCY_WARM_POOL;
      else process.env.OCCUPANCY_WARM_POOL = saved;
    }
  }, 180_000);

  it("R7: progress advances monotonically and ends at the total fit count", async () => {
    const { runOccupancyBuild } = await import("@/lib/occupancy/build-run");
    const ticks: { done: number; total: number }[] = [];
    const res = await runOccupancyBuild({
      onProgress: (done, total) => ticks.push({ done, total }),
    });

    // Monotonic non-decreasing `done` across the whole run (prep ticks report 0).
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i].done).toBeGreaterThanOrEqual(ticks[i - 1].done);
    }
    // The fit phase's denominator = number of R fits = every non-'combined' model
    // (each eligible variant is fitted exactly once).
    const totalFits = (
      sqlite
        .prepare("SELECT COUNT(*) AS n FROM occupancy_models WHERE run_id = ? AND variant != 'combined'")
        .get(res.runId) as { n: number }
    ).n;
    const fitTicks = ticks.filter((t) => t.total === totalFits);
    expect(fitTicks.length).toBeGreaterThan(0);
    expect(Math.max(...fitTicks.map((t) => t.done))).toBe(totalFits);
  }, 120_000);
});

describe("assertGradientOnlyGrid (U4 grid-prediction guard)", () => {
  it("allows a grid only for the gradient variant", async () => {
    const { assertGradientOnlyGrid } = await import("@/lib/occupancy/build-run");
    expect(() => assertGradientOnlyGrid("gradient", true)).not.toThrow();
    expect(() => assertGradientOnlyGrid("gradient", false)).not.toThrow();
    // Non-gradient variants with NO grid are the normal case — fine.
    expect(() => assertGradientOnlyGrid("habitat", false)).not.toThrow();
    expect(() => assertGradientOnlyGrid("null", false)).not.toThrow();
  });

  it("throws if a grid is attached to habitat or null (regression tripwire)", async () => {
    const { assertGradientOnlyGrid } = await import("@/lib/occupancy/build-run");
    expect(() => assertGradientOnlyGrid("habitat", true)).toThrow(/non-gradient variant "habitat"/);
    expect(() => assertGradientOnlyGrid("null", true)).toThrow(/non-gradient variant "null"/);
  });
});

describe("checkCovariateInfrastructure", () => {
  const KEYS = ["OCCUPANCY_FOREST_RASTER", "OCCUPANCY_DEM_RASTER", "OCCUPANCY_AOI_KML"] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("throws when the raster env vars are unset", async () => {
    const { checkCovariateInfrastructure, OccupancyInfrastructureError } = await import(
      "@/lib/occupancy/build-run"
    );
    for (const k of KEYS) delete process.env[k];
    expect(() => checkCovariateInfrastructure()).toThrow(OccupancyInfrastructureError);
  });

  it("throws when a var is set but the file is missing (fail-closed)", async () => {
    const { checkCovariateInfrastructure } = await import("@/lib/occupancy/build-run");
    for (const k of KEYS) process.env[k] = "data/occupancy-rasters/does-not-exist.tif";
    expect(() => checkCovariateInfrastructure()).toThrow(/no encontrado|no están disponibles/);
  });

  it("passes when all three point to existing files", async () => {
    const { checkCovariateInfrastructure } = await import("@/lib/occupancy/build-run");
    // package.json exists at cwd — reuse it as a stand-in for the raster files.
    for (const k of KEYS) process.env[k] = "package.json";
    expect(() => checkCovariateInfrastructure()).not.toThrow();
  });
});
