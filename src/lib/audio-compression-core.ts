/**
 * Audio compression core — auth-agnostic functions that drive the WAV → FLAC
 * pipeline. Server actions in `src/app/audio/compression-actions.ts` are thin
 * wrappers; this module is also callable from `scripts/compress-all-audio.mjs`
 * for unattended backfill (no request context).
 *
 * Phase 2 deliverable: enqueue, preview, cancel, and the background processor
 * (`processFlacCompressionJob`). The actual encoder lives in
 * `src/lib/flac-runner.ts`; Drive helpers in `src/lib/drive-client.ts`.
 *
 * Server-only — never import from a Client Component.
 */

import "server-only";

import { promises as fs } from "fs";
import path from "path";
import { db } from "@/db";
import {
  audioFiles,
  deployments,
  processingJobs,
  activityLog,
} from "@/db/schema";
import { and, eq, inArray, sql, count, sum } from "drizzle-orm";
import { JOB_TYPES } from "@/lib/job-types";
import {
  findActiveAudioJob,
  countActiveAudioCompressionJobs,
} from "@/lib/job-locks";
import {
  getFileMetadataWithRevision,
  replaceFileContentAndRename,
  pinFileRevision,
  downloadFileRevision,
} from "@/lib/drive-client";
import { ensureAudioCached } from "@/lib/audio-cache";
import { runFlacEncoding, type FlacEncodeResult } from "@/lib/flac-runner";
import { log } from "@/lib/log";
import type { ActionResult } from "@/lib/types";

const FLAC_BATCH_SIZE = parseInt(
  process.env.FLAC_COMPRESSION_BATCH_SIZE || "5",
  10,
);
const FLAC_WORKERS = parseInt(
  process.env.FLAC_COMPRESSION_WORKERS || "3",
  10,
);
// Empirically observed PAM mean ratio (RWS Collaborative + WildLabs + Arbimon).
const ESTIMATED_RATIO = 0.55;

function keepWavRevisionForever(): boolean {
  return process.env.AUDIO_KEEP_WAV_REVISION_FOREVER !== "false";
}

function compressionEnabled(): boolean {
  return process.env.AUDIO_COMPRESSION_ENABLED === "true";
}

// ---------------------------------------------------------------------------
// Preview (cheap aggregates — no Drive calls)
// ---------------------------------------------------------------------------

export async function getAudioCompressionPreview(
  deploymentIds: number[],
): Promise<
  ActionResult<{
    count: number;
    totalSizeMB: number;
    estimatedSavedMB: number;
  }>
> {
  if (deploymentIds.length === 0) {
    return {
      success: true,
      data: { count: 0, totalSizeMB: 0, estimatedSavedMB: 0 },
    };
  }
  const result = await db
    .select({ cnt: count(), totalSize: sum(audioFiles.fileSize) })
    .from(audioFiles)
    .where(
      and(
        inArray(audioFiles.deploymentId, deploymentIds),
        eq(audioFiles.compressed, false),
        sql`${audioFiles.driveFileId} IS NOT NULL`,
        sql`lower(${audioFiles.filename}) LIKE '%.wav'`,
      ),
    );
  const row = result[0];
  const totalBytes = (row?.totalSize as number | null) ?? 0;
  return {
    success: true,
    data: {
      count: row?.cnt ?? 0,
      totalSizeMB: Math.round((totalBytes / (1024 * 1024)) * 10) / 10,
      estimatedSavedMB:
        Math.round(((totalBytes * (1 - ESTIMATED_RATIO)) / (1024 * 1024)) * 10) /
        10,
    },
  };
}

export async function getAudioRevertPreview(
  deploymentId: number,
): Promise<ActionResult<{ count: number; reclaimableMB: number }>> {
  const result = await db
    .select({
      cnt: count(),
      origTotal: sum(audioFiles.originalFileSize),
      curTotal: sum(audioFiles.fileSize),
    })
    .from(audioFiles)
    .where(
      and(
        eq(audioFiles.deploymentId, deploymentId),
        eq(audioFiles.compressed, true),
        sql`${audioFiles.originalDriveRevisionId} IS NOT NULL`,
        sql`${audioFiles.driveFileId} IS NOT NULL`,
      ),
    );
  const row = result[0];
  const orig = (row?.origTotal as number | null) ?? 0;
  const cur = (row?.curTotal as number | null) ?? 0;
  return {
    success: true,
    data: {
      count: row?.cnt ?? 0,
      reclaimableMB: Math.round(((orig - cur) / (1024 * 1024)) * 10) / 10,
    },
  };
}

// ---------------------------------------------------------------------------
// Enqueue (creates a processing_jobs row, fires the background processor)
// ---------------------------------------------------------------------------

export interface EnqueueOptions {
  deploymentId: number;
  actorEmail: string;
  /** Dry-run: encode + verify only, no Drive or DB mutations. */
  dryRun?: boolean;
}

export async function enqueueAudioCompressionJob(
  opts: EnqueueOptions,
): Promise<ActionResult<{ jobId: number }>> {
  const { deploymentId, actorEmail, dryRun = false } = opts;

  if (!compressionEnabled() && !dryRun) {
    return {
      success: false,
      error: "Compresión de audio deshabilitada (AUDIO_COMPRESSION_ENABLED)",
    };
  }

  const [deployment] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, deploymentId));
  if (!deployment) {
    return { success: false, error: "Instalación no encontrada" };
  }

  const activeJob = await findActiveAudioJob(deploymentId);
  if (activeJob) {
    return {
      success: false,
      error: "Ya existe un trabajo activo de audio para esta instalación",
    };
  }

  // Global cap: at most one AUDIO_COMPRESSION job in flight across all deployments.
  // Prevents the admin from saturating the droplet by queueing every deployment.
  // Skipped in dry-run (parallel dry-runs are fine — no Drive load).
  if (!dryRun) {
    const active = await countActiveAudioCompressionJobs();
    if (active >= 1) {
      return {
        success: false,
        error:
          "Ya hay una compresión de audio en curso. Espera a que termine antes de iniciar otra.",
      };
    }
  }

  const [files] = await db
    .select({ cnt: count() })
    .from(audioFiles)
    .where(
      and(
        eq(audioFiles.deploymentId, deploymentId),
        eq(audioFiles.compressed, false),
        sql`${audioFiles.driveFileId} IS NOT NULL`,
        sql`lower(${audioFiles.filename}) LIKE '%.wav'`,
      ),
    );
  const totalFiles = files?.cnt ?? 0;
  if (totalFiles === 0) {
    return {
      success: false,
      error: "No hay archivos WAV pendientes de comprimir en esta instalación",
    };
  }

  const [job] = await db
    .insert(processingJobs)
    .values({
      deploymentId,
      jobType: JOB_TYPES.AUDIO_COMPRESSION,
      status: "pending",
      totalImages: totalFiles,
      processedImages: 0,
      failedImages: 0,
      createdBy: actorEmail,
      statusMessage: dryRun
        ? "Preparando dry-run de compresión..."
        : "Preparando compresión...",
    })
    .returning();

  // Fire-and-forget. We do NOT use Next.js `after()` because this core is also
  // callable from CLI scripts and tests where there is no request context.
  // `after()` would throw outside a request. The unhandled rejection guard
  // here is identical in effect to the camera-trap pattern.
  void processFlacCompressionJob(job.id, deploymentId, actorEmail, dryRun).catch(
    (err) => {
      log.error(
        { err, jobId: job.id, deploymentId },
        "[flac] unhandled processor error",
      );
    },
  );

  return { success: true, data: { jobId: job.id } };
}

export async function cancelAudioCompressionJob(opts: {
  jobId: number;
  actorEmail: string;
}): Promise<ActionResult<void>> {
  const [job] = await db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.id, opts.jobId));
  if (!job) {
    return { success: false, error: "Trabajo no encontrado" };
  }
  if (
    job.jobType !== JOB_TYPES.AUDIO_COMPRESSION &&
    job.jobType !== JOB_TYPES.REVERT_AUDIO_COMPRESSION
  ) {
    return { success: false, error: "Tipo de trabajo no cancelable aquí" };
  }
  if (job.status !== "pending" && job.status !== "processing") {
    return { success: false, error: "Trabajo ya terminado" };
  }
  await db
    .update(processingJobs)
    .set({ status: "cancelled", statusMessage: "Cancelado por el usuario" })
    .where(eq(processingJobs.id, opts.jobId));
  log.info({ jobId: opts.jobId, actorEmail: opts.actorEmail }, "[flac] cancelled");
  return { success: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Background processor — the long-lived loop that does the actual work.
// ---------------------------------------------------------------------------

interface BatchFile {
  id: number;
  filename: string;
  driveFileId: string;
  fileSize: number | null;
  cachePath: string | null;
  priorRev?: string | null; // captured by reconciliation pre-check
}

async function sweepOrphanTempFlacs(deploymentId: number): Promise<void> {
  const cacheDir = path.join(
    process.cwd(),
    "data",
    "cache",
    "audio",
    String(deploymentId),
  );
  try {
    const entries = await fs.readdir(cacheDir);
    for (const entry of entries) {
      if (entry.endsWith(".tmp.flac")) {
        try {
          await fs.unlink(path.join(cacheDir, entry));
        } catch {
          // best effort
        }
      }
    }
  } catch {
    // dir may not exist yet
  }
}

export async function processFlacCompressionJob(
  jobId: number,
  deploymentId: number,
  actorEmail: string,
  dryRun = false,
): Promise<void> {
  const startTime = Date.now();
  let processed = 0;
  let failed = 0;
  let skipped = 0;
  let savedBytes = 0;
  let originalTotalBytes = 0;
  let compressedTotalBytes = 0;
  const skipReasons: Record<string, number> = {};
  const recordSkip = (reason: string) => {
    skipped++;
    skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
  };

  try {
    await db
      .update(processingJobs)
      .set({ status: "processing", startedAt: new Date() })
      .where(eq(processingJobs.id, jobId));

    await sweepOrphanTempFlacs(deploymentId);

    const allFiles = await db
      .select({
        id: audioFiles.id,
        filename: audioFiles.filename,
        driveFileId: audioFiles.driveFileId,
        fileSize: audioFiles.fileSize,
        cachePath: audioFiles.cachePath,
      })
      .from(audioFiles)
      .where(
        and(
          eq(audioFiles.deploymentId, deploymentId),
          eq(audioFiles.compressed, false),
          sql`${audioFiles.driveFileId} IS NOT NULL`,
          sql`lower(${audioFiles.filename}) LIKE '%.wav'`,
        ),
      );

    const total = allFiles.length;

    await db
      .update(processingJobs)
      .set({
        totalImages: total,
        statusMessage: dryRun
          ? `Dry-run: 0 de ${total}`
          : `Comprimiendo 0 de ${total}`,
      })
      .where(eq(processingJobs.id, jobId));

    log.info(
      { jobId, deploymentId, total, dryRun },
      "[flac] job starting",
    );

    for (let i = 0; i < allFiles.length; i += FLAC_BATCH_SIZE) {
      // Cancellation check (~ every batch — ≤ FLAC_BATCH_SIZE files of latency)
      const [{ status }] = await db
        .select({ status: processingJobs.status })
        .from(processingJobs)
        .where(eq(processingJobs.id, jobId));
      if (status === "cancelled") {
        log.info({ jobId, processed, failed }, "[flac] cancelled mid-job");
        break;
      }

      const rawBatch = allFiles.slice(i, i + FLAC_BATCH_SIZE) as BatchFile[];

      // Reconciliation pre-check — fetch Drive metadata for every file.
      // Self-heals "Drive ahead of DB" (Drive shows .flac but DB shows .wav)
      // and captures the prior head revision id for revert.
      const driveMetas = await Promise.all(
        rawBatch.map((f) =>
          getFileMetadataWithRevision(f.driveFileId).catch(() => null),
        ),
      );

      const toEncode: BatchFile[] = [];
      for (let k = 0; k < rawBatch.length; k++) {
        const f = rawBatch[k];
        const meta = driveMetas[k];
        if (!meta) {
          // File missing from Drive — count as failed and log.
          failed++;
          log.warn(
            { jobId, audioFileId: f.id, driveFileId: f.driveFileId },
            "[flac] Drive metadata fetch returned null (trashed or 404)",
          );
          continue;
        }
        if (meta.mimeType === "audio/flac") {
          // Self-heal — Drive already migrated, DB out of sync. (Likely a
          // previous job crashed between Drive write and DB update.)
          if (!dryRun) {
            await db
              .update(audioFiles)
              .set({
                compressed: true,
                filename: meta.name,
                format: "flac",
                mimeType: "audio/flac",
                fileSize: meta.size,
                originalFileSize: f.fileSize,
                // originalDriveRevisionId left null — anchor unknown.
              })
              .where(eq(audioFiles.id, f.id));
          }
          processed++;
          log.info(
            { jobId, audioFileId: f.id, filename: f.filename },
            "[flac] reconciliation self-heal — Drive already FLAC",
          );
          continue;
        }
        f.priorRev = meta.headRevisionId;

        // Pre-encode: ensure the source is in the local cache.
        try {
          await ensureAudioCached(f.id);
        } catch (err) {
          recordSkip("cache_failed");
          log.warn(
            { err, jobId, audioFileId: f.id },
            "[flac] cache download failed",
          );
          continue;
        }
        toEncode.push(f);
      }

      if (toEncode.length === 0) {
        await updateProgress(jobId, processed, failed, total, dryRun, savedBytes);
        continue;
      }

      // Re-read cachePath after ensureAudioCached so we have fresh values.
      const idToCachePath = new Map<number, string>();
      const cacheRows = await db
        .select({ id: audioFiles.id, cachePath: audioFiles.cachePath })
        .from(audioFiles)
        .where(
          inArray(
            audioFiles.id,
            toEncode.map((x) => x.id),
          ),
        );
      for (const r of cacheRows) {
        if (r.cachePath) idToCachePath.set(r.id, r.cachePath);
      }

      const encodeInputs = toEncode
        .map((f) => {
          const wavPath = idToCachePath.get(f.id);
          return wavPath ? { id: f.id, wavPath } : null;
        })
        .filter((x): x is { id: number; wavPath: string } => x !== null);

      if (encodeInputs.length === 0) {
        await updateProgress(jobId, processed, failed, total, dryRun, savedBytes);
        continue;
      }

      const results: FlacEncodeResult[] = [];
      const skips: { audioFileId: number; reason: string }[] = [];
      const runOutcome = await runFlacEncoding({
        jobId,
        files: encodeInputs,
        workers: FLAC_WORKERS,
        compressionLevel: 0.8,
        subtype: "PCM_16",
        onResult: (r) => {
          results.push(r);
        },
        onSkip: (s) => {
          skips.push(s);
        },
        onProgress: async (idx, t) => {
          // Surface per-batch progress; full progress updated after the
          // batch finishes when DB updates run.
          await db
            .update(processingJobs)
            .set({
              statusMessage: `${dryRun ? "Dry-run" : "Codificando"} (${idx} de ${t} en lote)`,
            })
            .where(eq(processingJobs.id, jobId));
        },
      });

      if (!runOutcome.success) {
        log.error(
          { jobId, error: runOutcome.error },
          "[flac] encoder batch failed — counting batch as failed",
        );
        failed += encodeInputs.length;
        await updateProgress(jobId, processed, failed, total, dryRun, savedBytes);
        continue;
      }

      // Apply skips (encoder side)
      for (const s of skips) {
        recordSkip(s.reason);
      }

      // Apply results: per file, replace Drive + update DB.
      for (const r of results) {
        const f = toEncode.find((x) => x.id === r.audioFileId);
        if (!f) {
          log.warn({ jobId, audioFileId: r.audioFileId }, "[flac] orphan result");
          if (r.flacPath) await fs.unlink(r.flacPath).catch(() => {});
          continue;
        }

        if (r.verdict === "non_compressible") {
          // FLAC was no smaller than WAV — keep WAV but mark compressed so we
          // don't retry. No Drive write, no revert anchor.
          if (!dryRun) {
            await db
              .update(audioFiles)
              .set({
                compressed: true,
                originalFileSize: f.fileSize,
              })
              .where(eq(audioFiles.id, f.id));
          }
          processed++;
          log.info(
            {
              jobId,
              audioFileId: f.id,
              wavSize: r.wavSize,
              flacSize: r.flacSize,
            },
            "[flac] non_compressible — kept as WAV",
          );
          continue;
        }

        // Verdict: compressed. Drive replace + DB update (skipped in dry-run).
        const newName = f.filename.replace(/\.wav$/i, ".flac");
        if (dryRun) {
          processed++;
          originalTotalBytes += r.wavSize;
          compressedTotalBytes += r.flacSize;
          savedBytes += Math.max(r.wavSize - r.flacSize, 0);
          // Clean up dry-run tmp file
          if (r.flacPath) await fs.unlink(r.flacPath).catch(() => {});
          continue;
        }

        try {
          const flacBuf = await fs.readFile(r.flacPath!);
          const upload = await replaceFileContentAndRename(
            f.driveFileId,
            flacBuf,
            newName,
            "audio/flac",
          );
          const newSize = upload.size ?? r.flacSize;

          // Pin the prior revision so revert always works (env-gated).
          if (keepWavRevisionForever() && f.priorRev) {
            try {
              await pinFileRevision(f.driveFileId, f.priorRev);
            } catch (err) {
              log.warn(
                { err, jobId, audioFileId: f.id, driveFileId: f.driveFileId },
                "[flac] pinFileRevision failed (non-fatal — Drive 30d window still applies)",
              );
            }
          }

          await db
            .update(audioFiles)
            .set({
              compressed: true,
              filename: newName,
              format: "flac",
              mimeType: "audio/flac",
              fileSize: newSize,
              originalFileSize: f.fileSize,
              originalDriveRevisionId: f.priorRev ?? null,
              cachePath: null, // next request re-downloads the smaller FLAC
            })
            .where(eq(audioFiles.id, f.id));

          processed++;
          originalTotalBytes += r.wavSize;
          compressedTotalBytes += newSize;
          savedBytes += Math.max(r.wavSize - newSize, 0);

          log.info(
            {
              jobId,
              audioFileId: f.id,
              filename: f.filename,
              newName,
              wavSize: r.wavSize,
              flacSize: newSize,
              priorRev: f.priorRev,
            },
            "[flac] audit — Drive replaced + DB updated",
          );
        } catch (err) {
          failed++;
          log.error(
            { err, jobId, audioFileId: f.id, driveFileId: f.driveFileId },
            "[flac] Drive upload or DB update failed",
          );
        } finally {
          if (r.flacPath) await fs.unlink(r.flacPath).catch(() => {});
        }
      }

      await updateProgress(jobId, processed, failed, total, dryRun, savedBytes);
    }

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(0);
    const savedMB = (savedBytes / (1024 * 1024)).toFixed(1);
    const completionMsg = dryRun
      ? `Dry-run completo — ${processed} OK, ${skipped} omitidos, ${failed} errores. Ahorro estimado: ${savedMB} MB`
      : `Compresión completa — ${processed} OK, ${skipped} omitidos, ${failed} errores. Ahorro: ${savedMB} MB`;

    await db
      .update(processingJobs)
      .set({
        status: "completed",
        completedAt: new Date(),
        processedImages: processed + failed + skipped,
        failedImages: failed + skipped,
        statusMessage: completionMsg,
      })
      .where(eq(processingJobs.id, jobId));

    await db.insert(activityLog).values({
      userEmail: actorEmail,
      action: dryRun ? "audio_compression_dry_run" : "audio_compression",
      projectId: "grabaciones",
      targetType: "deployment",
      targetId: String(deploymentId),
      details: JSON.stringify({
        compressed: processed,
        skipped,
        failed,
        savedBytes,
        originalTotalBytes,
        compressedTotalBytes,
        skipReasons,
        dryRun,
      }),
    });

    log.info(
      {
        jobId,
        deploymentId,
        compressed: processed,
        skipped,
        failed,
        savedBytes,
        originalTotalBytes,
        compressedTotalBytes,
        elapsedSec,
        dryRun,
      },
      "[flac] Job complete",
    );
  } catch (err) {
    log.error({ err, jobId, deploymentId }, "[flac] Job FAILED");
    const msg = err instanceof Error ? err.message : "Error desconocido";
    await db
      .update(processingJobs)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorMessage: msg,
        statusMessage: "Error en compresión de audio",
      })
      .where(eq(processingJobs.id, jobId));
  }
}

async function updateProgress(
  jobId: number,
  processed: number,
  failed: number,
  total: number,
  dryRun: boolean,
  savedBytes: number,
): Promise<void> {
  const done = processed + failed;
  const savedMB = (savedBytes / (1024 * 1024)).toFixed(1);
  const prefix = dryRun ? "Dry-run" : "Comprimiendo";
  await db
    .update(processingJobs)
    .set({
      processedImages: done,
      failedImages: failed,
      statusMessage: `${prefix} ${done} de ${total} · ${savedMB} MB ahorrado`,
    })
    .where(eq(processingJobs.id, jobId));
}

// ---------------------------------------------------------------------------
// Revert — restore the pre-compression WAV revision from Drive.
// ---------------------------------------------------------------------------

export async function enqueueAudioRevertJob(opts: {
  deploymentId: number;
  actorEmail: string;
}): Promise<ActionResult<{ jobId: number }>> {
  const { deploymentId, actorEmail } = opts;

  const activeJob = await findActiveAudioJob(deploymentId);
  if (activeJob) {
    return {
      success: false,
      error: "Ya existe un trabajo activo de audio para esta instalación",
    };
  }

  const [files] = await db
    .select({ cnt: count() })
    .from(audioFiles)
    .where(
      and(
        eq(audioFiles.deploymentId, deploymentId),
        eq(audioFiles.compressed, true),
        sql`${audioFiles.originalDriveRevisionId} IS NOT NULL`,
        sql`${audioFiles.driveFileId} IS NOT NULL`,
      ),
    );
  const total = files?.cnt ?? 0;
  if (total === 0) {
    return {
      success: false,
      error: "No hay archivos comprimidos revertibles en esta instalación",
    };
  }

  const [job] = await db
    .insert(processingJobs)
    .values({
      deploymentId,
      jobType: JOB_TYPES.REVERT_AUDIO_COMPRESSION,
      status: "pending",
      totalImages: total,
      processedImages: 0,
      failedImages: 0,
      createdBy: actorEmail,
      statusMessage: "Preparando reversión...",
    })
    .returning();

  void processAudioRevertJob(job.id, deploymentId, actorEmail).catch((err) => {
    log.error(
      { err, jobId: job.id, deploymentId },
      "[flac-revert] unhandled processor error",
    );
  });

  return { success: true, data: { jobId: job.id } };
}

async function processAudioRevertJob(
  jobId: number,
  deploymentId: number,
  actorEmail: string,
): Promise<void> {
  const startTime = Date.now();
  let reverted = 0;
  let failed = 0;

  try {
    await db
      .update(processingJobs)
      .set({ status: "processing", startedAt: new Date() })
      .where(eq(processingJobs.id, jobId));

    const files = await db
      .select({
        id: audioFiles.id,
        filename: audioFiles.filename,
        driveFileId: audioFiles.driveFileId,
        fileSize: audioFiles.fileSize,
        originalFileSize: audioFiles.originalFileSize,
        originalDriveRevisionId: audioFiles.originalDriveRevisionId,
      })
      .from(audioFiles)
      .where(
        and(
          eq(audioFiles.deploymentId, deploymentId),
          eq(audioFiles.compressed, true),
          sql`${audioFiles.originalDriveRevisionId} IS NOT NULL`,
          sql`${audioFiles.driveFileId} IS NOT NULL`,
        ),
      );

    await db
      .update(processingJobs)
      .set({
        totalImages: files.length,
        statusMessage: `Revirtiendo 0 de ${files.length}`,
      })
      .where(eq(processingJobs.id, jobId));

    for (let i = 0; i < files.length; i += FLAC_BATCH_SIZE) {
      const [{ status }] = await db
        .select({ status: processingJobs.status })
        .from(processingJobs)
        .where(eq(processingJobs.id, jobId));
      if (status === "cancelled") {
        log.info({ jobId }, "[flac-revert] cancelled mid-job");
        break;
      }

      const batch = files.slice(i, i + FLAC_BATCH_SIZE);
      for (const f of batch) {
        try {
          if (!f.driveFileId || !f.originalDriveRevisionId) {
            failed++;
            continue;
          }
          const wavBuf = await downloadFileRevision(
            f.driveFileId,
            f.originalDriveRevisionId,
          );
          const wavName = f.filename.replace(/\.flac$/i, ".wav");
          const upload = await replaceFileContentAndRename(
            f.driveFileId,
            wavBuf,
            wavName,
            "audio/wav",
          );
          await db
            .update(audioFiles)
            .set({
              compressed: false,
              filename: wavName,
              format: "wav",
              mimeType: "audio/wav",
              fileSize: upload.size ?? wavBuf.length,
              originalFileSize: null,
              originalDriveRevisionId: null,
              cachePath: null,
            })
            .where(eq(audioFiles.id, f.id));
          reverted++;
          log.info(
            {
              jobId,
              audioFileId: f.id,
              wavName,
              size: upload.size ?? wavBuf.length,
            },
            "[flac-revert] audit — restored from Drive revision",
          );
        } catch (err) {
          failed++;
          log.error(
            { err, jobId, audioFileId: f.id },
            "[flac-revert] revert failed for file",
          );
        }
      }

      const done = reverted + failed;
      await db
        .update(processingJobs)
        .set({
          processedImages: done,
          failedImages: failed,
          statusMessage: `Revirtiendo ${done} de ${files.length}`,
        })
        .where(eq(processingJobs.id, jobId));
    }

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(0);
    await db
      .update(processingJobs)
      .set({
        status: "completed",
        completedAt: new Date(),
        processedImages: reverted + failed,
        failedImages: failed,
        statusMessage: `Reversión completa — ${reverted} OK, ${failed} errores`,
      })
      .where(eq(processingJobs.id, jobId));

    await db.insert(activityLog).values({
      userEmail: actorEmail,
      action: "audio_revert_compression",
      projectId: "grabaciones",
      targetType: "deployment",
      targetId: String(deploymentId),
      details: JSON.stringify({ reverted, failed }),
    });

    log.info(
      { jobId, deploymentId, reverted, failed, elapsedSec },
      "[flac-revert] Job complete",
    );
  } catch (err) {
    log.error({ err, jobId, deploymentId }, "[flac-revert] Job FAILED");
    const msg = err instanceof Error ? err.message : "Error desconocido";
    await db
      .update(processingJobs)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorMessage: msg,
        statusMessage: "Error en reversión",
      })
      .where(eq(processingJobs.id, jobId));
  }
}
