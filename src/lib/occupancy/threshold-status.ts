/**
 * Reads the BirdNET-threshold provenance of the latest completed occupancy run.
 *
 * Two questions, one source, so the occupancy page and the validation page can
 * never disagree about which filter a model was fitted through:
 *
 *   - which per-species thresholds did the run actually use? (its snapshot)
 *   - do they still match what the portal applies today? (drift)
 *
 * The comparison itself is pure and lives in `threshold-drift.ts`.
 */

import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import { occupancyModels, occupancyRuns, processingJobs } from "@/db/schema";
import { JOB_TYPES } from "@/lib/job-types";
import {
  loadActiveSpeciesThresholdRows,
  loadActiveSpeciesThresholds,
  type ActiveThreshold,
} from "@/lib/birdnet-validation/threshold-map";
import {
  diffSpeciesThresholds,
  parseRunSpeciesThresholds,
  speciesThresholdChanged,
  thresholdFor,
  type ThresholdChange,
} from "./threshold-drift";

export interface RunThresholdContext {
  runId: number;
  completedAt: Date | null;
  /** The run's global audio cut-off — what a species with no applied threshold got. */
  globalThreshold: number;
  binWidthDays: number;
  /** Per-species thresholds in force when the run read its audio detections. */
  atRun: Map<string, number>;
}

/** The latest completed run plus the filter it read audio through. */
export async function loadRunThresholdContext(
  runId?: number,
): Promise<RunThresholdContext | null> {
  const [run] = runId
    ? await db
        .select()
        .from(occupancyRuns)
        .where(eq(occupancyRuns.id, runId))
        .limit(1)
    : await db
        .select()
        .from(occupancyRuns)
        .where(eq(occupancyRuns.status, "completed"))
        .orderBy(desc(occupancyRuns.completedAt))
        .limit(1);
  if (!run) return null;
  return {
    runId: run.id,
    completedAt: run.completedAt ?? null,
    globalThreshold: run.audioConfidenceThreshold,
    binWidthDays: run.binWidthDays,
    atRun: parseRunSpeciesThresholds(run.speciesThresholdsJson),
  };
}

export interface OccupancyThresholdDrift {
  runId: number;
  completedAt: Date | null;
  changes: ThresholdChange[];
}

/**
 * Species whose applied threshold changed since the latest completed run — the
 * set whose fitted models no longer match the data the portal would feed them.
 *
 * Deliberately NOT restricted to species that were modeled: a threshold that
 * newly keeps thousands of detections is exactly how an unmodelable species
 * becomes modelable, and dropping it from the list would hide the most
 * consequential case.
 */
export async function loadOccupancyThresholdDrift(): Promise<OccupancyThresholdDrift | null> {
  const ctx = await loadRunThresholdContext();
  if (!ctx) return null;
  const now = await loadActiveSpeciesThresholds();
  return {
    runId: ctx.runId,
    completedAt: ctx.completedAt,
    changes: diffSpeciesThresholds(ctx.atRun, now),
  };
}

export interface SpeciesThresholdProvenance {
  /** The run whose models are on screen. */
  runId: number;
  runCompletedAt: Date | null;
  /** Global cut-off the run used for species with no applied threshold. */
  globalThreshold: number;
  /** Applied threshold at fit time; null = the run used the global one. */
  atRun: number | null;
  /** Applied threshold now; null = the species falls back to the global one. */
  now: number | null;
  /** Where today's threshold came from; null when there is none applied. */
  nowSource: string | null;
  /** True when the two differ — the model predates the current decision. */
  stale: boolean;
}

/** What filter produced this species' audio model, and is it still current. */
export async function loadSpeciesThresholdProvenance(
  species: string,
): Promise<SpeciesThresholdProvenance | null> {
  const ctx = await loadRunThresholdContext();
  if (!ctx) return null;
  const rows = await loadActiveSpeciesThresholdRows();
  const active: ActiveThreshold | undefined = rows.get(species);
  const now = await loadActiveSpeciesThresholds();
  return {
    runId: ctx.runId,
    runCompletedAt: ctx.completedAt,
    globalThreshold: ctx.globalThreshold,
    atRun: thresholdFor(ctx.atRun, species),
    now: active?.threshold ?? null,
    nowSource: active?.source ?? null,
    stale: speciesThresholdChanged(ctx.atRun, now, species),
  };
}

export interface SpeciesOccupancyStatus extends SpeciesThresholdProvenance {
  /** Whether the run produced an audio model for this species at all. */
  hasAudioModel: boolean;
  /** A batch is already queued or running — the stale state is being fixed. */
  runInProgress: boolean;
}

/** Is an occupancy batch pending or processing right now? */
export async function isOccupancyRunActive(): Promise<boolean> {
  const [job] = await db
    .select({ id: processingJobs.id })
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.jobType, JOB_TYPES.OCCUPANCY_MODEL),
        inArray(processingJobs.status, ["pending", "processing"]),
      ),
    )
    .limit(1);
  return !!job;
}

/**
 * The validation page's view: the same provenance, plus whether an audio model
 * exists to be out of date. A species with no model still gets the notice —
 * applying a threshold is often what makes it eligible, and "no model yet" plus
 * "the run predates your decision" is the same call to action.
 */
export async function loadSpeciesOccupancyStatus(
  species: string,
): Promise<SpeciesOccupancyStatus | null> {
  const provenance = await loadSpeciesThresholdProvenance(species);
  if (!provenance) return null;
  const [[model], runInProgress] = await Promise.all([
    db
      .select({ id: occupancyModels.id })
      .from(occupancyModels)
      .where(
        and(
          eq(occupancyModels.runId, provenance.runId),
          eq(occupancyModels.species, species),
          eq(occupancyModels.stream, "audio"),
          eq(occupancyModels.sufficientData, true),
        ),
      )
      .limit(1),
    isOccupancyRunActive(),
  ]);
  return { ...provenance, hasAudioModel: !!model, runInProgress };
}
