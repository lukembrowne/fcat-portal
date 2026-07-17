import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { processingJobs } from "@/db/schema";
import { log } from "@/lib/log";
import { claimAndEmitStart, processNextQueueable } from "@/lib/job-queue";
import { recordEvent, buildJobCompletionEvent, type JobCompletionExtras } from "@/lib/system-events";
import { runOccupancyBuild } from "./build-run";
import { computeReadinessResult } from "./readiness-compute";
import { computeReadinessFingerprint, saveReadinessSnapshot } from "./readiness-snapshot";

/**
 * Background processor for an `OCCUPANCY_MODEL` job. Runs a full occupancy build
 * (all eligible species × streams), owns its terminal transition + completion
 * event, and re-fires the queue. Mirrors the lifecycle in audio-compression-core.
 */
export async function processOccupancyJob(jobId: number): Promise<void> {
  const startTime = Date.now();

  let eventEmitted = false;
  const emitTerminalEvent = async (extras?: JobCompletionExtras) => {
    if (eventEmitted) return;
    eventEmitted = true;
    const [latest] = await db.select().from(processingJobs).where(eq(processingJobs.id, jobId));
    if (latest) await recordEvent(buildJobCompletionEvent(latest, extras));
  };

  try {
    // The queue picker already flipped the row; this is a defensive re-claim +
    // start-event emission for direct-invocation paths. Do not re-flip.
    const { job } = await claimAndEmitStart(jobId);
    if (job?.status !== "processing") {
      log.warn({ jobId, status: job?.status }, "[occupancy] Skipping — job not in processing state");
      return;
    }

    const result = await runOccupancyBuild({
      trigger: job.createdBy?.startsWith("cron@") ? "cron" : "manual",
      createdBy: job.createdBy,
      onProgress: (done, total, label) => {
        // better-sqlite3 is synchronous — a bare drizzle builder is LAZY and only
        // executes when awaited or via a terminal method. `.run()` runs it now
        // (microseconds, no meaningful block); `void`-ing the builder without
        // `.run()` silently discarded every progress tick, freezing the toast at
        // the enqueue message until completion.
        db
          .update(processingJobs)
          .set({
            totalImages: total,
            processedImages: done,
            statusMessage: `Ajustando modelos (${done} de ${total}) — ${label}`,
          })
          .where(eq(processingJobs.id, jobId))
          .run();
      },
    });

    await db
      .update(processingJobs)
      .set({
        status: "completed",
        completedAt: new Date(),
        totalImages: result.nModels,
        processedImages: result.nModels,
        statusMessage: `Modelos de ocupación completos — ${result.nEligible} especies modeladas (${result.nModels} modelos ajustados)`,
      })
      .where(eq(processingJobs.id, jobId));

    await emitTerminalEvent({
      runId: result.runId,
      nModels: result.nModels,
      nEligible: result.nEligible,
    });

    // Refresh the /ocupacion readiness snapshot so the page reflects this run's
    // data without a manual press. Isolated in its own try/catch: a snapshot
    // write failure must never fail an otherwise-successful modeling run.
    try {
      const readiness = await computeReadinessResult();
      const fingerprint = computeReadinessFingerprint();
      saveReadinessSnapshot({ result: readiness, fingerprint, generatedBy: "batch" });
    } catch (snapErr) {
      log.error({ err: snapErr, jobId }, "[occupancy] readiness snapshot refresh failed (non-fatal)");
    }

    log.info(
      {
        jobId,
        runId: result.runId,
        nModels: result.nModels,
        nEligible: result.nEligible,
        elapsedSec: ((Date.now() - startTime) / 1000).toFixed(0),
      },
      "[occupancy] Job complete",
    );
  } catch (err) {
    log.error({ err, jobId }, "[occupancy] Job FAILED");
    const msg = err instanceof Error ? err.message : "Error desconocido";
    await db
      .update(processingJobs)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorMessage: msg,
        statusMessage: "Error en modelos de ocupación",
      })
      .where(eq(processingJobs.id, jobId));
    await emitTerminalEvent();
  } finally {
    void processNextQueueable().catch((err) =>
      log.error({ err, jobId }, "[occupancy] Queue advance failed after terminal"),
    );
  }
}
