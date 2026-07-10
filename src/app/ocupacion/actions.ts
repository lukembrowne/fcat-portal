"use server";

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { processingJobs, occupancyRuns } from "@/db/schema";
import { requirePermission } from "@/lib/auth";
import { log } from "@/lib/log";
import type { ActionResult } from "@/lib/types";
import { computeReadiness, type ReadinessReport } from "@/lib/occupancy/readiness";
import { fetchOccupancyInputs } from "@/lib/occupancy/fetch";
import { buildDetectionFrame } from "@/lib/occupancy/detection-history";
import { getSyntheticSiteIds, cohortSitesFor } from "@/lib/occupancy/cohort";
import { DEFAULT_BIN_WIDTH_DAYS } from "@/lib/occupancy/occasions";
import { DEFAULT_CONFIDENCE_THRESHOLD } from "@/lib/audio-confidence";
import { JOB_TYPES } from "@/lib/job-types";
import { processNextQueueable } from "@/lib/job-queue";
import {
  occupancyModels,
  occupancyCovariateEffects,
  occupancySiteCovariates,
  occupancyPredictions,
} from "@/db/schema";
import {
  responseCurve,
  habitatUse,
  type Effect,
  type CurvePoint,
  type HabitatBar,
} from "@/lib/occupancy/curves";
import { toForestPlot, inverseVarianceMean, type SpeciesSlope } from "@/lib/occupancy/meta-analysis";
import { sumRichness } from "@/lib/occupancy/richness";
import { renderSurface, paddedBbox } from "@/lib/occupancy/surface";
import fs from "node:fs";
import nodePath from "node:path";

export interface OccupancyReadinessResult {
  camera: ReadinessReport;
  audio: ReadinessReport;
  /** Deployments dropped from a stream's site pool for want of a survey window. */
  cameraSitesDropped: number;
  audioSitesDropped: number;
  generatedAt: string;
}

export interface OccupancyReadinessOptions {
  binWidth?: number;
  confidenceThreshold?: number;
}

export async function getOccupancyReadiness(
  opts: OccupancyReadinessOptions = {},
): Promise<ActionResult<OccupancyReadinessResult>> {
  await requirePermission("camera-trap", "viewer");

  const binWidth = opts.binWidth ?? DEFAULT_BIN_WIDTH_DAYS;
  const confidenceThreshold = opts.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;

  try {
    const cam = fetchOccupancyInputs("camera", {});
    const camera = computeReadiness(cam.sites, cam.detections, {
      stream: "camera",
      binWidth,
    });

    const aud = fetchOccupancyInputs("audio", { confidenceThreshold });
    const audio = computeReadiness(aud.sites, aud.detections, {
      stream: "audio",
      binWidth,
      confidenceThreshold,
    });

    return {
      success: true,
      data: {
        camera,
        audio,
        cameraSitesDropped: cam.droppedSites,
        audioSitesDropped: aud.droppedSites,
        generatedAt: new Date().toISOString(),
      },
    };
  } catch (error) {
    log.error({ err: error }, "getOccupancyReadiness failed");
    return { success: false, error: "No se pudo calcular la disponibilidad de datos de ocupación." };
  }
}

/**
 * Admin-only: enqueue an occupancy modeling run. Single-flight — refuses if a run
 * is already pending/processing.
 */
export async function triggerOccupancyRun(): Promise<ActionResult<{ jobId: number }>> {
  const user = await requirePermission("camera-trap", "admin");
  try {
    const active = await db
      .select({ id: processingJobs.id })
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.jobType, JOB_TYPES.OCCUPANCY_MODEL),
          inArray(processingJobs.status, ["pending", "processing"]),
        ),
      )
      .limit(1);
    if (active.length > 0) {
      return { success: false, error: "Ya hay una actualización de modelos en curso." };
    }

    const [job] = await db
      .insert(processingJobs)
      .values({
        jobType: JOB_TYPES.OCCUPANCY_MODEL,
        status: "pending",
        createdBy: user.email,
        statusMessage: "En cola: modelos de ocupación...",
      })
      .returning();

    void processNextQueueable().catch((err) =>
      log.error({ err, jobId: job.id }, "[occupancy] Queue advance failed after enqueue"),
    );
    return { success: true, data: { jobId: job.id } };
  } catch (error) {
    log.error({ err: error }, "triggerOccupancyRun failed");
    return { success: false, error: "No se pudo iniciar la actualización de modelos." };
  }
}

export interface LatestOccupancyRunInfo {
  run: {
    id: number;
    completedAt: Date | null;
    nModels: number;
    nEligible: number;
    durationMs: number | null;
  } | null;
  activeJob: {
    id: number;
    status: string;
    statusMessage: string | null;
    processedImages: number | null;
    totalImages: number | null;
  } | null;
}

export async function getLatestOccupancyRun(): Promise<ActionResult<LatestOccupancyRunInfo>> {
  await requirePermission("camera-trap", "viewer");
  try {
    const [run] = await db
      .select({
        id: occupancyRuns.id,
        completedAt: occupancyRuns.completedAt,
        nModels: occupancyRuns.nModels,
        nEligible: occupancyRuns.nEligible,
        durationMs: occupancyRuns.durationMs,
        status: occupancyRuns.status,
      })
      .from(occupancyRuns)
      .where(eq(occupancyRuns.status, "completed"))
      .orderBy(desc(occupancyRuns.completedAt))
      .limit(1);

    const [active] = await db
      .select({
        id: processingJobs.id,
        status: processingJobs.status,
        statusMessage: processingJobs.statusMessage,
        processedImages: processingJobs.processedImages,
        totalImages: processingJobs.totalImages,
      })
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.jobType, JOB_TYPES.OCCUPANCY_MODEL),
          inArray(processingJobs.status, ["pending", "processing"]),
        ),
      )
      .limit(1);

    return {
      success: true,
      data: {
        run: run
          ? {
              id: run.id,
              completedAt: run.completedAt,
              nModels: run.nModels,
              nEligible: run.nEligible,
              durationMs: run.durationMs,
            }
          : null,
        activeJob: active ?? null,
      },
    };
  } catch (error) {
    log.error({ err: error }, "getLatestOccupancyRun failed");
    return { success: false, error: "No se pudo obtener el estado de los modelos." };
  }
}

async function latestCompletedRunId(): Promise<number | null> {
  const [r] = await db
    .select({ id: occupancyRuns.id })
    .from(occupancyRuns)
    .where(eq(occupancyRuns.status, "completed"))
    .orderBy(desc(occupancyRuns.completedAt))
    .limit(1);
  return r?.id ?? null;
}

export interface ModeledSpeciesRow {
  species: string;
  stream: string;
  estimatedOccupancy: number | null;
  naiveOccupancy: number | null;
  meanDetection: number | null;
  nSites: number;
  nSitesDetected: number;
}

export async function listModeledSpecies(): Promise<ActionResult<ModeledSpeciesRow[]>> {
  await requirePermission("camera-trap", "viewer");
  try {
    const runId = await latestCompletedRunId();
    if (!runId) return { success: true, data: [] };
    const rows = await db
      .select({
        species: occupancyModels.species,
        stream: occupancyModels.stream,
        estimatedOccupancy: occupancyModels.estimatedOccupancy,
        naiveOccupancy: occupancyModels.naiveOccupancy,
        meanDetection: occupancyModels.meanDetection,
        nSites: occupancyModels.nSites,
        nSitesDetected: occupancyModels.nSitesDetected,
      })
      .from(occupancyModels)
      .where(and(eq(occupancyModels.runId, runId), eq(occupancyModels.sufficientData, true)));
    return { success: true, data: rows };
  } catch (error) {
    log.error({ err: error }, "listModeledSpecies failed");
    return { success: false, error: "No se pudieron listar los modelos." };
  }
}

/** Per-cell grid data for the map hover (ψ + CI + covariates). */
export interface MapCell {
  lat: number;
  lng: number;
  psi: number | null;
  lower: number | null;
  upper: number | null;
  forest: number | null;
  elevation: number | null;
}

export interface SpeciesModelDetail {
  species: string;
  stream: string;
  estimatedOccupancy: number | null;
  occupancyLower: number | null;
  occupancyUpper: number | null;
  meanDetection: number | null;
  naiveOccupancy: number | null;
  nSites: number;
  nSitesDetected: number;
  totalDetections: number;
  nOccasions: number;
  aic: number | null;
  convergence: number | null;
  psiFormula: string | null;
  detFormula: string | null;
  fitSeconds: number | null;
  effects: { submodel: string; param: string; estimate: number; se: number | null; z: number | null; pValue: number | null }[];
  habitatUse: HabitatBar[];
  forestCurve: CurvePoint[];
  elevationCurve: CurvePoint[];
  prediction: {
    /** Run + surface names to build the /api/ocupacion/surface layer URLs. */
    runId: number;
    psiName: string | null;
    hasForest: boolean;
    hasElevation: boolean;
    bbox: number[] | null;
    psiMin: number | null;
    psiMax: number | null;
    nCells: number | null;
    cells: MapCell[];
    /** Deployment locations in this species' model cohort (sampling points). */
    sites: { lat: number; lng: number }[];
  } | null;
}

/** Shape of the per-model grid JSON artifact written by persistPrediction. */
interface GridArtifact {
  cells: MapCell[];
  curves: Record<string, { x: number; psi: number; lower: number; upper: number }[]> | null;
  habitatUse:
    | { habitat: string; psi: number; lower: number; upper: number; isReference: boolean }[]
    | null;
}

export async function getSpeciesModel(
  species: string,
  stream: "camera" | "audio",
): Promise<ActionResult<SpeciesModelDetail | null>> {
  await requirePermission("camera-trap", "viewer");
  try {
    const runId = await latestCompletedRunId();
    if (!runId) return { success: true, data: null };

    const [model] = await db
      .select()
      .from(occupancyModels)
      .where(
        and(
          eq(occupancyModels.runId, runId),
          eq(occupancyModels.species, species),
          eq(occupancyModels.stream, stream),
          eq(occupancyModels.sufficientData, true),
        ),
      )
      .limit(1);
    if (!model) return { success: true, data: null };

    const effectRows = await db
      .select()
      .from(occupancyCovariateEffects)
      .where(eq(occupancyCovariateEffects.modelId, model.id));
    const effects: Effect[] = effectRows.map((e) => ({
      submodel: e.submodel as "state" | "det",
      param: e.param,
      estimate: e.estimate,
    }));

    const snap = await db
      .select({
        habitat: occupancySiteCovariates.habitat,
        elevation: occupancySiteCovariates.elevation,
        forestCover: occupancySiteCovariates.forestCover,
      })
      .from(occupancySiteCovariates)
      .where(and(eq(occupancySiteCovariates.runId, runId), eq(occupancySiteCovariates.stream, stream)));

    const habitats = snap.map((s) => s.habitat).filter((v): v is string => !!v);
    const forestVals = snap.map((s) => s.forestCover).filter((v): v is number => v != null);
    const elevVals = snap.map((s) => s.elevation).filter((v): v is number => v != null);

    const [pred] = await db
      .select()
      .from(occupancyPredictions)
      .where(eq(occupancyPredictions.modelId, model.id))
      .limit(1);

    // Response curves + habitat-use come from the R-predicted artifact (with 95%
    // CIs); fall back to the coefficient-only TS reconstruction for legacy runs.
    const grid = readGridArtifact(pred?.gridDataPath ?? null);
    const habitatBars: HabitatBar[] = grid?.habitatUse
      ? grid.habitatUse.map((h) => ({
          habitat: h.habitat, psi: h.psi, lower: h.lower, upper: h.upper, isReference: h.isReference,
        }))
      : habitats.length
        ? habitatUse(effects, habitats)
        : [];
    const curveFrom = (name: "forest" | "elevation", rawVals: number[]): CurvePoint[] => {
      const r = grid?.curves?.[name];
      return r
        ? r.map((p) => ({ x: p.x, psi: p.psi, lower: p.lower, upper: p.upper }))
        : responseCurve(effects, name, rawVals);
    };

    const psiName = pred?.artifactPath
      ? nodePath.basename(pred.artifactPath).replace(/\.png$/i, "")
      : null;

    // Sampling points = the deployment locations in THIS species' cohort. The
    // per-run snapshot holds the whole stream pool (synthetic seed + real), so
    // split by the OCC-SEED marker and pick the group whose size matches the
    // model's n_sites (cohort isolation put the species in exactly one group).
    const sitePts = db.all(sql`
      SELECT sc.latitude AS lat, sc.longitude AS lng,
             (d.name LIKE 'OCC-SEED-%') AS synthetic
      FROM occupancy_site_covariates sc
      JOIN biochoco_deployments d ON d.id = CAST(sc.site_id AS INTEGER)
      WHERE sc.run_id = ${runId} AND sc.stream = ${stream}
        AND sc.latitude IS NOT NULL AND sc.longitude IS NOT NULL
    `) as { lat: number; lng: number; synthetic: number }[];
    const synth = sitePts.filter((p) => p.synthetic);
    const real = sitePts.filter((p) => !p.synthetic);
    const cohort =
      synth.length === model.nSites ? synth : real.length === model.nSites ? real : sitePts;
    const sites = cohort.map((p) => ({ lat: p.lat, lng: p.lng }));

    return {
      success: true,
      data: {
        species: model.species,
        stream: model.stream,
        estimatedOccupancy: model.estimatedOccupancy,
        occupancyLower: model.occupancyLower,
        occupancyUpper: model.occupancyUpper,
        meanDetection: model.meanDetection,
        naiveOccupancy: model.naiveOccupancy,
        nSites: model.nSites,
        nSitesDetected: model.nSitesDetected,
        totalDetections: model.totalDetections,
        nOccasions: model.nOccasions,
        aic: model.aic,
        convergence: model.convergence,
        psiFormula: model.psiFormula,
        detFormula: model.detFormula,
        fitSeconds: model.fitSeconds,
        effects: effectRows.map((e) => ({
          submodel: e.submodel,
          param: e.param,
          estimate: e.estimate,
          se: e.se,
          z: e.z,
          pValue: e.pValue,
        })),
        habitatUse: habitatBars,
        forestCurve: curveFrom("forest", forestVals),
        elevationCurve: curveFrom("elevation", elevVals),
        prediction: pred
          ? {
              runId,
              psiName,
              hasForest: surfaceExists(runId, "_forest"),
              hasElevation: surfaceExists(runId, "_elevation"),
              bbox: pred.bboxJson ? (JSON.parse(pred.bboxJson) as number[]) : null,
              psiMin: pred.psiMin,
              psiMax: pred.psiMax,
              nCells: pred.nCells,
              cells: grid?.cells ?? [],
              sites,
            }
          : null,
      },
    };
  } catch (error) {
    log.error({ err: error, species, stream }, "getSpeciesModel failed");
    return { success: false, error: "No se pudo obtener el modelo de la especie." };
  }
}

/** Parse the per-model grid artifact. Handles the current object form and the
 *  legacy bare-array form (older runs). */
function readGridArtifact(gridDataPath: string | null): GridArtifact | null {
  if (!gridDataPath) return null;
  try {
    const abs = nodePath.isAbsolute(gridDataPath)
      ? gridDataPath
      : nodePath.join(process.cwd(), gridDataPath);
    const parsed = JSON.parse(fs.readFileSync(abs, "utf-8"));
    if (Array.isArray(parsed)) return { cells: parsed as MapCell[], curves: null, habitatUse: null };
    return parsed as GridArtifact;
  } catch {
    return null;
  }
}


/** Whether a shared covariate surface PNG was rendered for this run. */
function surfaceExists(runId: number, name: string): boolean {
  try {
    return fs.existsSync(
      nodePath.join(process.cwd(), "data", "occupancy-models", String(runId), `${name}.png`),
    );
  } catch {
    return false;
  }
}

/** Mean predicted ψ for a habitat, summarized across all modeled species. */
export interface HabitatOccupancy {
  habitat: string;
  meanPsi: number;
  /** 95% CI of the across-species mean (null when only 1 species). */
  lower: number | null;
  upper: number | null;
  nSpecies: number;
}

/** Aggregate per-species per-habitat ψ (from grid artifacts) into a cross-species
 *  mean ± 95% CI (standard error of the mean across species) per habitat. */
function aggregateHabitatOccupancy(
  barsPerModel: { habitat: string; psi: number }[][],
): HabitatOccupancy[] {
  const byHabitat = new Map<string, number[]>();
  for (const bars of barsPerModel) {
    for (const b of bars) {
      if (b.psi == null || !Number.isFinite(b.psi)) continue;
      const arr = byHabitat.get(b.habitat) ?? [];
      arr.push(b.psi);
      byHabitat.set(b.habitat, arr);
    }
  }
  const out: HabitatOccupancy[] = [];
  for (const [habitat, vals] of byHabitat) {
    const n = vals.length;
    const mean = vals.reduce((a, v) => a + v, 0) / n;
    let lower: number | null = null;
    let upper: number | null = null;
    if (n >= 2) {
      const variance = vals.reduce((a, v) => a + (v - mean) ** 2, 0) / (n - 1);
      const sem = Math.sqrt(variance) / Math.sqrt(n);
      lower = Math.max(0, mean - 1.959964 * sem);
      upper = Math.min(1, mean + 1.959964 * sem);
    }
    out.push({ habitat, meanPsi: mean, lower, upper, nSpecies: n });
  }
  out.sort((a, b) => b.meanPsi - a.meanPsi);
  return out;
}

export interface CrossSpeciesData {
  forestPlot: SpeciesSlope[];
  elevationPlot: SpeciesSlope[];
  forestMean: number | null;
  elevationMean: number | null;
  /** Per-species overall occupancy (ψ + 95% CI) for the cross-species forest plot. */
  overallPlot: SpeciesSlope[];
  /** Mean ψ per habitat, summarized across species. */
  habitatOccupancy: HabitatOccupancy[];
  /** Richness surface (Σψ, normalized to [0,1]) as a raster layer for the map. */
  richness: {
    runId: number;
    psiName: string | null;
    bbox: number[] | null;
    cells: MapCell[];
  } | null;
  maxRichness: number;
  nSpeciesModeled: number;
}

export async function getCrossSpeciesData(): Promise<ActionResult<CrossSpeciesData>> {
  await requirePermission("camera-trap", "viewer");
  try {
    const runId = await latestCompletedRunId();
    const empty: CrossSpeciesData = {
      forestPlot: [],
      elevationPlot: [],
      forestMean: null,
      elevationMean: null,
      overallPlot: [],
      habitatOccupancy: [],
      richness: null,
      maxRichness: 0,
      nSpeciesModeled: 0,
    };
    if (!runId) return { success: true, data: empty };

    const slopeRows = await db
      .select({
        species: occupancyModels.species,
        stream: occupancyModels.stream,
        param: occupancyCovariateEffects.param,
        estimate: occupancyCovariateEffects.estimate,
        se: occupancyCovariateEffects.se,
      })
      .from(occupancyCovariateEffects)
      .innerJoin(occupancyModels, eq(occupancyModels.id, occupancyCovariateEffects.modelId))
      .where(
        and(eq(occupancyModels.runId, runId), eq(occupancyCovariateEffects.submodel, "state")),
      );

    const forestRows = slopeRows
      .filter((r) => r.param === "forest")
      .map((r) => ({ species: r.species, stream: r.stream, estimate: r.estimate, se: r.se }));
    const elevRows = slopeRows
      .filter((r) => r.param === "elevation")
      .map((r) => ({ species: r.species, stream: r.stream, estimate: r.estimate, se: r.se }));

    const preds = await db
      .select({ gridDataPath: occupancyPredictions.gridDataPath })
      .from(occupancyPredictions)
      .innerJoin(occupancyModels, eq(occupancyModels.id, occupancyPredictions.modelId))
      .where(eq(occupancyModels.runId, runId));
    const artifacts = preds
      .map((p) => readGridArtifact(p.gridDataPath))
      .filter((a): a is GridArtifact => a != null);
    const grids = artifacts.map((a) => a.cells).filter((c) => c.length > 0);
    const habitatOccupancy = aggregateHabitatOccupancy(
      artifacts.map((a) => a.habitatUse ?? []),
    );
    const rich = sumRichness(grids);
    const maxRichness = rich.reduce((a, c) => Math.max(a, c.richness), 0);
    const richCells: MapCell[] = rich.map((c) => ({
      lat: c.lat,
      lng: c.lng,
      psi: maxRichness > 0 ? c.richness / maxRichness : 0,
      lower: null,
      upper: null,
      forest: null,
      elevation: null,
    }));

    // Render the summed-richness surface once per run (cached by file presence).
    let richness: CrossSpeciesData["richness"] = null;
    if (richCells.length > 0) {
      const richPng = nodePath.join(
        process.cwd(), "data", "occupancy-models", String(runId), "_richness.png",
      );
      let bounds: number[] | null = null;
      if (!fs.existsSync(richPng)) {
        const rendered = await renderSurface({
          cells: richCells.map((c) => ({ lat: c.lat, lng: c.lng, value: c.psi })),
          ramp: "psi",
          outPath: richPng,
          vmin: 0,
          vmax: 1,
        });
        bounds = rendered?.bounds ?? null;
      }
      richness = {
        runId,
        psiName: fs.existsSync(richPng) ? "_richness" : null,
        bbox: bounds ?? paddedBbox(richCells),
        cells: richCells,
      };
    }

    const models = await db
      .select({
        species: occupancyModels.species,
        stream: occupancyModels.stream,
        estimatedOccupancy: occupancyModels.estimatedOccupancy,
        occupancyLower: occupancyModels.occupancyLower,
        occupancyUpper: occupancyModels.occupancyUpper,
      })
      .from(occupancyModels)
      .where(and(eq(occupancyModels.runId, runId), eq(occupancyModels.sufficientData, true)));

    const overallPlot: SpeciesSlope[] = models
      .filter((m) => m.estimatedOccupancy != null)
      .map((m) => ({
        species: m.species,
        stream: m.stream,
        estimate: m.estimatedOccupancy as number,
        se: null,
        lower: m.occupancyLower,
        upper: m.occupancyUpper,
      }))
      .sort((a, b) => b.estimate - a.estimate);

    return {
      success: true,
      data: {
        forestPlot: toForestPlot(forestRows),
        elevationPlot: toForestPlot(elevRows),
        forestMean: inverseVarianceMean(forestRows),
        elevationMean: inverseVarianceMean(elevRows),
        overallPlot,
        habitatOccupancy,
        richness,
        maxRichness,
        nSpeciesModeled: models.length,
      },
    };
  } catch (error) {
    log.error({ err: error }, "getCrossSpeciesData failed");
    return { success: false, error: "No se pudieron obtener los resultados entre especies." };
  }
}

/** One site's row of the detection matrix (cells + effort, length maxOccasions). */
export interface DetectionSampleRow {
  siteId: string;
  siteName: string;
  /** Occasions actually surveyed at this site (non-NA cells). */
  occasions: number;
  /** In-window detections at this site. */
  detections: number;
  /** 1 = detectada, 0 = revisada sin detección, null = fuera de ventana (NA). */
  cells: (0 | 1 | null)[];
  /** Categorical survey-effort label per occasion (null where cell is NA). */
  effort: (string | null)[];
}

export interface ModelInputSample {
  binWidth: number;
  /** Total sites in the fit cohort. */
  nSites: number;
  maxOccasions: number;
  rows: DetectionSampleRow[];
}

/**
 * Rebuild a bounded slice of the exact site × occasion detection matrix the model
 * consumes, so the species page can show that the site/visit structure is built
 * correctly. Rebuilt on demand from current detections (structure is
 * authoritative even if counts drift slightly from fit time) using the same
 * cohort isolation + bin width as the run.
 */
export async function getModelInputSample(
  species: string,
  stream: "camera" | "audio",
  maxSites = 12,
): Promise<ActionResult<ModelInputSample | null>> {
  await requirePermission("camera-trap", "viewer");
  try {
    const runId = await latestCompletedRunId();
    let binWidth = DEFAULT_BIN_WIDTH_DAYS;
    if (runId) {
      const [run] = await db
        .select({ bw: occupancyRuns.binWidthDays })
        .from(occupancyRuns)
        .where(eq(occupancyRuns.id, runId))
        .limit(1);
      if (run?.bw) binWidth = run.bw;
    }
    const inputs = fetchOccupancyInputs(stream, {
      confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
    });
    const events = inputs.detections.filter((d) => d.species === species);
    if (events.length === 0) return { success: true, data: null };

    const synthetic = getSyntheticSiteIds(inputs);
    const cohort = cohortSitesFor(inputs.sites, events, synthetic);
    const frame = buildDetectionFrame(cohort, events, { binWidth });

    // Detected sites first (most informative), then most-surveyed.
    const rows: DetectionSampleRow[] = frame.perSite
      .map((p, i) => ({ p, i }))
      .sort(
        (a, b) =>
          Number(b.p.detected) - Number(a.p.detected) ||
          b.p.detections - a.p.detections ||
          b.p.occasions - a.p.occasions,
      )
      .slice(0, maxSites)
      .map(({ p, i }) => ({
        siteId: p.siteId,
        siteName: p.siteName,
        occasions: p.occasions,
        detections: p.detections,
        cells: frame.y[i],
        effort: frame.effort[i],
      }));

    return {
      success: true,
      data: { binWidth, nSites: frame.siteIds.length, maxOccasions: frame.maxOccasions, rows },
    };
  } catch (error) {
    log.error({ err: error, species, stream }, "getModelInputSample failed");
    return { success: false, error: "No se pudo obtener la muestra de datos del modelo." };
  }
}
