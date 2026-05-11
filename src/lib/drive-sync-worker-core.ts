import "server-only";

import pLimit from "p-limit";
import { db } from "@/db";
import { processingJobs, type ProcessingJob } from "@/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { touchAppState } from "@/lib/app-state";
import { log } from "@/lib/log";

const DEFAULT_CONCURRENCY = 8;
const MAX_CONCURRENCY = 32;
const PROGRESS_TICK_MS = 1500;

function readConcurrency(envKey: string): number {
  const raw = process.env[envKey] ?? process.env.DRIVE_SYNC_CONCURRENCY;
  if (!raw) return DEFAULT_CONCURRENCY;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0
    ? Math.min(n, MAX_CONCURRENCY)
    : DEFAULT_CONCURRENCY;
}

/** Signal passed to discover/afterAll hooks so they can poll for cancellation. */
export interface SyncSignal {
  isCancelled: () => Promise<boolean>;
}

export interface DiscoverResult {
  /** IDs of deployment rows newly created during discovery. Forwarded to
   *  afterAll so module-specific post-processing (e.g. ODK match) can target
   *  just the new rows. */
  createdIds: number[];
  /** If set, the worker skips the fan-out + afterAll phases and finalises
   *  immediately with this status message. Used for "nothing to do" cases
   *  (e.g. admin hasn't configured any Drive folders yet). */
  earlyComplete?: { statusMessage: string };
}

export interface DriveSyncWorkerConfig<TDeployment> {
  /** Marker matched against `processingJobs.jobType`; jobs with a different
   *  type are refused so each module's worker handles only its own work. */
  jobType: string;

  /** Short tag used in log lines (e.g. "drive-sync", "audio-sync"). */
  logTag: string;

  /** Path revalidated on successful completion (and on crash) so SSR pages
   *  pick up the new state. */
  revalidatePath: string;

  /** `app_state` key touched on successful completion (last-sync timestamp). */
  lastSyncStateKey: string;

  /** Env var name for per-module concurrency override. Falls back to
   *  `DRIVE_SYNC_CONCURRENCY` then to {@link DEFAULT_CONCURRENCY}. */
  concurrencyEnvKey?: string;

  /** Optional discovery phase. Runs before the fan-out scan and may auto-
   *  create deployment rows from external state (e.g. Drive folders). */
  discover?: (job: ProcessingJob, signal: SyncSignal) => Promise<DiscoverResult>;

  /** Load all deployments this job should scan. Called after discovery. */
  listDeployments: (job: ProcessingJob) => Promise<TDeployment[]>;

  /** Per-deployment scan work. Throw to mark the deployment as failed; the
   *  fan-out continues with the others. The core handles cancellation
   *  before each invocation. */
  scanOne: (deployment: TDeployment) => Promise<void>;

  /** Optional post-fan-out hook (e.g. ODK match for newly-created rows). */
  afterAll?: (createdIds: number[], signal: SyncSignal) => Promise<void>;
}

/**
 * Run a Drive-style sync job to completion.
 *
 * Phases:
 *   1. (optional) discovery — auto-create deployment rows from external state
 *   2. load all in-scope deployments
 *   3. parallel fan-out (p-limit) — call `scanOne` per deployment
 *   4. (optional) afterAll — module-specific post-processing for new rows
 *   5. touch app-state last-sync key, mark job completed
 *
 * Fire-and-forget: this function never throws to the caller. All terminal
 * states are persisted to the `processingJobs` row.
 */
export async function runDriveSyncWorkerGeneric<TDeployment>(
  jobId: number,
  config: DriveSyncWorkerConfig<TDeployment>
): Promise<void> {
  const startMs = Date.now();
  const concurrency = readConcurrency(
    config.concurrencyEnvKey ?? "DRIVE_SYNC_CONCURRENCY"
  );
  const tag = `[${config.logTag}]`;

  const safeRevalidate = () => {
    try {
      revalidatePath(config.revalidatePath);
    } catch {
      // Worker context — client polls for updates
    }
  };

  const isCancelled = async (): Promise<boolean> => {
    const [j] = await db
      .select({ status: processingJobs.status })
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId));
    return !j || j.status === "cancelled";
  };

  const setStatus = async (
    patch: Partial<{
      status: "pending" | "processing" | "completed" | "failed" | "cancelled";
      statusMessage: string | null;
      errorMessage: string | null;
      totalImages: number;
      processedImages: number;
      failedImages: number;
      startedAt: Date;
      completedAt: Date;
    }>
  ) => {
    await db
      .update(processingJobs)
      .set(patch)
      .where(eq(processingJobs.id, jobId));
  };

  const finalize = async (
    status: "completed" | "cancelled" | "failed",
    message: string,
    processed?: number,
    failed?: number
  ) => {
    const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
    log.info({ jobId, status, elapsedSec }, `${tag} done`);
    await db
      .update(processingJobs)
      .set({
        status,
        completedAt: new Date(),
        statusMessage: message,
        ...(processed != null
          ? { processedImages: processed + (failed ?? 0) }
          : {}),
        ...(failed != null ? { failedImages: failed } : {}),
      })
      .where(eq(processingJobs.id, jobId));
  };

  try {
    const [job] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId));

    if (!job) {
      log.error({ jobId }, `${tag} Job row not found`);
      return;
    }

    if (job.jobType !== config.jobType) {
      log.error(
        { jobId, jobType: job.jobType, expected: config.jobType },
        `${tag} Wrong job type`
      );
      return;
    }

    log.info(
      { jobId, scope: job.cameraTrapProjectId ?? "all", concurrency },
      `${tag} starting`
    );

    await setStatus({
      status: "processing",
      startedAt: new Date(),
      statusMessage: "Buscando...",
    });

    // ---- Phase 1: discovery (optional) ----
    let createdIds: number[] = [];
    if (config.discover) {
      if (await isCancelled()) {
        await finalize("cancelled", "Cancelado durante descubrimiento");
        safeRevalidate();
        return;
      }
      try {
        const result = await config.discover(job, { isCancelled });
        createdIds = result.createdIds;
        if (result.earlyComplete) {
          await finalize("completed", result.earlyComplete.statusMessage);
          safeRevalidate();
          return;
        }
      } catch (err) {
        log.error({ err, jobId }, `${tag} discovery failed`);
      }
    }

    // ---- Phase 2: load deployments ----
    const allDeps = await config.listDeployments(job);
    const total = allDeps.length;

    await setStatus({
      totalImages: total,
      processedImages: 0,
      statusMessage: `Sincronizando 0 de ${total} instalaciones`,
    });

    log.info(
      { jobId, total, created: createdIds.length },
      `${tag} discovery complete; starting fan-out`
    );

    // ---- Phase 3: parallel fan-out ----
    const limit = pLimit(concurrency);
    let processed = 0;
    let failed = 0;
    let skipped = 0;
    let lastProgressUpdate = 0;

    await Promise.allSettled(
      allDeps.map((dep) =>
        limit(async () => {
          if (await isCancelled()) {
            skipped++;
            return;
          }
          let succeeded = false;
          try {
            await config.scanOne(dep);
            succeeded = true;
          } catch (err) {
            log.warn(
              { err, depId: (dep as { id?: number }).id },
              `${tag} deployment task failed`
            );
          } finally {
            if (succeeded) processed++;
            else failed++;
            const completed = processed + failed;
            const now = Date.now();
            if (
              now - lastProgressUpdate > PROGRESS_TICK_MS ||
              completed + skipped === total
            ) {
              lastProgressUpdate = now;
              const elapsedSec = (now - startMs) / 1000;
              const rate = completed / Math.max(elapsedSec, 0.001);
              const remaining = Math.max(total - completed - skipped, 0);
              const etaSec = rate > 0 ? remaining / rate : 0;
              log.info(
                {
                  jobId,
                  processed,
                  failed,
                  total,
                  totalElapsed: `${elapsedSec.toFixed(1)}s`,
                  etaSec: `${etaSec.toFixed(0)}s`,
                  rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
                },
                `${tag} progress`
              );
              await setStatus({
                processedImages: completed,
                failedImages: failed,
                statusMessage: `Sincronizando ${completed} de ${total} instalaciones`,
              });
            }
          }
        })
      )
    );

    // ---- Phase 4: afterAll (optional) ----
    if (config.afterAll && createdIds.length > 0 && !(await isCancelled())) {
      await setStatus({
        statusMessage: `Procesando ${createdIds.length} nuevas...`,
      });
      try {
        await config.afterAll(createdIds, { isCancelled });
      } catch (err) {
        log.error({ err, jobId }, `${tag} afterAll failed`);
      }
    }

    // ---- Phase 5: finalize ----
    const cancelled = await isCancelled();
    if (!cancelled) {
      try {
        await touchAppState(config.lastSyncStateKey);
      } catch (err) {
        log.warn({ err }, `${tag} touchAppState failed`);
      }
    }

    const finalMsg = cancelled
      ? "Cancelado"
      : failed > 0
        ? `Completado: ${processed} ok, ${failed} con errores, ${createdIds.length} nuevas`
        : `Completado: ${processed} de ${total}, ${createdIds.length} nuevas`;

    await finalize(
      cancelled ? "cancelled" : "completed",
      finalMsg,
      processed,
      failed
    );
    safeRevalidate();
  } catch (err) {
    log.error({ err, jobId }, `${tag} worker crashed`);
    await db
      .update(processingJobs)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorMessage: err instanceof Error ? err.message : "Error desconocido",
        statusMessage: "Error en sincronización",
      })
      .where(eq(processingJobs.id, jobId));
    safeRevalidate();
  }
}

export interface TerminalJobState {
  status: string;
  statusMessage: string | null;
  processedImages: number;
  failedImages: number;
  totalImages: number;
  errorMessage: string | null;
}

/**
 * Block until the job reaches a terminal state, returning the final row.
 * Used by the cron route which needs to send an email after completion.
 *
 * Returns null on timeout or if the job row disappears.
 */
export async function awaitJobTerminal(
  jobId: number,
  options: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<TerminalJobState | null> {
  const intervalMs = options.intervalMs ?? 5_000;
  const timeoutMs = options.timeoutMs ?? 540_000;
  const startMs = Date.now();

  while (Date.now() - startMs < timeoutMs) {
    const [job] = await db
      .select({
        status: processingJobs.status,
        statusMessage: processingJobs.statusMessage,
        processedImages: processingJobs.processedImages,
        failedImages: processingJobs.failedImages,
        totalImages: processingJobs.totalImages,
        errorMessage: processingJobs.errorMessage,
      })
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId));

    if (!job) return null;
    if (
      job.status === "completed" ||
      job.status === "failed" ||
      job.status === "cancelled"
    ) {
      return job;
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  return null;
}
