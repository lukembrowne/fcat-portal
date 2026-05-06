import "server-only";

import pLimit from "p-limit";
import { db } from "@/db";
import {
  processingJobs,
  deployments,
  cameraTrapProjects,
  type Deployment,
} from "@/db/schema";
import { eq, and, isNotNull } from "drizzle-orm";
import { listDeploymentFolders, isValidFolderId } from "@/lib/drive-client";
import { touchAppState } from "@/lib/app-state";
import { CAMERA_TRAP_DRIVE_LAST_SYNC_KEY } from "@/lib/app-state-keys";
import { revalidatePath } from "next/cache";
import { log } from "@/lib/log";
import {
  scanDeploymentImagesInternal,
  refreshUploadCountsInternal,
  matchOdkDeploymentsInternal,
} from "@/lib/camera-trap-sync-internals";

const CAMERA_TRAP_PATH = "/camera-trap";

const DEFAULT_CONCURRENCY = 8;
function readConcurrency(): number {
  const raw = process.env.DRIVE_SYNC_CONCURRENCY;
  if (!raw) return DEFAULT_CONCURRENCY;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 32) : DEFAULT_CONCURRENCY;
}

interface SyncSummary {
  total: number;
  processed: number;
  failed: number;
  created: number;
  matched: number;
  unmatched: number;
}

function safeRevalidate(): void {
  try {
    revalidatePath(CAMERA_TRAP_PATH);
  } catch {
    // Worker context — client polls for updates
  }
}

async function isJobCancelled(jobId: number): Promise<boolean> {
  const [j] = await db
    .select({ status: processingJobs.status })
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId));
  return !j || j.status === "cancelled";
}

async function setJobStatus(
  jobId: number,
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
) {
  await db.update(processingJobs).set(patch).where(eq(processingJobs.id, jobId));
}

/**
 * Run a Drive sync job to completion.
 *
 * Phases:
 *   1. Resolve scope → list of CT projects to walk
 *   2. Discover new folders per project, insert deployment rows
 *   3. Fan out (p-limit) over all in-scope deployments — scan images + refresh counts
 *   4. ODK match for newly-created deployments
 *   5. Touch app-state last-sync key, mark job completed
 *
 * The function is fire-and-forget: it never throws to the caller. All terminal
 * states are persisted to the processingJobs row.
 */
export async function runDriveSyncWorker(jobId: number): Promise<void> {
  const startMs = Date.now();
  const concurrency = readConcurrency();

  try {
    const [job] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId));

    if (!job) {
      log.error({ jobId }, "[drive-sync] Job row not found");
      return;
    }

    if (job.jobType !== "drive_sync") {
      log.error({ jobId, jobType: job.jobType }, "[drive-sync] Wrong job type");
      return;
    }

    log.info(
      { jobId, scope: job.cameraTrapProjectId ?? "all", concurrency },
      "[drive-sync] starting"
    );

    await setJobStatus(jobId, {
      status: "processing",
      startedAt: new Date(),
      statusMessage: "Buscando proyectos...",
    });

    // ---- Phase 1: resolve scope ----
    const projects = job.cameraTrapProjectId
      ? await db
          .select()
          .from(cameraTrapProjects)
          .where(eq(cameraTrapProjects.id, job.cameraTrapProjectId))
      : await db.select().from(cameraTrapProjects);

    const projectsToWalk = projects.filter(
      (p): p is typeof p & { driveFolderId: string } => !!p.driveFolderId
    );

    if (projectsToWalk.length === 0) {
      await setJobStatus(jobId, {
        status: "completed",
        completedAt: new Date(),
        statusMessage: "Sin proyectos con carpeta de Drive configurada",
      });
      safeRevalidate();
      return;
    }

    // ---- Phase 2: discover new folders ----
    const allCreatedIds: number[] = [];
    await setJobStatus(jobId, { statusMessage: "Buscando carpetas nuevas..." });

    for (const proj of projectsToWalk) {
      if (await isJobCancelled(jobId)) {
        await finalize(jobId, "cancelled", "Cancelado durante descubrimiento", startMs);
        return;
      }
      try {
        const driveFolders = await listDeploymentFolders(proj.driveFolderId);
        const known = await db
          .select({ id: deployments.driveFolderId })
          .from(deployments)
          .where(eq(deployments.cameraTrapProjectId, proj.id));
        const knownSet = new Set(
          known.map((k) => k.id).filter((id): id is string => id != null)
        );

        for (const folder of driveFolders) {
          if (knownSet.has(folder.id)) continue;
          if (!isValidFolderId(folder.id)) continue;

          try {
            const [dep] = await db
              .insert(deployments)
              .values({
                projectId: "camera-trap",
                cameraTrapProjectId: proj.id,
                name: folder.name.trim(),
                driveFolderId: folder.id,
                projectLabel: proj.name,
                totalImages: 0,
                status: "unscanned",
                metadataSource: "drive",
                createdBy: job.createdBy,
              })
              .returning();
            allCreatedIds.push(dep.id);
            knownSet.add(folder.id);
          } catch (err) {
            // UNIQUE constraint on (projectId, driveFolderId) — race or duplicate
            if (
              err instanceof Error &&
              err.message.includes("UNIQUE constraint failed")
            ) {
              continue;
            }
            log.warn(
              { err, name: folder.name, project: proj.name },
              "[drive-sync] Failed to insert deployment"
            );
          }
        }
      } catch (err) {
        log.error(
          { err, project: proj.name },
          "[drive-sync] Failed to list folders for project"
        );
      }
    }

    // ---- Phase 3: load all in-scope deployments ----
    const allDeps: Deployment[] = job.cameraTrapProjectId
      ? await db
          .select()
          .from(deployments)
          .where(
            and(
              eq(deployments.cameraTrapProjectId, job.cameraTrapProjectId),
              isNotNull(deployments.driveFolderId)
            )
          )
      : await db
          .select()
          .from(deployments)
          .where(isNotNull(deployments.driveFolderId));

    const total = allDeps.length;

    await setJobStatus(jobId, {
      totalImages: total,
      processedImages: 0,
      statusMessage: `Sincronizando 0 de ${total} instalaciones`,
    });

    log.info(
      { jobId, total, created: allCreatedIds.length },
      "[drive-sync] discovery complete; starting fan-out"
    );

    // ---- Phase 4: parallel fan-out ----
    const limit = pLimit(concurrency);
    let processed = 0;
    let failed = 0;
    let lastProgressUpdate = 0;
    const PROGRESS_TICK_MS = 1500;

    const results = await Promise.allSettled(
      allDeps.map((dep) =>
        limit(async () => {
          if (await isJobCancelled(jobId)) {
            return { skipped: true } as const;
          }
          const t0 = Date.now();
          try {
            await scanDeploymentImagesInternal(dep);
            const r = await refreshUploadCountsInternal(dep);
            if (!r.ok) {
              throw new Error(r.error ?? "refresh failed");
            }
            return { ok: true, ms: Date.now() - t0 } as const;
          } catch (err) {
            log.warn(
              { err, deployment: dep.name, depId: dep.id },
              "[drive-sync] deployment task failed"
            );
            throw err;
          } finally {
            // settle counter (best-effort, racy but fine for a progress bar)
            const completed = processed + failed + 1;
            const now = Date.now();
            if (
              now - lastProgressUpdate > PROGRESS_TICK_MS ||
              completed === total
            ) {
              lastProgressUpdate = now;
              const elapsedSec = (now - startMs) / 1000;
              const rate = completed / Math.max(elapsedSec, 0.001);
              const remaining = Math.max(total - completed, 0);
              const etaSec = rate > 0 ? remaining / rate : 0;
              log.info(
                {
                  jobId,
                  processed: completed,
                  total,
                  totalElapsed: `${elapsedSec.toFixed(1)}s`,
                  etaSec: `${etaSec.toFixed(0)}s`,
                  rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
                },
                "[drive-sync] progress"
              );
              await setJobStatus(jobId, {
                processedImages: completed,
                statusMessage: `Sincronizando ${completed} de ${total} instalaciones`,
              });
            }
          }
        })
      )
    );

    for (const r of results) {
      if (r.status === "fulfilled") {
        if ((r.value as { skipped?: boolean }).skipped) continue;
        processed++;
      } else {
        failed++;
      }
    }

    // ---- Phase 5: ODK match for newly-created deployments ----
    let matched = 0;
    let unmatched = 0;
    if (allCreatedIds.length > 0 && !(await isJobCancelled(jobId))) {
      await setJobStatus(jobId, {
        statusMessage: `Vinculando ${allCreatedIds.length} nuevas con ODK...`,
      });
      try {
        const odkResult = await matchOdkDeploymentsInternal(allCreatedIds);
        matched = odkResult.matched.length;
        unmatched = odkResult.unmatched.length;
      } catch (err) {
        log.error({ err }, "[drive-sync] ODK match failed");
      }
    }

    // ---- Phase 6: finalize ----
    const cancelled = await isJobCancelled(jobId);
    if (!cancelled) {
      try {
        await touchAppState(CAMERA_TRAP_DRIVE_LAST_SYNC_KEY);
      } catch (err) {
        log.warn({ err }, "[drive-sync] touchAppState failed");
      }
    }

    const summary: SyncSummary = {
      total,
      processed,
      failed,
      created: allCreatedIds.length,
      matched,
      unmatched,
    };

    const finalMsg = cancelled
      ? "Cancelado"
      : failed > 0
        ? `Completado: ${processed} ok, ${failed} con errores, ${allCreatedIds.length} nuevas`
        : `Completado: ${processed} de ${total}, ${allCreatedIds.length} nuevas`;

    await finalize(
      jobId,
      cancelled ? "cancelled" : "completed",
      finalMsg,
      startMs,
      summary,
      processed,
      failed
    );
    safeRevalidate();
  } catch (err) {
    log.error({ err, jobId }, "[drive-sync] worker crashed");
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

async function finalize(
  jobId: number,
  status: "completed" | "cancelled" | "failed",
  message: string,
  startMs: number,
  summary?: SyncSummary,
  processed?: number,
  failed?: number
) {
  const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
  log.info(
    { jobId, status, elapsedSec, ...summary },
    "[drive-sync] done"
  );
  await db
    .update(processingJobs)
    .set({
      status,
      completedAt: new Date(),
      statusMessage: message,
      ...(processed != null ? { processedImages: processed + (failed ?? 0) } : {}),
      ...(failed != null ? { failedImages: failed } : {}),
    })
    .where(eq(processingJobs.id, jobId));
}

/**
 * Block until the job reaches a terminal state, returning the final row.
 * Used by the cron route which needs to send an email after completion.
 */
export async function awaitJobTerminal(
  jobId: number,
  options: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<{ status: string; statusMessage: string | null; processedImages: number; failedImages: number; totalImages: number; errorMessage: string | null } | null> {
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
