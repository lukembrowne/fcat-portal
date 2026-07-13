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
    latitude REAL, longitude REAL, date_start TEXT, date_end TEXT, status TEXT,
    excluded INTEGER DEFAULT 0, field_notes TEXT,
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
  CREATE TABLE occupancy_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL DEFAULT 'pending', trigger TEXT DEFAULT 'manual',
    bin_width_days INTEGER, audio_confidence_threshold REAL, thresholds_json TEXT, n_models INTEGER DEFAULT 0,
    n_eligible INTEGER DEFAULT 0, duration_ms INTEGER, notes TEXT, created_by TEXT, started_at INTEGER,
    completed_at INTEGER, created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );
  CREATE TABLE occupancy_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL, species TEXT NOT NULL, stream TEXT NOT NULL,
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
