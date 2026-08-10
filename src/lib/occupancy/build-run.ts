import "server-only";
import fs from "node:fs";
import nodePath from "node:path";
import type BetterSqlite3 from "better-sqlite3";
import { db } from "@/db";
import { log } from "@/lib/log";
import { fetchOccupancyInputs } from "./fetch";
import { buildDetectionFrame } from "./detection-history";
import {
  assessEligibility,
  DEFAULT_THRESHOLDS,
  type EligibilityThresholds,
} from "./eligibility";
import {
  resolveSiteCovariates,
  toCovariateSpecs,
  persistSiteCovariateSnapshot,
  type SiteCovariateInput,
} from "./covariates";
import { getSyntheticSiteIds, cohortSitesFor } from "./cohort";
import { assembleRunConfig, type GridCovariateSpec } from "./config";
import {
  runOccupancyModel,
  type OccupancyRunConfig,
  type OccupancyRunResult,
  type OccupancyPrediction,
  type OccupancyCurvePoint,
  type OccupancyHabitatBar,
} from "./runner";
import { createOccupancyPool, registerPoolForShutdown } from "./pool";
import { runForestCover, type RasterGridCell } from "./raster";
import { renderRasterSurfaces, paddedBbox, type RasterModelSpec } from "./surface";
import { classifyModelIdentifiability } from "./separation";
import type { CovariateResolvers } from "./covariates";
import { DEFAULT_BIN_WIDTH_DAYS } from "./occasions";
import { DEFAULT_CONFIDENCE_THRESHOLD } from "@/lib/audio-confidence";
import type { OccupancyStream } from "./readiness";
import {
  loadSiteHabitatMap,
  resolveHabitatForDeployment,
  UNKNOWN_HABITAT_KEY,
} from "@/lib/habitat-lookup";
import { getHabitatName } from "@/app/biochoco/overview/types";
import { loadActiveSpeciesThresholds } from "@/lib/birdnet-validation/threshold-map";

/**
 * Orchestrates one occupancy run: for each stream and each eligible species,
 * builds the detection frame, attaches covariates, fits via the R runner, and
 * persists models + covariate effects + the site-covariate snapshot. Ineligible
 * species are persisted with `sufficient_data = 0` + Spanish reasons so the page
 * stays consistent with the readiness report. See
 * docs/plans/2026-07-06-001-feat-occupancy-modeling-pipeline-plan.md (U5).
 */

const STREAMS: OccupancyStream[] = ["camera", "audio"];

export interface BuildRunOptions {
  binWidth?: number;
  confidenceThreshold?: number;
  thresholds?: EligibilityThresholds;
  trigger?: "cron" | "manual";
  createdBy?: string | null;
  /** Progress callback: (speciesDone, speciesTotal, label). */
  onProgress?: (done: number, total: number, label: string) => void;
}

export interface BuildRunResult {
  runId: number;
  nModels: number;
  nEligible: number;
  durationMs: number;
}

/**
 * One model to fit: the R config plus a `persist` closure that records the result
 * (row + effects + artifacts) once it comes back. Collected in Phase A, fitted in
 * Phase B via the warm worker pool (or the serial fallback). `persist` closes over
 * the run-scoped prepared statements and the shared render/prediction accumulators.
 */
interface FitJob {
  config: OccupancyRunConfig;
  /** Progress-toast label, e.g. "Cámaras · Panthera onca". */
  label: string;
  persist: (res: OccupancyRunResult) => void;
}

/**
 * Grid-prediction guard (U4): ONLY the `gradient` variant may carry an AOI
 * prediction grid into R. A grid triggers the expensive per-cell-SE `predict()`
 * over the full AOI (~4,732 cells) — running it for `habitat` or `null` would be
 * ~3× the grid cost per species for surfaces those variants never render. The
 * caller already gates grid construction on `variant === "gradient"`; this is the
 * tripwire that makes a future regression fail loudly instead of silently
 * tripling the grid cost. Exported for direct testing.
 */
export function assertGradientOnlyGrid(
  variant: "gradient" | "habitat" | "null",
  hasGrid: boolean,
): void {
  if (variant !== "gradient" && hasGrid) {
    throw new Error(
      `occupancy: grid prediction attached to non-gradient variant "${variant}" — ` +
        `only the gradient variant may render an AOI ψ surface`,
    );
  }
}

function rawClient(): BetterSqlite3.Database {
  return (db as unknown as { $client: BetterSqlite3.Database }).$client;
}

/** Split an R coefficient name like `psi(forest)` / `p(effort)` into submodel + param. */
function splitEffect(param: string): { submodel: "state" | "det"; name: string } {
  if (param.startsWith("psi(")) return { submodel: "state", name: param.slice(4, -1) };
  if (param.startsWith("p(")) return { submodel: "det", name: param.slice(2, -1) };
  return { submodel: "state", name: param };
}

/** Thrown when a run over real sites lacks its raster/DEM/AOI infrastructure. */
export class OccupancyInfrastructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OccupancyInfrastructureError";
  }
}

/**
 * Precondition for a run that models real (non-synthetic) sites: the forest +
 * DEM rasters and the AOI polygon must be configured AND present on disk.
 * Without them the pipeline would silently fit intercept-only (ψ~1) models with
 * no map surface — so we fail the whole run with a clear Spanish message instead.
 * The dev/seed path (synthetic OCC-SEED sites carrying field_notes covariates)
 * needs no rasters and is exempt (the caller only invokes this when real sites
 * are present).
 */
export function checkCovariateInfrastructure(): void {
  const checks: { env: string; label: string }[] = [
    { env: "OCCUPANCY_FOREST_RASTER", label: "la capa de cobertura boscosa" },
    { env: "OCCUPANCY_DEM_RASTER", label: "el modelo de elevación (DEM)" },
    { env: "OCCUPANCY_AOI_KML", label: "el área de estudio (AOI, KML)" },
  ];
  const missing: string[] = [];
  for (const c of checks) {
    const p = process.env[c.env];
    if (!p) {
      missing.push(`${c.label} (${c.env} sin configurar)`);
    } else {
      const abs = nodePath.isAbsolute(p) ? p : nodePath.join(process.cwd(), p);
      if (!fs.existsSync(abs)) missing.push(`${c.label} (archivo no encontrado: ${p})`);
    }
  }
  if (missing.length > 0) {
    throw new OccupancyInfrastructureError(
      `Los modelos de ocupación requieren capas ráster que no están disponibles: ` +
        `${missing.join("; ")}. Coloque los archivos en data/occupancy-rasters/ y configure ` +
        `OCCUPANCY_FOREST_RASTER, OCCUPANCY_DEM_RASTER y OCCUPANCY_AOI_KML en el entorno de producción.`,
    );
  }
}

export async function runOccupancyBuild(opts: BuildRunOptions = {}): Promise<BuildRunResult> {
  const binWidth = opts.binWidth ?? DEFAULT_BIN_WIDTH_DAYS;
  const confidenceThreshold = opts.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;
  const raw = rawClient();
  const startedAtSec = Math.floor(nowMs() / 1000);

  // Fetch inputs + precount species up front. Doing this before the run row is
  // created lets the infrastructure guard fail cleanly with no orphaned
  // 'running' row.
  // Loaded once, outside the synchronous map below. Recorded on the run row so
  // a fitted model's inputs stay reconstructible after a threshold changes.
  const speciesThresholds = await loadActiveSpeciesThresholds();

  const perStream = STREAMS.map((stream) => {
    const inputs = fetchOccupancyInputs(stream, {
      confidenceThreshold,
      speciesThresholds,
    });
    const species = new Set(inputs.detections.map((d) => d.species));
    return { stream, inputs, species: [...species] };
  });

  // A run that models real (non-synthetic) sites requires the raster/DEM/AOI
  // infrastructure; without it we fail loudly rather than fit ψ~1 null models.
  // Purely-synthetic dev/seed runs are exempt.
  const hasRealSites = perStream.some((s) => {
    const synth = getSyntheticSiteIds(s.inputs);
    return s.inputs.sites.some((site) => !synth.has(site.siteId));
  });
  if (hasRealSites) checkCovariateInfrastructure();

  const runId = Number(
    raw
      .prepare(
        `INSERT INTO occupancy_runs
           (status, trigger, bin_width_days, audio_confidence_threshold, thresholds_json,
            species_thresholds_json, created_by, started_at)
         VALUES ('running', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        opts.trigger ?? "manual",
        binWidth,
        confidenceThreshold,
        JSON.stringify(thresholds),
        // null rather than "{}" when nothing is applied, so a run predating any
        // validation is distinguishable from one where every threshold was reverted.
        speciesThresholds.size > 0
          ? JSON.stringify(Object.fromEntries(speciesThresholds))
          : null,
        opts.createdBy ?? null,
        startedAtSec,
      ).lastInsertRowid,
  );

  const insModel = raw.prepare(
    `INSERT INTO occupancy_models
       (run_id, species, stream, variant, sufficient_data, ineligible_reasons_json,
        n_sites, n_sites_detected, total_detections, n_occasions, naive_occupancy,
        estimated_occupancy, occupancy_lower, occupancy_upper, mean_detection, aic,
        convergence, psi_formula, det_formula, fit_seconds, dropped_covariates_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insEffect = raw.prepare(
    `INSERT INTO occupancy_covariate_effects (model_id, submodel, param, estimate, se, z, p_value)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  let nModels = 0;
  let nEligible = 0;

  // Species total for the prep-phase progress messages (perStream computed above,
  // before the run row). The fit phase (Phase B) switches the denominator to the
  // total number of R fits once eligibility is known.
  const totalSpecies = perStream.reduce((a, s) => a + s.species.length, 0);
  // Publish a total up front so the progress toast shows "0 de N" immediately
  // rather than "0 de 0" while covariates/rasters are prepared.
  opts.onProgress?.(0, totalSpecies, "Preparando covariables…");

  // Raster covariates (forest cover + elevation) + AOI prediction grid for
  // real sites. Env-gated: on the seed/dev path (no raster configured), sites
  // carry covariates in field_notes and no map surface is produced.
  const unionSites = new Map<string, { siteId: string; lat: number; lng: number }>();
  for (const s of perStream) {
    for (const site of s.inputs.sites) {
      if (site.latitude != null && site.longitude != null && !unionSites.has(site.siteId)) {
        unionSites.set(site.siteId, { siteId: site.siteId, lat: site.latitude, lng: site.longitude });
      }
    }
  }
  // The prep phase (native raster reads + ODK habitat fetch) can dominate the
  // wall time while the species counter is still 0, so surface each step as its
  // own status message — otherwise the toast looks stalled at "0 de N".
  opts.onProgress?.(0, totalSpecies, "Cargando covariables ráster (bosque + elevación)…");
  const raster = await loadRasterCovariates([...unionSites.values()]);

  // Per-model ψ-surface render specs + pending prediction rows, collected during
  // the fit loop and flushed in ONE high-resolution raster render after it (see
  // renderRasterSurfaces) so the native forest/DEM read happens once per run.
  const renderModels: RasterModelSpec[] = [];
  const pendingPreds: PendingPrediction[] = [];

  // Habitat type per site, joined from the ODK BioChoco site entities (the same
  // source the cronograma / "Por hábitat" dashboard reads). Resolves each
  // deployment (via site name → "SITE_V1" site-code fallback) to its habitat
  // code, then to the readable Spanish label used as the model's factor level.
  // Unknown sites are left null so an incomplete habitat covariate is dropped
  // rather than mixing an "unknown" level into the fit (see toCovariateSpecs).
  const habitatBySiteId = new Map<string, string>();
  opts.onProgress?.(0, totalSpecies, "Resolviendo tipo de hábitat por sitio…");
  const habitatMap = await loadSiteHabitatMap();
  if (habitatMap.size > 0) {
    for (const s of perStream) {
      for (const [siteId, ci] of s.inputs.covariateInputs) {
        if (habitatBySiteId.has(siteId)) continue;
        const code = resolveHabitatForDeployment(
          { siteName: ci.siteName, deploymentName: ci.deploymentName },
          habitatMap,
        );
        if (code !== UNKNOWN_HABITAT_KEY) habitatBySiteId.set(siteId, getHabitatName(code));
      }
    }
  }

  const resolvers: CovariateResolvers = {
    ...(raster
      ? {
          forestCover: (id: string) => raster.forest.get(id),
          elevation: (id: string) => raster.elevation.get(id),
        }
      : {}),
    habitat: (id: string) => habitatBySiteId.get(id),
  };

  // Build a fit JOB for ONE ψ variant: the R config plus a `persist` closure that
  // records the result once it comes back. Splitting fit-from-persist lets the fit
  // phase run through a warm worker pool (concurrent, out of order) while every
  // persist still runs serially on the single-threaded event loop — so the DB
  // writes (synchronous better-sqlite3) never race and result order is irrelevant.
  // `gradient` writes the ψ map surface + response curves; `habitat` writes the
  // habitat-use bars (no map); `null` (ψ~1) is the intercept-only AIC baseline and
  // writes no artifacts. GRID PREDICTION is attached ONLY for gradient (guarded
  // below) — habitat/null never carry a grid into R.
  const buildFitJob = (
    variant: "gradient" | "habitat" | "null",
    frame: ReturnType<typeof buildDetectionFrame>,
    sp: string,
    stream: "camera" | "audio",
    siteCovariates: ReturnType<typeof toCovariateSpecs>["covariates"],
    variantDropped: { name: string; reason: string }[],
  ): FitJob => {
    const gridSpecs =
      variant === "gradient" && raster ? buildGridCovariates(raster.grid, siteCovariates) : undefined;
    // Fail loudly if a future change ever attaches a grid to a non-gradient variant.
    assertGradientOnlyGrid(variant, gridSpecs !== undefined);
    const { config, standardizations, dropped: cfgDropped } = assembleRunConfig(frame, {
      species: sp,
      stream,
      siteCovariates,
      gridCovariates: gridSpecs,
      binWidth,
    });
    const allDropped = [...variantDropped, ...cfgDropped];
    const droppedJson = allDropped.length ? JSON.stringify(allDropped) : null;
    const streamLabel = stream === "camera" ? "Cámaras" : "Audio";

  const persist = (res: OccupancyRunResult): void => {
    if (!res.success) {
      log.warn({ species: sp, stream, variant, error: res.error }, "occupancy_fit_failed");
      insModel.run(
        runId, sp, stream, variant, 1, JSON.stringify([`No convergió: ${res.error}`]),
        frame.nSitesSurveyed, frame.nSitesDetected, frame.totalDetections,
        frame.maxOccasions, frame.naiveOccupancy,
        null, null, null, null, null, null, config.psiFormula, config.detFormula, null, droppedJson,
      );
      nModels++;
      return;
    }

    const r = res.result;

    // Post-fit degeneracy guard: a numerically-"converged" fit whose entire ψ
    // submodel separated carries no information. Store it as insufficient (with a
    // Spanish reason) — keeping the diagnostic fields (n_sites, detections, aic,
    // formula) so the page can explain what was attempted — rather than a
    // confident estimate. Excluded from the cross-species synthesis in U4.
    const stateCoeffs = r.effects
      .map((e) => ({ split: splitEffect(e.param), estimate: e.estimate, se: e.se }))
      .filter((e) => e.split.submodel === "state")
      .map((e) => ({ name: e.split.name, estimate: e.estimate, se: e.se }));
    const identifiability = classifyModelIdentifiability(stateCoeffs);
    if (!identifiability.identifiable) {
      log.warn({ species: sp, stream, variant, reason: identifiability.reason }, "occupancy_model_degenerate");
      insModel.run(
        runId, sp, stream, variant, 0, JSON.stringify([identifiability.reason]),
        r.nSites, frame.nSitesDetected, frame.totalDetections,
        r.nOccasions, r.naiveOccupancy,
        null, null, null, null, r.aic,
        r.convergence, config.psiFormula, config.detFormula, r.fitSeconds, droppedJson,
      );
      nModels++;
      return;
    }

    const modelId = Number(
      insModel.run(
        runId, sp, stream, variant, 1, null,
        r.nSites, frame.nSitesDetected, frame.totalDetections,
        r.nOccasions, r.naiveOccupancy,
        r.estimatedOccupancy, r.occupancyLower, r.occupancyUpper, r.meanDetection, r.aic,
        r.convergence, config.psiFormula, config.detFormula, r.fitSeconds, droppedJson,
      ).lastInsertRowid,
    );
    for (const e of r.effects) {
      const { submodel, name } = splitEffect(e.param);
      insEffect.run(modelId, submodel, name, e.estimate, e.se, e.z, e.p);
    }

    if (variant === "gradient") {
      // Full-grid ψ surface + response curves (raster path only). The habitat
      // factor never enters the gradient model, so no habitat-use bars here.
      if (raster && r.prediction && gridSpecs) {
        const written = writeGridArtifact(
          runId, sp, stream, "gradient", raster.grid, r.prediction, r.curves, undefined,
        );
        pendingPreds.push({ modelId, ...written });
        const coef = stateCoefficients(r.effects);
        renderModels.push({
          name: written.slug,
          out: `${written.slug}.png`,
          b0: coef.b0,
          bForest: coef.forest,
          bElev: coef.elevation,
          forestMean: standardizations.forest?.mean,
          forestSd: standardizations.forest?.sd,
          elevMean: standardizations.elevation?.mean,
          elevSd: standardizations.elevation?.sd,
        });
      }
    } else if (variant === "habitat") {
      // habitat: persist the habitat-use bars in a cells-empty artifact (no ψ
      // surface). Raster-gated to match where the species page shows artifacts.
      if (raster && r.habitatUse && r.habitatUse.length > 0) {
        const written = writeGridArtifact(
          runId, sp, stream, "habitat", [], null, undefined, r.habitatUse,
        );
        pendingPreds.push({ modelId, ...written });
      }
    }
    // 'null' (ψ~1): no covariates → no map, curves, or bars; the row + AIC is all.
    nModels++;
    };

    return { config, label: `${streamLabel} · ${sp}`, persist };
  };

  // --- Phase A: cheap per-stream/species setup → collect the fit jobs ---------
  // Snapshot covariates, gate on eligibility (ineligible species get one cheap
  // 'combined' row with no R fit), and materialize the gradient/habitat/null fit
  // jobs. No R is spawned here; this just enumerates the work.
  const allJobs: FitJob[] = [];
  for (const { stream, inputs, species } of perStream) {
    // Snapshot covariates for the whole site pool once per stream.
    const poolInputs: SiteCovariateInput[] = inputs.sites.map(
      (s) => inputs.covariateInputs.get(s.siteId)!,
    );
    const poolRaw = resolveSiteCovariates(poolInputs, resolvers);
    persistSiteCovariateSnapshot(raw, runId, stream, poolRaw);
    const covBySite = new Map(poolRaw.map((r) => [r.siteId, r]));

    const bySpecies = new Map<string, typeof inputs.detections>();
    for (const d of inputs.detections) {
      const arr = bySpecies.get(d.species);
      if (arr) arr.push(d);
      else bySpecies.set(d.species, [d]);
    }

    // Survey-cohort isolation (see ./cohort): the dev seeder's synthetic
    // OCC-SEED sites are an unrelated survey, so a species is fit only over the
    // cohort where it was detected. No-op in production (no synthetic sites).
    const synthetic = getSyntheticSiteIds(inputs);

    for (const sp of species) {
      const events = bySpecies.get(sp) ?? [];
      const frame = buildDetectionFrame(cohortSitesFor(inputs.sites, events, synthetic), events, {
        binWidth,
      });
      const elig = assessEligibility(frame, thresholds);

      if (!elig.eligible) {
        // A species below the data-readiness gate never reaches the fit stage,
        // so it gets ONE legacy 'combined' row (not a gradient/habitat pair).
        insModel.run(
          runId, sp, stream, "combined", 0, JSON.stringify(elig.reasons),
          elig.stats.nSitesSurveyed, elig.stats.nSitesDetected, elig.stats.totalDetections,
          elig.stats.maxOccasions, elig.stats.naiveOccupancy,
          null, null, null, null, null, null, null, null, null, null,
        );
        nModels++;
        continue;
      }

      // Covariates aligned to frame site order. Capture the covariates dropped
      // at BOTH gates (absent-for-some-sites in toCovariateSpecs, and
      // no-variation / <2-levels in assembleRunConfig) so a reduced model is
      // visibly reduced instead of silently fitting ψ~1.
      const specRaw = frame.siteIds.map((id) => covBySite.get(id)!);
      const { covariates: covSpecs, dropped: specDropped } = toCovariateSpecs(specRaw);

      // Split the one ψ model into variants that each answer a question they can
      // actually identify: `gradient` (continuous forest+elevation → map surface +
      // response curves), `habitat` (categorical factor → habitat-use bars), and a
      // `null` (ψ~1) baseline. All share the detection frame + continuous
      // `p~effort` model, so their AICs compare like-for-like.
      const gradientSpecs = covSpecs.filter((c) => c.kind === "continuous");
      const habitatSpecs = covSpecs.filter((c) => c.kind === "factor");
      const gradientDroppedNames = new Set(["forest", "elevation"]);
      const gradientDropped = specDropped.filter((d) => gradientDroppedNames.has(d.name));
      const habitatDropped = specDropped.filter((d) => !gradientDroppedNames.has(d.name));

      // Always fit gradient (the mappable, baseline model — reduces to ψ~1 when no
      // continuous covariate is available). Fit habitat only when a usable factor
      // exists. Always fit the ψ~1 null as the AIC baseline the others compare to.
      allJobs.push(buildFitJob("gradient", frame, sp, stream, gradientSpecs, gradientDropped));
      if (habitatSpecs.length > 0) {
        allJobs.push(buildFitJob("habitat", frame, sp, stream, habitatSpecs, habitatDropped));
      }
      allJobs.push(buildFitJob("null", frame, sp, stream, [], []));
      nEligible++;
    }
  }

  // --- Phase B: fit every job -------------------------------------------------
  // Warm pool (default): submit all jobs to N persistent R workers and persist
  // each result as it resolves — concurrent fits, serial persists, order-
  // independent. Fallback (OCCUPANCY_WARM_POOL=false): the legacy spawn-one-
  // Rscript-per-model serial path, kept as a no-redeploy revert lever.
  const totalFits = allJobs.length;
  let completed = 0;
  const tick = (label: string): void => {
    completed++;
    opts.onProgress?.(completed, totalFits, label);
  };
  opts.onProgress?.(0, totalFits, "Ajustando modelos…");

  const useWarmPool = process.env.OCCUPANCY_WARM_POOL !== "false";
  if (totalFits === 0) {
    // No eligible species — nothing to fit.
  } else if (useWarmPool) {
    const pool = createOccupancyPool();
    registerPoolForShutdown(pool);
    try {
      // pool.submit resolves (never rejects) with a result; persist handles the
      // failure branch. Every .then callback runs serially on the event loop.
      await Promise.all(
        allJobs.map((job) =>
          pool.submit(job.config).then((res) => {
            job.persist(res);
            tick(job.label);
          }),
        ),
      );
    } finally {
      await pool.shutdown();
    }
  } else {
    for (const job of allJobs) {
      const res = await runOccupancyModel(job.config);
      job.persist(res);
      tick(job.label);
    }
  }

  // Flush all map surfaces in one high-resolution pass (native forest/DEM read
  // once): the crisp forest + elevation covariate layers and every per-model ψ
  // surface, then insert the prediction rows with the shared AOI bounds.
  await flushSurfaces(raw, runId, raster, renderModels, pendingPreds);

  const durationMs = nowMs() - startedAtSec * 1000;
  raw
    .prepare(
      `UPDATE occupancy_runs
         SET status = 'completed', n_models = ?, n_eligible = ?, duration_ms = ?, completed_at = ?
       WHERE id = ?`,
    )
    .run(nModels, nEligible, durationMs, Math.floor(nowMs() / 1000), runId);

  return { runId, nModels, nEligible, durationMs };
}

// Isolated for testability / to keep Date usage in one place.
function nowMs(): number {
  return Date.now();
}

interface LoadedRaster {
  forest: Map<string, number | null>;
  elevation: Map<string, number | null>;
  grid: RasterGridCell[];
}

/**
 * Sample forest cover + elevation for real sites and build the AOI prediction
 * grid. Env-gated (`OCCUPANCY_FOREST_RASTER`); returns null on the seed/dev path
 * so the pipeline runs on field_notes covariates with no map surface.
 */
async function loadRasterCovariates(
  sites: { siteId: string; lat: number; lng: number }[],
): Promise<LoadedRaster | null> {
  const forestRaster = process.env.OCCUPANCY_FOREST_RASTER;
  if (!forestRaster || sites.length === 0) return null;
  const res = await runForestCover({
    forestRaster,
    demRaster: process.env.OCCUPANCY_DEM_RASTER ?? null,
    aoiKml: process.env.OCCUPANCY_AOI_KML ?? null,
    forestClasses: process.env.OCCUPANCY_FOREST_CLASSES
      ? process.env.OCCUPANCY_FOREST_CLASSES.split(",").map(Number)
      : undefined,
    bufferMeters: process.env.OCCUPANCY_BUFFER_METERS
      ? Number(process.env.OCCUPANCY_BUFFER_METERS)
      : undefined,
    sites,
  });
  if (!res.success) {
    log.warn({ error: res.error }, "occupancy_raster_failed");
    return null;
  }
  return {
    forest: new Map(res.sites.map((s) => [s.siteId, s.forestCover])),
    elevation: new Map(res.sites.map((s) => [s.siteId, s.elevation])),
    grid: res.grid,
  };
}

/** Build grid covariates matching the model's continuous covariate names. */
function buildGridCovariates(
  grid: RasterGridCell[],
  covSpecs: { name: string; kind: string }[],
): GridCovariateSpec[] | undefined {
  if (grid.length === 0) return undefined;
  const wanted = new Set(covSpecs.filter((c) => c.kind === "continuous").map((c) => c.name));
  const specs: GridCovariateSpec[] = [];
  if (wanted.has("forest") && grid.every((c) => c.forestCover != null)) {
    specs.push({ name: "forest", kind: "continuous", values: grid.map((c) => c.forestCover as number) });
  }
  if (wanted.has("elevation") && grid.every((c) => c.elevation != null)) {
    specs.push({ name: "elevation", kind: "continuous", values: grid.map((c) => c.elevation as number) });
  }
  // Only predict a surface when every wanted continuous covariate is mappable.
  return specs.length === wanted.size && specs.length > 0 ? specs : undefined;
}

interface PendingPrediction {
  modelId: number;
  slug: string;
  gridRelPath: string;
  nCells: number;
  psiMin: number | null;
  psiMax: number | null;
}

/**
 * Write the per-model prediction JSON artifact and return what the prediction
 * row needs. The JSON is an OBJECT `{ cells, curves, habitatUse }`: `cells` back
 * the map hover (ψ + CI + forest + elevation per cell); `curves`/`habitatUse`
 * are the R-predicted response curves / habitat bars WITH 95% CIs. The ψ PNG is
 * NOT rendered here — it is batched into flushSurfaces after the fit loop.
 */
function writeGridArtifact(
  runId: number,
  species: string,
  stream: string,
  variant: "gradient" | "habitat",
  grid: RasterGridCell[],
  prediction: OccupancyPrediction | null,
  curves: Record<string, OccupancyCurvePoint[]> | undefined,
  habitatUse: OccupancyHabitatBar[] | undefined,
): { slug: string; gridRelPath: string; nCells: number; psiMin: number | null; psiMax: number | null } {
  const dir = nodePath.join(process.cwd(), "data", "occupancy-models", String(runId));
  fs.mkdirSync(dir, { recursive: true });
  // Slug carries the variant so geo + habitat artifacts for one species don't
  // clobber each other (they share species+stream).
  const slug = `${species.replace(/[^a-z0-9]+/gi, "-")}-${stream}-${variant}`;
  const gridPath = nodePath.join(dir, `${slug}.json`);
  // The habitat variant has no ψ surface — it writes an empty cells array and
  // carries only the habitat-use bars.
  const cells = prediction
    ? grid.map((c, i) => ({
        lat: c.lat,
        lng: c.lng,
        psi: prediction.psi[i] ?? null,
        se: prediction.se[i] ?? null,
        lower: prediction.lower?.[i] ?? null,
        upper: prediction.upper?.[i] ?? null,
        forest: c.forestCover ?? null,
        elevation: c.elevation ?? null,
      }))
    : [];
  fs.writeFileSync(
    gridPath,
    JSON.stringify({ cells, curves: curves ?? null, habitatUse: habitatUse ?? null }),
  );
  const psis = prediction ? prediction.psi.filter((v) => Number.isFinite(v)) : [];
  return {
    slug,
    gridRelPath: nodePath.relative(process.cwd(), gridPath),
    nCells: cells.length,
    psiMin: psis.length ? Math.min(...psis) : null,
    psiMax: psis.length ? Math.max(...psis) : null,
  };
}

/** State-submodel coefficients needed to evaluate ψ per raster pixel. */
function stateCoefficients(
  effects: { param: string; estimate: number }[],
): { b0: number; forest: number | null; elevation: number | null } {
  const byName = new Map<string, number>();
  for (const e of effects) {
    const { submodel, name } = splitEffect(e.param);
    if (submodel === "state") byName.set(name, e.estimate);
  }
  return {
    b0: byName.get("Int") ?? byName.get("(Intercept)") ?? 0,
    forest: byName.has("forest") ? byName.get("forest")! : null,
    elevation: byName.has("elevation") ? byName.get("elevation")! : null,
  };
}

/**
 * Render every map surface for the run in ONE high-resolution pass and insert the
 * prediction rows. Env-gated on the raster + AOI KML; a no-op (no rows, no PNGs)
 * on the seed/dev path with no raster configured. If the render fails, rows are
 * still written (grid JSON + coarse bbox) but with a null artifact_path so the
 * page degrades to "surface unavailable" rather than failing the run.
 */
async function flushSurfaces(
  raw: BetterSqlite3.Database,
  runId: number,
  raster: LoadedRaster | null,
  models: RasterModelSpec[],
  pending: PendingPrediction[],
): Promise<void> {
  if (!raster || pending.length === 0) return;

  const forestRaster = process.env.OCCUPANCY_FOREST_RASTER;
  const aoiKml = process.env.OCCUPANCY_AOI_KML;
  const dir = nodePath.join(process.cwd(), "data", "occupancy-models", String(runId));

  let bounds: number[] | null = null;
  const renderedModels = new Set<string>();
  if (forestRaster && aoiKml && raster.grid.length > 0) {
    const rr = await renderRasterSurfaces({
      forestRaster,
      demRaster: process.env.OCCUPANCY_DEM_RASTER ?? null,
      forestClasses: process.env.OCCUPANCY_FOREST_CLASSES
        ? process.env.OCCUPANCY_FOREST_CLASSES.split(",").map(Number)
        : undefined,
      bufferMeters: process.env.OCCUPANCY_BUFFER_METERS
        ? Number(process.env.OCCUPANCY_BUFFER_METERS)
        : undefined,
      // ψ-surface forest window (radius, m). Smaller = sharper/higher-resolution
      // (down to the DEM scale) but forest-driven ψ trends toward a binary
      // forest/non-forest look; larger = smoother probability gradient.
      psiForestMeters: process.env.OCCUPANCY_PSI_FOREST_METERS
        ? Number(process.env.OCCUPANCY_PSI_FOREST_METERS)
        : undefined,
      aoiKml,
      outDir: dir,
      forest: { out: "_forest.png" },
      elevation: process.env.OCCUPANCY_DEM_RASTER ? { out: "_elevation.png" } : undefined,
      models,
    }, {
      // One full-grid ψ render per model on top of the shared forest/elevation
      // pass — the fixed 180 s default is easily blown by a full species batch
      // (SIGKILL → null → EVERY ψ surface lost). Scale a generous budget by model
      // count; this is a background job with no hard wall-clock limit.
      timeoutMs: Math.max(180_000, models.length * 10_000),
    });
    if (rr) {
      bounds = rr.bounds;
      for (const m of rr.models) renderedModels.add(m);
    }
  }

  const bbox = bounds ?? paddedBbox(raster.grid) ?? [
    Math.min(...raster.grid.map((c) => c.lng)),
    Math.min(...raster.grid.map((c) => c.lat)),
    Math.max(...raster.grid.map((c) => c.lng)),
    Math.max(...raster.grid.map((c) => c.lat)),
  ];

  const ins = raw.prepare(
    `INSERT INTO occupancy_predictions (model_id, grid_data_path, artifact_path, n_cells, psi_min, psi_max, bbox_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const p of pending) {
    const name = `${p.slug}`;
    // renderedModels keys are `${species}-${stream}`; artifact filenames are `${slug}.png`.
    const rendered = renderedModels.size > 0 && models.some((m) => m.out === `${name}.png` && renderedModels.has(m.name));
    ins.run(
      p.modelId,
      p.gridRelPath,
      rendered ? nodePath.relative(process.cwd(), nodePath.join(dir, `${name}.png`)) : null,
      p.nCells,
      p.psiMin,
      p.psiMax,
      JSON.stringify(bbox),
    );
  }
}
