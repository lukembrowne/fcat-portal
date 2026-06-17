/**
 * Pure eligibility + time-window logic for the overnight audio batch processor.
 *
 * Deliberately free of DB / Drive / server imports so it can be unit-tested
 * directly and imported anywhere (incl. the job queue). The DB-querying selector
 * and the enqueue driver live in `src/lib/audio-batch.ts`.
 *
 * Plan: docs/plans/2026-06-17-feat-overnight-batch-audio-processing-plan.md
 */

/** Sentinel written to `processing_jobs.created_by` for batch-enqueued rows.
 * The queue picker uses it to gate batch jobs to the night window without ever
 * touching manual (user-email / NULL createdBy) jobs. */
export const BATCH_CREATED_BY = "cron@batch";

/** A deployment's newest audio file must be at least this old for it to count
 * as "settled" (done uploading). Single fixed value (no range) — see plan. */
export const SETTLE_QUIET_HOURS = 24;

/**
 * True when `now` falls inside the 10pm–6am Ecuador (UTC−5, no DST) window.
 *
 * Computed from UTC with a fixed −5 offset so it is independent of the
 * container's `America/New_York` clock (which shifts under US daylight saving).
 * The window crosses midnight, so the predicate is `hour >= 22 || hour < 6`.
 */
export function isWithinEcuadorNightWindow(now: Date): boolean {
  const ecuadorHour = (now.getUTCHours() - 5 + 24) % 24;
  return ecuadorHour >= 22 || ecuadorHour < 6;
}

/** Subset of deployment fields the eligibility predicate needs. */
export interface AudioBatchCandidate {
  id: number;
  uploadAudioFolderId: string | null;
  audioFileCount: number;
  /** Count of birdnet/acoustic_indices/audio_analysis jobs pending|processing. */
  isBirdnetProcessing: number;
  /**
   * MAX(completed_at) of birdnet/audio_analysis jobs as **Unix SECONDS** (or
   * null if never processed). This comes from a hand-written aggregate
   * subquery, so Drizzle's `mode:"timestamp"` seconds→Date codec does NOT run —
   * it is a number at runtime, not a Date.
   * See gotcha_drizzle_timestamp_seconds_raw_scripts.
   */
  lastBirdnetAtSeconds: number | null;
  uploadAudioCount: number | null;
  previousAudioCount: number | null;
  /** Drive `modifiedTime` (RFC-3339 string) of the newest audio file, or null. */
  uploadNewestAudioDate: string | null;
  excluded: boolean;
}

export type IneligibleReason =
  | "excluded"
  | "no_audio"
  | "in_flight"
  | "already_processed"
  | "null_counts"
  | "unsettled";

export type BatchEligibility =
  | { eligible: true; deploymentId: number; audioFolderId: string; cachedAudioCount: number }
  | { eligible: false; deploymentId: number; reason: IneligibleReason };

/**
 * Decide whether a deployment is eligible for overnight BirdNET + indices.
 * Pure — pass `nowMs` so tests are deterministic.
 *
 * v1 scope: NEVER-PROCESSED deployments only (`lastBirdnetAtSeconds == null`).
 * Reprocessing deployments that gained files after analysis is deferred to a
 * later phase (it needs write-then-swap detection deletion to stay data-safe),
 * so an already-analyzed deployment is reported `already_processed`.
 */
export function evaluateAudioBatchEligibility(
  c: AudioBatchCandidate,
  nowMs: number,
): BatchEligibility {
  const no = (reason: IneligibleReason): BatchEligibility => ({
    eligible: false,
    deploymentId: c.id,
    reason,
  });

  if (c.excluded) return no("excluded");
  if (!c.uploadAudioFolderId || c.audioFileCount === 0) return no("no_audio");
  if (c.isBirdnetProcessing !== 0) return no("in_flight");

  // Already analyzed at least once → out of v1 scope (reprocess is a later phase).
  if (c.lastBirdnetAtSeconds != null) return no("already_processed");

  // Settled check needs both count snapshots and a parseable newest-file date.
  if (c.uploadAudioCount == null || c.previousAudioCount == null) {
    return no("null_counts");
  }
  const parsed = c.uploadNewestAudioDate ? new Date(c.uploadNewestAudioDate) : null;
  const newestMs = parsed && !Number.isNaN(parsed.getTime()) ? parsed.getTime() : null;
  if (newestMs == null) return no("null_counts");

  const countStable = c.uploadAudioCount === c.previousAudioCount;
  const quiet = (nowMs - newestMs) / 3_600_000 >= SETTLE_QUIET_HOURS;
  if (!(countStable && quiet)) return no("unsettled");

  return {
    eligible: true,
    deploymentId: c.id,
    audioFolderId: c.uploadAudioFolderId,
    cachedAudioCount: c.uploadAudioCount,
  };
}
