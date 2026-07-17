"use server";

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { processingJobs, occupancyRuns, species } from "@/db/schema";
import { requirePermission } from "@/lib/auth";
import { log } from "@/lib/log";
import type { ActionResult } from "@/lib/types";
import { fetchOccupancyInputs } from "@/lib/occupancy/fetch";
import {
  computeReadinessResult,
  type OccupancyReadinessResult,
} from "@/lib/occupancy/readiness-compute";
import {
  computeReadinessFingerprint,
  loadLatestReadinessSnapshot,
  saveReadinessSnapshot,
} from "@/lib/occupancy/readiness-snapshot";
import { recordEvent } from "@/lib/system-events";
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
import { toForestPlot, inverseVarianceMean, preferredByAic, type SpeciesSlope } from "@/lib/occupancy/meta-analysis";
import { isSeparated } from "@/lib/occupancy/separation";
import {
  classifyModelStatus,
  type SpeciesModelStatus,
  type ModelVariantRow,
} from "@/lib/occupancy/model-status";
import { naiveOccupancyByHabitat, type HabitatNaiveRow } from "@/lib/occupancy/habitat-summary";
import fs from "node:fs";
import nodePath from "node:path";

/** What the page needs to render the readiness snapshot + its freshness. */
export interface OccupancyReadinessSnapshotView {
  /** The stored readiness report, or null on cold start (no snapshot yet). */
  snapshot: OccupancyReadinessResult | null;
  /** True when live data has changed since the snapshot was generated. */
  stale: boolean;
  /** When the snapshot was generated (ISO), or null on cold start. */
  generatedAt: string | null;
  /** Who generated it (email or "batch"), or null. */
  generatedBy: string | null;
}

/**
 * Read-only: return the stored readiness snapshot for the page. Renders instantly
 * — NEVER runs the full recompute. Computes only the cheap fingerprint to flag
 * whether underlying data changed since the snapshot ("hay datos nuevos").
 */
export async function getOccupancyReadinessSnapshot(): Promise<
  ActionResult<OccupancyReadinessSnapshotView>
> {
  await requirePermission("camera-trap", "viewer");
  try {
    const loaded = loadLatestReadinessSnapshot();
    const currentFingerprint = computeReadinessFingerprint();
    // Compare the STORED fingerprint column (not a field on the result blob)
    // against the freshly computed one.
    const stale = loaded != null && loaded.fingerprint !== currentFingerprint;
    return {
      success: true,
      data: {
        snapshot: loaded?.result ?? null,
        stale,
        generatedAt: loaded ? loaded.generatedAt.toISOString() : null,
        generatedBy: loaded?.generatedBy ?? null,
      },
    };
  } catch (error) {
    log.error({ err: error }, "getOccupancyReadinessSnapshot failed");
    return { success: false, error: "No se pudo cargar la disponibilidad de datos de ocupación." };
  }
}

/**
 * Editor+ (foreground): recompute the readiness report, store it as a fresh
 * snapshot with the current fingerprint, and return it. This is the expensive
 * path — deliberately behind an explicit button, not the page load.
 */
export async function refreshOccupancyReadiness(): Promise<
  ActionResult<OccupancyReadinessResult>
> {
  const user = await requirePermission("camera-trap", "editor");
  try {
    const startedAt = Date.now();
    const result = await computeReadinessResult();
    const fingerprint = computeReadinessFingerprint();
    saveReadinessSnapshot({ result, fingerprint, generatedBy: user.email });
    await recordEvent({
      source: "camera-trap",
      eventType: "occupancy_readiness.refreshed",
      summary: "Disponibilidad de ocupación actualizada",
      projectId: "camera-trap",
      actorEmail: user.email,
      durationMs: Date.now() - startedAt,
    });
    return { success: true, data: result };
  } catch (error) {
    log.error({ err: error }, "refreshOccupancyReadiness failed");
    return { success: false, error: "No se pudo actualizar la disponibilidad de datos de ocupación." };
  }
}

/**
 * Display names + IUCN status for one species (by scientific name), for the
 * occupancy species detail header. Null when the species is absent from the
 * lookup — the caller falls back to the scientific string.
 */
export async function getOccupancySpeciesInfo(
  scientificName: string,
): Promise<{
  commonName: string | null;
  spanishName: string | null;
  iucnStatus: string | null;
} | null> {
  await requirePermission("camera-trap", "viewer");
  const [row] = await db
    .select({
      commonName: species.commonName,
      spanishName: species.spanishName,
      iucnStatus: species.iucnStatus,
    })
    .from(species)
    .where(eq(species.scientificName, scientificName))
    .limit(1);
  return row ?? null;
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

/**
 * Per-species model outcome for the latest completed run: `modeled` (carries the
 * AIC-preferred ψ/p), `ceiling` (casi ubicua — every variant separated at the ψ
 * boundary), or `unfit`. Reads ALL variant rows — NOT the `sufficient_data = true`
 * subset — so near-ubiquitous species surface with an explicit reason instead of
 * silently vanishing behind a "—". Ineligible species (only a legacy `combined`
 * gate row) are omitted; their state is shown live by the readiness gate.
 */
export async function listSpeciesModelStatus(): Promise<ActionResult<SpeciesModelStatus[]>> {
  await requirePermission("camera-trap", "viewer");
  try {
    const runId = await latestCompletedRunId();
    if (!runId) return { success: true, data: [] };
    const rows = await db
      .select({
        species: occupancyModels.species,
        stream: occupancyModels.stream,
        variant: occupancyModels.variant,
        sufficientData: occupancyModels.sufficientData,
        estimatedOccupancy: occupancyModels.estimatedOccupancy,
        meanDetection: occupancyModels.meanDetection,
        naiveOccupancy: occupancyModels.naiveOccupancy,
        nSites: occupancyModels.nSites,
        nSitesDetected: occupancyModels.nSitesDetected,
        aic: occupancyModels.aic,
        ineligibleReasonsJson: occupancyModels.ineligibleReasonsJson,
      })
      .from(occupancyModels)
      .where(eq(occupancyModels.runId, runId));

    const byKey = new Map<string, ModelVariantRow[]>();
    for (const r of rows) {
      const key = `${r.species}|${r.stream}`;
      const arr = byKey.get(key);
      if (arr) arr.push(r);
      else byKey.set(key, [r]);
    }
    const out: SpeciesModelStatus[] = [];
    for (const group of byKey.values()) {
      const status = classifyModelStatus(group);
      if (status) out.push(status);
    }
    return { success: true, data: out };
  } catch (error) {
    log.error({ err: error }, "listSpeciesModelStatus failed");
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
  /** When the batch that produced this model completed (ISO); null if unknown. */
  fittedAt: string | null;
  /** Which variant the headline numbers come from ('gradient'|'habitat'|'null'|'combined'); null if none identifiable. */
  preferredVariant: string | null;
  /** One row per fitted variant — powers the AIC comparison + non-identifiable notices. */
  variants: VariantSummary[];
  effects: { submodel: string; param: string; estimate: number; se: number | null; z: number | null; pValue: number | null; variant: string | null }[];
  /** Covariates omitted from this (eligible) model, with Spanish reasons. */
  droppedCovariates: { name: string; reason: string }[];
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
    /** Deployment locations in this species' model cohort (sampling points),
     *  with the site's ψ covariates for the map marker popup. Detection status
     *  is merged in on the page from getModelInputSample (keyed by siteId). */
    sites: {
      siteId: string;
      siteName: string | null;
      lat: number;
      lng: number;
      habitat: string | null;
      elevation: number | null;
      forestCover: number | null;
    }[];
  } | null;
}

/** One ψ variant's summary for the species-page comparison + notices. */
export interface VariantSummary {
  variant: string;
  aic: number | null;
  /** AIC − (best AIC among identifiable variants); null when not comparable. */
  deltaAic: number | null;
  identifiable: boolean;
  /** Spanish reason when not identifiable (degenerate / ineligible); null otherwise. */
  reason: string | null;
  psiFormula: string | null;
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

    const [runRow] = await db
      .select({ completedAt: occupancyRuns.completedAt })
      .from(occupancyRuns)
      .where(eq(occupancyRuns.id, runId))
      .limit(1);
    const fittedAt = runRow?.completedAt ? runRow.completedAt.toISOString() : null;

    // All variants for this species×stream in the latest run — the gradient +
    // habitat + null set (or a legacy 'combined' row). Include non-identifiable
    // ones so we can surface their degenerate/ineligible reasons on the page.
    const rows = await db
      .select()
      .from(occupancyModels)
      .where(
        and(
          eq(occupancyModels.runId, runId),
          eq(occupancyModels.species, species),
          eq(occupancyModels.stream, stream),
        ),
      );
    if (rows.length === 0) return { success: true, data: null };

    const identifiable = rows.filter((r) => r.sufficientData);
    const preferred = preferredByAic(identifiable);
    // A legacy 'combined' row drives every section itself (map + curves + bars).
    const gradientRow =
      identifiable.find((r) => r.variant === "gradient") ??
      identifiable.find((r) => r.variant === "combined") ??
      null;
    const habitatRow =
      identifiable.find((r) => r.variant === "habitat") ??
      identifiable.find((r) => r.variant === "combined") ??
      null;
    // The row whose diagnostics (n_sites, detections, etc.) anchor the header;
    // identical across variants (shared frame), so the preferred one — or, when
    // nothing is identifiable, any row — is fine.
    const baseRow = preferred ?? rows[0];

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

    // Load one variant's stored effects + prediction artifact.
    const loadVariant = async (row: typeof rows[number]) => {
      const effectRows = await db
        .select()
        .from(occupancyCovariateEffects)
        .where(eq(occupancyCovariateEffects.modelId, row.id));
      const [predRow] = await db
        .select()
        .from(occupancyPredictions)
        .where(eq(occupancyPredictions.modelId, row.id))
        .limit(1);
      return { row, effectRows, pred: predRow, grid: readGridArtifact(predRow?.gridDataPath ?? null) };
    };

    const gradientV = gradientRow ? await loadVariant(gradientRow) : null;
    const habitatV = habitatRow
      ? habitatRow.id === gradientRow?.id
        ? gradientV // legacy combined — same row drives both
        : await loadVariant(habitatRow)
      : null;

    // Map surface + response curves come from the gradient variant; habitat-use
    // bars from the habitat variant. Each falls back to the coefficient-only TS
    // reconstruction for legacy runs with no artifact.
    const gradientEffects: Effect[] = (gradientV?.effectRows ?? []).map((e) => ({
      submodel: e.submodel as "state" | "det",
      param: e.param,
      estimate: e.estimate,
    }));
    const habitatEffects: Effect[] = (habitatV?.effectRows ?? []).map((e) => ({
      submodel: e.submodel as "state" | "det",
      param: e.param,
      estimate: e.estimate,
    }));

    const habitatBars: HabitatBar[] = habitatV?.grid?.habitatUse
      ? habitatV.grid.habitatUse.map((h) => ({
          habitat: h.habitat, psi: h.psi, lower: h.lower, upper: h.upper, isReference: h.isReference,
        }))
      : habitats.length && habitatEffects.length
        ? habitatUse(habitatEffects, habitats)
        : [];
    const curveFrom = (name: "forest" | "elevation", rawVals: number[]): CurvePoint[] => {
      const r = gradientV?.grid?.curves?.[name];
      return r
        ? r.map((p) => ({ x: p.x, psi: p.psi, lower: p.lower, upper: p.upper }))
        : gradientEffects.length
          ? responseCurve(gradientEffects, name, rawVals)
          : [];
    };

    const pred = gradientV?.pred ?? null;
    const grid = gradientV?.grid ?? null;
    const psiName = pred?.artifactPath
      ? nodePath.basename(pred.artifactPath).replace(/\.png$/i, "")
      : null;

    // Assembled coefficient table: ψ (state) rows tagged by which variant they
    // came from, plus ONE detection block (identical across variants).
    const tableEffects: SpeciesModelDetail["effects"] = [];
    const pushState = (
      v: typeof gradientV,
      variant: string | null,
    ) => {
      if (!v) return;
      for (const e of v.effectRows) {
        if (e.submodel === "state") {
          tableEffects.push({
            submodel: e.submodel, param: e.param, estimate: e.estimate,
            se: e.se, z: e.z, pValue: e.pValue, variant,
          });
        }
      }
    };
    pushState(gradientV, gradientV?.row.variant ?? null);
    if (habitatV && habitatV.row.id !== gradientV?.row.id) pushState(habitatV, habitatV.row.variant);
    const detSource = habitatV?.row.id === preferred?.id ? habitatV : gradientV;
    for (const e of detSource?.effectRows ?? []) {
      if (e.submodel === "det") {
        tableEffects.push({
          submodel: e.submodel, param: e.param, estimate: e.estimate,
          se: e.se, z: e.z, pValue: e.pValue, variant: null,
        });
      }
    }

    const firstReason = (json: string | null): string | null => {
      if (!json) return null;
      try {
        const parsed = JSON.parse(json);
        return Array.isArray(parsed) && parsed.length ? String(parsed[0]) : null;
      } catch {
        return null;
      }
    };
    const bestAic = preferred?.aic ?? null;
    const variants: VariantSummary[] = rows.map((r) => ({
      variant: r.variant,
      aic: r.aic,
      deltaAic: r.sufficientData && r.aic != null && bestAic != null ? r.aic - bestAic : null,
      identifiable: r.sufficientData,
      reason: r.sufficientData ? null : firstReason(r.ineligibleReasonsJson),
      psiFormula: r.psiFormula,
    }));

    // Covariates dropped from the preferred (eligible) model — surfaced so a
    // reduced ψ~1 model is visibly reduced.
    let droppedCovariates: { name: string; reason: string }[] = [];
    if (preferred?.droppedCovariatesJson) {
      try {
        const parsed = JSON.parse(preferred.droppedCovariatesJson);
        if (Array.isArray(parsed)) droppedCovariates = parsed;
      } catch {
        droppedCovariates = [];
      }
    }

    // Sampling points = the deployment locations in THIS species' cohort. The
    // per-run snapshot holds the whole stream pool (synthetic seed + real), so
    // split by the OCC-SEED marker and pick the group whose size matches the
    // model's n_sites (cohort isolation put the species in exactly one group).
    const sitePts = db.all(sql`
      SELECT sc.site_id AS siteId, sc.site_name AS siteName,
             sc.latitude AS lat, sc.longitude AS lng,
             sc.habitat AS habitat, sc.elevation AS elevation,
             sc.forest_cover AS forestCover,
             (d.name LIKE 'OCC-SEED-%') AS synthetic
      FROM occupancy_site_covariates sc
      JOIN biochoco_deployments d ON d.id = CAST(sc.site_id AS INTEGER)
      WHERE sc.run_id = ${runId} AND sc.stream = ${stream}
        AND sc.latitude IS NOT NULL AND sc.longitude IS NOT NULL
    `) as {
      siteId: string;
      siteName: string | null;
      lat: number;
      lng: number;
      habitat: string | null;
      elevation: number | null;
      forestCover: number | null;
      synthetic: number;
    }[];
    const synth = sitePts.filter((p) => p.synthetic);
    const real = sitePts.filter((p) => !p.synthetic);
    const cohort =
      synth.length === baseRow.nSites ? synth : real.length === baseRow.nSites ? real : sitePts;
    const sites = cohort.map((p) => ({
      siteId: p.siteId,
      siteName: p.siteName,
      lat: p.lat,
      lng: p.lng,
      habitat: p.habitat,
      elevation: p.elevation,
      forestCover: p.forestCover,
    }));

    return {
      success: true,
      data: {
        species: baseRow.species,
        stream: baseRow.stream,
        // Headline numbers come from the AIC-preferred variant (null when no
        // variant is identifiable — the page then shows the insufficient state).
        estimatedOccupancy: preferred?.estimatedOccupancy ?? null,
        occupancyLower: preferred?.occupancyLower ?? null,
        occupancyUpper: preferred?.occupancyUpper ?? null,
        meanDetection: preferred?.meanDetection ?? null,
        naiveOccupancy: baseRow.naiveOccupancy,
        nSites: baseRow.nSites,
        nSitesDetected: baseRow.nSitesDetected,
        totalDetections: baseRow.totalDetections,
        nOccasions: baseRow.nOccasions,
        aic: preferred?.aic ?? null,
        convergence: preferred?.convergence ?? null,
        psiFormula: preferred?.psiFormula ?? null,
        detFormula: preferred?.detFormula ?? null,
        fitSeconds: preferred?.fitSeconds ?? null,
        fittedAt,
        preferredVariant: preferred?.variant ?? null,
        variants,
        effects: tableEffects,
        droppedCovariates,
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
  /**
   * Near-ubiquitous ("casi ubicua") species: eligible but every variant separated
   * at the ψ boundary, so they carry no estimable ψ and are absent from the plots
   * above. Surfaced here (and counted per plot) so the synthesis is not silently
   * biased against the most common species.
   */
  nearUbiquitous: {
    species: string;
    stream: string;
    naiveOccupancy: number;
    nSites: number;
    nSitesDetected: number;
  }[];
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
      nearUbiquitous: [],
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
        and(
          eq(occupancyModels.runId, runId),
          eq(occupancyCovariateEffects.submodel, "state"),
          // Degenerate (non-identifiable) models are stored sufficient_data=0;
          // keep their ±∞ slopes out of the cross-species forest plot.
          eq(occupancyModels.sufficientData, true),
        ),
      );

    // Per-coefficient backstop: even in a kept (identifiable) model a single
    // factor level can separate (e.g. a habitat with zero detections → ±20
    // slope). Drop those individual coefficients so they don't distort the plot.
    const forestRows = slopeRows
      .filter((r) => r.param === "forest" && !isSeparated(r.estimate, r.se))
      .map((r) => ({ species: r.species, stream: r.stream, estimate: r.estimate, se: r.se }));
    const elevRows = slopeRows
      .filter((r) => r.param === "elevation" && !isSeparated(r.estimate, r.se))
      .map((r) => ({ species: r.species, stream: r.stream, estimate: r.estimate, se: r.se }));

    const preds = await db
      .select({ gridDataPath: occupancyPredictions.gridDataPath })
      .from(occupancyPredictions)
      .innerJoin(occupancyModels, eq(occupancyModels.id, occupancyPredictions.modelId))
      .where(eq(occupancyModels.runId, runId));
    const artifacts = preds
      .map((p) => readGridArtifact(p.gridDataPath))
      .filter((a): a is GridArtifact => a != null);
    const habitatOccupancy = aggregateHabitatOccupancy(
      artifacts.map((a) => a.habitatUse ?? []),
    );

    // Near-ubiquitous ("casi ubicua") species: eligible but every variant separated
    // at the ψ boundary, so they have no estimable ψ and are absent from every plot
    // below. Classify all variant rows (NOT the sufficient_data=true subset) and
    // keep the ceiling ones so the page can name + count them.
    const statusRows = await db
      .select({
        species: occupancyModels.species,
        stream: occupancyModels.stream,
        variant: occupancyModels.variant,
        sufficientData: occupancyModels.sufficientData,
        estimatedOccupancy: occupancyModels.estimatedOccupancy,
        meanDetection: occupancyModels.meanDetection,
        naiveOccupancy: occupancyModels.naiveOccupancy,
        nSites: occupancyModels.nSites,
        nSitesDetected: occupancyModels.nSitesDetected,
        aic: occupancyModels.aic,
        ineligibleReasonsJson: occupancyModels.ineligibleReasonsJson,
      })
      .from(occupancyModels)
      .where(eq(occupancyModels.runId, runId));
    const byKeyStatus = new Map<string, ModelVariantRow[]>();
    for (const r of statusRows) {
      const key = `${r.species}|${r.stream}`;
      const arr = byKeyStatus.get(key);
      if (arr) arr.push(r);
      else byKeyStatus.set(key, [r]);
    }
    const nearUbiquitous: CrossSpeciesData["nearUbiquitous"] = [];
    for (const group of byKeyStatus.values()) {
      const s = classifyModelStatus(group);
      if (s?.kind === "ceiling") {
        nearUbiquitous.push({
          species: s.species,
          stream: s.stream,
          naiveOccupancy: s.naiveOccupancy,
          nSites: s.nSites,
          nSitesDetected: s.nSitesDetected,
        });
      }
    }
    nearUbiquitous.sort((a, b) => b.naiveOccupancy - a.naiveOccupancy);

    const models = await db
      .select({
        species: occupancyModels.species,
        stream: occupancyModels.stream,
        variant: occupancyModels.variant,
        aic: occupancyModels.aic,
        estimatedOccupancy: occupancyModels.estimatedOccupancy,
        occupancyLower: occupancyModels.occupancyLower,
        occupancyUpper: occupancyModels.occupancyUpper,
      })
      .from(occupancyModels)
      .where(and(eq(occupancyModels.runId, runId), eq(occupancyModels.sufficientData, true)));

    // A species now has two identifiable variants (geo + habitat). Collapse to
    // ONE row per species×stream — the AIC-preferred variant — so the occupancy
    // plot doesn't count a species twice.
    const bySpecies = new Map<string, (typeof models)[number][]>();
    for (const m of models) {
      if (m.estimatedOccupancy == null) continue;
      const key = `${m.species}|${m.stream}`;
      const list = bySpecies.get(key);
      if (list) list.push(m);
      else bySpecies.set(key, [m]);
    }
    const preferredBySpecies = new Map<string, (typeof models)[number]>();
    for (const [key, list] of bySpecies) {
      const pref = preferredByAic(list);
      if (pref) preferredBySpecies.set(key, pref);
    }

    const overallPlot: SpeciesSlope[] = [...preferredBySpecies.values()]
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
        nearUbiquitous,
        nSpeciesModeled: preferredBySpecies.size,
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
  /** Whether the species was detected at this site (≥1 in-window detection). */
  detected: boolean;
  /** Occasions actually surveyed at this site (non-NA cells). */
  occasions: number;
  /** In-window detections at this site. */
  detections: number;
  /** 1 = detectada, 0 = revisada sin detección, null = fuera de ventana (NA). */
  cells: (0 | 1 | null)[];
  /** Continuous survey effort (active days) per occasion (null where cell is NA). */
  effort: (number | null)[];
  /** Site-level ψ covariates from the run's site-covariate snapshot (null when
   *  unresolved for this site). Forest cover is a 0..1 fraction. */
  forestCover: number | null;
  elevation: number | null;
  /** Sampling window (ISO YYYY-MM-DD) and its length — surfaced so an outlier
   *  long window (which inflates maxOccasions) is visible per site. */
  windowStart: string;
  windowEnd: string;
  totalDays: number;
  /** Link to where this site's detections are reviewed (verification grid /
   *  deployment page), stream-aware. */
  href: string;
}

export interface ModelInputSample {
  binWidth: number;
  /** Total sites in the fit cohort. */
  nSites: number;
  maxOccasions: number;
  /** Median window length across sites — baseline for the outlier flag. */
  medianTotalDays: number;
  rows: DetectionSampleRow[];
  /** Naïve occupancy by habitat (descriptive; sites with a resolved habitat). */
  habitatSummary: HabitatNaiveRow[];
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

    // Site-level ψ covariates from the latest run's snapshot, keyed by site id,
    // so each matrix row can show the forest cover + elevation that drive ψ.
    // Sites in the live cohort but missing a snapshot row degrade to null → "—".
    const covSnap = runId
      ? await db
          .select({
            siteId: occupancySiteCovariates.siteId,
            forestCover: occupancySiteCovariates.forestCover,
            elevation: occupancySiteCovariates.elevation,
            habitat: occupancySiteCovariates.habitat,
          })
          .from(occupancySiteCovariates)
          .where(
            and(
              eq(occupancySiteCovariates.runId, runId),
              eq(occupancySiteCovariates.stream, stream),
            ),
          )
      : [];
    const covBySite = new Map(covSnap.map((c) => [c.siteId, c]));

    // Naïve occupancy by habitat: the fraction of cohort sites (with ≥1
    // detection) in each habitat class. Descriptive (no model), so it still
    // answers "where does this species occur?" when the categorical habitat
    // occupancy model is non-identifiable (a species found in only one habitat
    // perfectly separates the ψ fit). Sites with an unresolved habitat are
    // omitted (all BioChoco sites are classified; the note says as much).
    const habitatBySite = new Map<string, string | null>(
      covSnap.map((c) => [c.siteId, c.habitat]),
    );
    const habitatSummary: HabitatNaiveRow[] = naiveOccupancyByHabitat(
      frame.perSite,
      habitatBySite,
    );

    const iso = (d: Date) => d.toISOString().slice(0, 10);

    // Detected sites first (most informative), then most-surveyed. No display
    // cap — every cohort site is shown so an outlier long window is visible.
    const rows: DetectionSampleRow[] = frame.perSite
      .map((p, i) => ({ p, i }))
      .sort(
        (a, b) =>
          Number(b.p.detected) - Number(a.p.detected) ||
          b.p.detections - a.p.detections ||
          b.p.occasions - a.p.occasions,
      )
      .map(({ p, i }) => ({
        siteId: p.siteId,
        siteName: p.siteName,
        detected: p.detected,
        occasions: p.occasions,
        detections: p.detections,
        cells: frame.y[i],
        effort: frame.effort[i],
        forestCover: covBySite.get(p.siteId)?.forestCover ?? null,
        elevation: covBySite.get(p.siteId)?.elevation ?? null,
        windowStart: iso(p.windowStart),
        windowEnd: iso(p.windowEnd),
        totalDays: p.totalDays,
        // siteId is the deployment id → link to the deployment detail page in
        // the module matching THIS stream: audio results link to /audio, camera
        // results to /camera-trap (both streams share the same physical
        // deployment, but the QA/exclusion controls live per module).
        href: `/${stream === "audio" ? "audio" : "camera-trap"}/${p.siteId}`,
      }));

    // Median window length across sites — the baseline the table flags outliers
    // against (a site whose window is much longer drives maxOccasions).
    const lengths = frame.perSite.map((p) => p.totalDays).sort((a, b) => a - b);
    const medianTotalDays = lengths.length
      ? lengths[Math.floor((lengths.length - 1) / 2)]
      : 0;

    return {
      success: true,
      data: {
        binWidth,
        nSites: frame.siteIds.length,
        maxOccasions: frame.maxOccasions,
        medianTotalDays,
        rows,
        habitatSummary,
      },
    };
  } catch (error) {
    log.error({ err: error, species, stream }, "getModelInputSample failed");
    return { success: false, error: "No se pudo obtener la muestra de datos del modelo." };
  }
}
