/**
 * Overnight audio batch — server-only selector + auth-agnostic enqueue + driver.
 *
 * Pairs with the pure logic in `audio-batch-eligibility.ts`. Called by the
 * `/api/cron/nightly-batch` route (and, later, an admin "process now" trigger).
 *
 * Auth-agnostic by design: it must run from cron, which has no user request
 * context. That's why it lives here and NOT in `src/app/audio/actions.ts` (a
 * `"use server"` module whose exports become client-callable server actions).
 *
 * Plan: docs/plans/2026-06-17-feat-overnight-batch-audio-processing-plan.md
 */

import "server-only";

import { db } from "@/db";
import { deployments, processingJobs, audioFiles } from "@/db/schema";
import { eq, isNotNull, sql } from "drizzle-orm";
import { JOB_TYPES } from "@/lib/job-types";
import { findActiveAudioJob } from "@/lib/job-locks";
import { processNextQueueable } from "@/lib/job-queue";
import { countAudioFilesInFolder } from "@/lib/drive-client";
import { recordEvent } from "@/lib/system-events";
import { log } from "@/lib/log";
import {
  BATCH_CREATED_BY,
  evaluateAudioBatchEligibility,
  type AudioBatchCandidate,
  type BatchEligibility,
  type IneligibleReason,
} from "@/lib/audio-batch-eligibility";

type EligibleDeployment = { deploymentId: number; audioFolderId: string; cachedAudioCount: number };
type Ineligible = Extract<BatchEligibility, { eligible: false }>;

/**
 * Query all audio deployments and split them into eligible (never-processed +
 * settled, oldest-data-first) and ineligible-with-reason. Pure evaluation runs
 * on cached DB state; the caller re-counts each eligible folder live before
 * enqueuing.
 */
export async function selectBatchEligibleAudioDeployments(): Promise<{
  eligible: EligibleDeployment[];
  ineligible: Ineligible[];
}> {
  const rows = await db
    .select({
      id: deployments.id,
      uploadAudioFolderId: deployments.uploadAudioFolderId,
      uploadAudioCount: deployments.uploadAudioCount,
      previousAudioCount: deployments.previousAudioCount,
      uploadNewestAudioDate: deployments.uploadNewestAudioDate,
      excluded: deployments.excluded,
      audioFileCount: sql<number>`(
        SELECT COUNT(*) FROM audio_files
        WHERE audio_files.deployment_id = ${deployments.id}
      )`,
      isBirdnetProcessing: sql<number>`(
        SELECT COUNT(*) FROM biochoco_processing_jobs
        WHERE deployment_id = ${deployments.id}
        AND job_type IN ('birdnet', 'acoustic_indices', 'audio_analysis')
        AND status IN ('pending', 'processing')
      )`,
      // Unix SECONDS (raw aggregate — Drizzle's timestamp codec does not run).
      lastBirdnetAtSeconds: sql<number | null>`(
        SELECT MAX(completed_at) FROM biochoco_processing_jobs
        WHERE deployment_id = ${deployments.id}
        AND job_type IN ('birdnet', 'audio_analysis') AND status = 'completed'
      )`,
    })
    .from(deployments)
    .where(isNotNull(deployments.uploadAudioFolderId))
    // Oldest data first (stable id tiebreaker). Enqueue order = queue pick order.
    .orderBy(deployments.dateStart, deployments.id);

  const nowMs = Date.now();
  const eligible: EligibleDeployment[] = [];
  const ineligible: Ineligible[] = [];
  for (const r of rows) {
    const verdict = evaluateAudioBatchEligibility(r as AudioBatchCandidate, nowMs);
    if (verdict.eligible) {
      eligible.push({
        deploymentId: verdict.deploymentId,
        audioFolderId: verdict.audioFolderId,
        cachedAudioCount: verdict.cachedAudioCount,
      });
    } else {
      ineligible.push(verdict);
    }
  }
  return { eligible, ineligible };
}

/**
 * Auth-agnostic enqueue of a combined `audio_analysis` job (BirdNET + indices).
 * Keeps the per-deployment single-flight guard. Does NOT kick the queue — the
 * driver kicks once after enqueuing all candidates.
 */
export async function enqueueAudioAnalysisInternal(input: {
  deploymentId: number;
  createdBy: string;
}): Promise<{ jobId: number } | { skipped: "active" | "no_files" }> {
  const { deploymentId, createdBy } = input;

  const active = await findActiveAudioJob(deploymentId);
  if (active) return { skipped: "active" };

  const [fileRow] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(audioFiles)
    .where(eq(audioFiles.deploymentId, deploymentId));
  if ((fileRow?.count ?? 0) === 0) return { skipped: "no_files" };

  const [job] = await db
    .insert(processingJobs)
    .values({
      deploymentId,
      jobType: JOB_TYPES.AUDIO_ANALYSIS,
      totalImages: fileRow?.count ?? 0,
      status: "pending",
      createdBy,
      statusMessage: "En cola (lote nocturno)...",
      compressFirst: false,
    })
    .returning();

  return { jobId: job.id };
}

export interface NightlyBatchResult {
  candidates: number;
  enqueued: number;
  skippedUploading: number;
  skippedOther: number;
  durationMs: number;
}

function tallyReasons(ineligible: Ineligible[]): Partial<Record<IneligibleReason, number>> {
  const out: Partial<Record<IneligibleReason, number>> = {};
  for (const i of ineligible) out[i.reason] = (out[i.reason] ?? 0) + 1;
  return out;
}

/**
 * Driver: select eligible deployments, re-count each one's Drive folder live
 * (skip any whose count changed — actively uploading), enqueue the rest as
 * `cron@batch` audio_analysis rows, then kick the queue once. The queue drains
 * the rows overnight; the picker's window gate stops starting new batch jobs
 * after 6am (the running one overruns to completion).
 *
 * Always kicks the queue at the end (even with 0 newly enqueued) so leftover
 * pending `cron@batch` rows from a prior night resume inside the window.
 */
export async function runNightlyAudioBatch(): Promise<NightlyBatchResult> {
  const start = Date.now();
  const { eligible, ineligible } = await selectBatchEligibleAudioDeployments();

  let enqueued = 0;
  let skippedUploading = 0;
  let skippedOther = ineligible.length;

  for (const cand of eligible) {
    let liveCount: number;
    try {
      liveCount = await countAudioFilesInFolder(cand.audioFolderId);
    } catch (err) {
      log.warn(
        { err, deploymentId: cand.deploymentId },
        "[nightly-batch] live re-count failed — skipping tonight",
      );
      skippedUploading++;
      continue;
    }

    // Count changed since the cached snapshot ⇒ actively being uploaded. Refresh
    // the cached count so tomorrow's settled check uses fresh truth, then skip.
    if (liveCount !== cand.cachedAudioCount) {
      await db
        .update(deployments)
        .set({ uploadAudioCount: liveCount, uploadCountsCheckedAt: new Date() })
        .where(eq(deployments.id, cand.deploymentId));
      log.info(
        { deploymentId: cand.deploymentId, cached: cand.cachedAudioCount, liveCount },
        "[nightly-batch] skip — upload in progress",
      );
      skippedUploading++;
      continue;
    }

    const res = await enqueueAudioAnalysisInternal({
      deploymentId: cand.deploymentId,
      createdBy: BATCH_CREATED_BY,
    });
    if ("jobId" in res) {
      enqueued++;
      log.info(
        { deploymentId: cand.deploymentId, jobId: res.jobId },
        "[nightly-batch] enqueued audio_analysis",
      );
    } else {
      skippedOther++;
    }
  }

  // Kick unconditionally: starts freshly-enqueued rows AND resumes any leftover
  // pending cron@batch rows from a prior night now that we're in the window.
  void processNextQueueable().catch((err) =>
    log.error({ err }, "[nightly-batch] queue advance failed"),
  );

  const durationMs = Date.now() - start;
  const result: NightlyBatchResult = {
    candidates: eligible.length,
    enqueued,
    skippedUploading,
    skippedOther,
    durationMs,
  };

  await recordEvent({
    source: "cron",
    eventType: "cron_nightly_batch",
    severity: enqueued === 0 && eligible.length > 0 ? "warn" : "success",
    summary: `Lote nocturno de audio: ${enqueued} encolados, ${skippedUploading} en subida, ${skippedOther} omitidos`,
    durationMs,
    details: { ...result, ineligibleReasons: tallyReasons(ineligible) },
  });

  log.info(result, "[nightly-batch] run complete");
  return result;
}
