/**
 * Unified processing-job queue across camera-trap ML and audio jobs.
 *
 * One queue, one running job at a time across the whole portal. Picks the
 * oldest `pending` row of a queueable type and dispatches it to the right
 * processor. Atomic claim prevents two finishers from launching the same row.
 *
 * Same-deployment mutex (enforced at enqueue in `findActiveAudioJob` and the
 * camera-trap equivalent) is independent from this queue — it rejects the
 * second click on the same deployment regardless of queue state.
 *
 * `drive_sync` is intentionally excluded: it's lightweight metadata work and
 * blocking it behind a multi-hour ML run would be painful. `audio_sync` is
 * INCLUDED per the "all audio jobs serialize" requirement; if that becomes
 * annoying, remove it here — the rest of the wiring is unchanged.
 */

import "server-only";

import { db } from "@/db";
import { processingJobs, type ProcessingJob } from "@/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { JOB_TYPES, type JobType } from "@/lib/job-types";
import { log } from "@/lib/log";

export const QUEUEABLE_JOB_TYPES = [
  JOB_TYPES.ML,
  JOB_TYPES.ML_INCREMENTAL,
  JOB_TYPES.COMPRESSION,
  JOB_TYPES.REVERT_COMPRESSION,
  JOB_TYPES.BIRDNET,
  JOB_TYPES.ACOUSTIC_INDICES,
  JOB_TYPES.AUDIO_ANALYSIS,
  JOB_TYPES.AUDIO_COMPRESSION,
  JOB_TYPES.REVERT_AUDIO_COMPRESSION,
  JOB_TYPES.AUDIO_SYNC,
] as const satisfies readonly JobType[];

const QUEUEABLE_SET = new Set<string>(QUEUEABLE_JOB_TYPES);

export function isQueueable(jobType: string): boolean {
  return QUEUEABLE_SET.has(jobType);
}

/**
 * Atomic claim: flip a row from `pending` to `processing` only if it's still
 * pending. Returns true if THIS caller won; false means the row was already
 * claimed (or no longer exists / not pending).
 *
 * Implementation note: `db.update(...).run()` returns a SQLite
 * `{ changes: number }` result. The WHERE clause includes `status = pending`,
 * so the UPDATE either flips exactly one row or zero. No race.
 */
export async function tryClaimJob(jobId: number): Promise<boolean> {
  const result = await db
    .update(processingJobs)
    .set({
      status: "processing",
      startedAt: new Date(),
      statusMessage: sql`COALESCE(${processingJobs.statusMessage}, 'Iniciando...')`,
    })
    .where(
      and(
        eq(processingJobs.id, jobId),
        eq(processingJobs.status, "pending"),
      ),
    );
  // drizzle-orm/better-sqlite3 returns { changes: number, lastInsertRowid }
  const changes = (result as unknown as { changes: number }).changes ?? 0;
  return changes > 0;
}

/** True iff any queueable job is currently in `processing`. */
export async function isQueueBusy(): Promise<boolean> {
  const [row] = await db
    .select({ id: processingJobs.id })
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.status, "processing"),
        inArray(processingJobs.jobType, [...QUEUEABLE_JOB_TYPES]),
      ),
    )
    .limit(1);
  return !!row;
}

/**
 * Singleton-promise gate. Multiple call sites fire the picker (terminal
 * transitions, enqueues, cron, startup recovery) — without this gate, two
 * concurrent picks would both pass the "anything processing?" check, both
 * pick the same pending row, and `tryClaimJob` would reject the loser. Cheap
 * and correct, but the gate avoids the extra SELECT round-trip on the loser.
 */
let pendingPick: Promise<void> | null = null;

/**
 * Try to start the oldest pending queueable job. No-op if anything is already
 * processing or the queue is empty. Safe to call from anywhere; safe to call
 * concurrently.
 */
export async function processNextQueueable(): Promise<void> {
  if (pendingPick) return pendingPick;
  pendingPick = (async () => {
    try {
      if (await isQueueBusy()) return;

      const [next] = await db
        .select()
        .from(processingJobs)
        .where(
          and(
            eq(processingJobs.status, "pending"),
            inArray(processingJobs.jobType, [...QUEUEABLE_JOB_TYPES]),
          ),
        )
        .orderBy(processingJobs.createdAt, processingJobs.id)
        .limit(1);
      if (!next) return;

      const claimed = await tryClaimJob(next.id);
      if (!claimed) {
        log.info(
          { jobId: next.id, jobType: next.jobType },
          "[queue] Lost claim race; another picker is handling this row",
        );
        return;
      }

      log.info(
        { jobId: next.id, jobType: next.jobType, deploymentId: next.deploymentId },
        "[queue] Dispatching claimed job",
      );
      // Fire-and-forget dispatch. The processor handles its own terminal
      // transitions and re-fires the picker when it's done.
      dispatchClaimedJob(next).catch((err) => {
        log.error(
          { err, jobId: next.id, jobType: next.jobType },
          "[queue] Dispatch failed unexpectedly",
        );
      });
    } finally {
      pendingPick = null;
    }
  })();
  return pendingPick;
}

/**
 * Route a freshly-claimed job to its processor. Dynamic imports avoid
 * circular deps between camera-trap actions, audio actions, and the
 * compression core.
 *
 * Every processor below must tolerate `status='processing'` on entry — the
 * picker has already flipped the row via `tryClaimJob`. None of them should
 * re-flip; they may, however, run an additional `UPDATE ... SET startedAt`
 * or `statusMessage` to refine the in-progress view.
 */
async function dispatchClaimedJob(job: ProcessingJob): Promise<void> {
  switch (job.jobType) {
    case JOB_TYPES.ML:
    case JOB_TYPES.ML_INCREMENTAL: {
      const m = await import("@/app/camera-trap/actions");
      await m.processJobInternal(job.id);
      return;
    }
    case JOB_TYPES.COMPRESSION: {
      const m = await import("@/app/camera-trap/drive-actions");
      await m.compressJobInternal(
        job.id,
        job.deploymentId!,
        job.createdBy ?? "",
      );
      return;
    }
    case JOB_TYPES.REVERT_COMPRESSION: {
      const m = await import("@/app/camera-trap/drive-actions");
      await m.revertJobInternal(
        job.id,
        job.deploymentId!,
        job.createdBy ?? "",
      );
      return;
    }
    case JOB_TYPES.AUDIO_ANALYSIS: {
      const m = await import("@/app/audio/actions");
      await m.processAudioAnalysisJob(job.id, {
        includeBirdnet: true,
        includeIndices: true,
        compressFirst: !!job.compressFirst,
        actorEmail: job.createdBy ?? undefined,
      });
      return;
    }
    case JOB_TYPES.BIRDNET: {
      const m = await import("@/app/audio/actions");
      await m.processBirdNETJob(job.id);
      return;
    }
    case JOB_TYPES.ACOUSTIC_INDICES: {
      const m = await import("@/app/audio/actions");
      await m.processAcousticIndicesJob(job.id);
      return;
    }
    case JOB_TYPES.AUDIO_COMPRESSION: {
      const m = await import("@/lib/audio-compression-core");
      await m.processFlacCompressionJob(
        job.id,
        job.deploymentId!,
        job.createdBy ?? "",
        false,
      );
      return;
    }
    case JOB_TYPES.REVERT_AUDIO_COMPRESSION: {
      const m = await import("@/lib/audio-compression-core");
      await m.processAudioRevertJob(
        job.id,
        job.deploymentId!,
        job.createdBy ?? "",
      );
      return;
    }
    case JOB_TYPES.AUDIO_SYNC: {
      const m = await import("@/lib/audio-sync-worker");
      await m.runAudioSyncWorker(job.id);
      return;
    }
    default:
      log.warn(
        { jobId: job.id, jobType: job.jobType },
        "[queue] Unknown queueable job type — skipping",
      );
  }
}
