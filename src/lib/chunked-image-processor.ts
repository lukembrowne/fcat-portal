/**
 * Chunked (disk-bounded) image processing for camera-trap ML jobs.
 *
 * When a deployment's pending download won't fit in free disk, the runner calls
 * this instead of the bulk download + single ML pass. It groups the job's
 * pending drive-backed images into byte-budgeted chunks and, per chunk:
 * download → ML → release. Peak cache usage stays ≈ one chunk.
 *
 * ML runs once per chunk against the warm model server (no reload). A cumulative
 * progress offset keeps `processedImages` monotonic across chunks.
 *
 * Kept out of the `"use server"` actions module so it stays unit-testable and
 * off the server-action surface. See docs/plans/2026-05-26-fix-ml-chunked-download-plan.md.
 */

import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { processingJobs } from "@/db/schema";
import { log } from "@/lib/log";
import { runMLPredictions, type MLConfig } from "@/lib/ml-runner";
import {
  groupRowsIntoChunks,
  downloadImageSet,
  releaseChunkFiles,
  getFreeDiskBytes,
  diskFits,
  evictIfOverLimit,
  InsufficientDiskError,
  type ImageRow,
} from "@/lib/drive-downloader";

const NULL_SIZE_FALLBACK_BYTES = 20 * 1024 * 1024;

export interface ChunkedProcessingOutcome {
  totalProcessed: number;
  totalDetections: number;
  /** Loop broke on cancellation — caller aborts without finalizing. */
  cancelled: boolean;
  /** A chunk's ML reported a real failure — caller marks the job failed. */
  anyFailed: boolean;
}

export async function processDeploymentImagesChunked(opts: {
  deploymentId: number;
  jobId: number;
  cacheDir: string;
  rows: ImageRow[];
  mlConfigBase: Omit<MLConfig, "imagePaths" | "progressOffset" | "progressTotal">;
  checkCancelled: () => Promise<boolean>;
}): Promise<ChunkedProcessingOutcome> {
  const { deploymentId, jobId, cacheDir, rows, mlConfigBase, checkCancelled } = opts;
  const chunks = groupRowsIntoChunks(rows);
  const pendingTotal = rows.length;
  let totalProcessed = 0;
  let totalDetections = 0;
  let doneCount = 0;
  let anyFailed = false;

  log.info(
    { jobId, deploymentId, chunks: chunks.length, images: pendingTotal },
    "[chunked] disk-bounded processing start"
  );

  // Free disk held by OTHER deployments' caches before we start (skips this
  // deployment). Self-bounding per chunk handles our own footprint.
  await evictIfOverLimit(deploymentId);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (await checkCancelled()) {
      return { totalProcessed, totalDetections, cancelled: true, anyFailed };
    }

    // Per-chunk disk gate. free === null (unmeasurable) → don't hard-fail; a
    // chunk is bounded (~CHUNK_MAX_GB). A real number → enforce the margin, so
    // genuinely-low disk throws InsufficientDiskError (clean fail, no crash).
    const free = await getFreeDiskBytes();
    const chunkBytes = chunk.reduce(
      (s, r) => s + (r.fileSize && r.fileSize > 0 ? r.fileSize : NULL_SIZE_FALLBACK_BYTES),
      0
    );
    if (free !== null && !diskFits(chunkBytes, free)) {
      throw new InsufficientDiskError(chunkBytes, free);
    }

    // Download this chunk (skips already-cached); writes paths + thumbnails.
    const dl = await downloadImageSet(
      cacheDir,
      deploymentId,
      jobId,
      chunk,
      async (event) => {
        if (event.phase === "downloading") {
          await db.update(processingJobs).set({
            downloadedImages: doneCount + event.downloaded,
            statusMessage: `Lote ${i + 1}/${chunks.length}: descargando ${doneCount + event.downloaded} de ${pendingTotal}`,
          }).where(eq(processingJobs.id, jobId));
        } else if (event.phase === "thumbnails") {
          await db.update(processingJobs).set({
            statusMessage: `Lote ${i + 1}/${chunks.length}: miniaturas ${event.generated} de ${event.total}`,
          }).where(eq(processingJobs.id, jobId));
        }
      },
      checkCancelled
    );

    // ML this chunk against the warm server. Cumulative progress offset keeps
    // processedImages monotonic (the runner resets its own counter each call).
    const ml = await runMLPredictions(jobId, {
      ...mlConfigBase,
      imagePaths: dl.localPaths,
      progressOffset: doneCount,
      progressTotal: pendingTotal,
    });
    if (!ml.success) {
      // Cancellation surfaces here as success:false too — distinguish via status.
      if (await checkCancelled()) {
        return { totalProcessed, totalDetections, cancelled: true, anyFailed };
      }
      anyFailed = true;
    }
    totalProcessed += ml.totalProcessed;
    totalDetections += ml.totalDetections;

    // Release this chunk's full-res files (thumbnails + detections persist).
    await releaseChunkFiles(cacheDir, chunk);

    doneCount += chunk.length;
    await db.update(processingJobs).set({
      downloadedImages: doneCount,
      statusMessage: `Lote ${i + 1}/${chunks.length} listo (${doneCount} de ${pendingTotal})`,
    }).where(eq(processingJobs.id, jobId));

    log.info(
      { jobId, chunk: i + 1, of: chunks.length, processed: totalProcessed, detections: totalDetections },
      "[chunked] chunk complete"
    );
  }

  return { totalProcessed, totalDetections, cancelled: false, anyFailed };
}
