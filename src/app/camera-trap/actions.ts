"use server";

import { promises as fs } from "fs";
import path from "path";
import { db } from "@/db";
import {
  deployments,
  processingJobs,
  images,
  videos,
  detections,
  identifications,
  audioIdentifications,
  species,
  cameraTrapProjects,
  cameraTrapModels,
  activityLog,
  shareTokens,
  IMAGE_TIMESTAMP_ORDER,
} from "@/db/schema";
import {
  displaySpecies,
  type ModelForDisplay,
} from "@/lib/display-species";
import { eq, desc, inArray, and, or, gte, ne, sql, count, sum, isNotNull, isNull, notExists } from "drizzle-orm";
import { runMLPredictions, checkPytorchWildlife, cancelModelServerJob } from "@/lib/ml-runner";
import {
  downloadDeploymentForProcessing,
  downloadVideosForProcessing,
  cleanupJobTempDir,
} from "@/lib/drive-downloader";
import { uploadFramesToDrive, trashFile } from "@/lib/drive-client";
import { extractFrames, cancelFrameExtraction } from "@/lib/frame-extractor";
import { requirePermission } from "@/lib/auth";
import {
  getUserCameraTrapProjects,
  ctProjectFilter,
  requireDeploymentAccess,
  getDeploymentIdForDetection,
  getDeploymentIdForIdentification,
} from "@/lib/camera-trap-auth";
import { revalidatePath } from "next/cache";
import type { ActionResult, VerificationStats, TaxonomicRank } from "@/lib/types";
import type { Deployment, ProcessingJob, Species, NewSpecies, ShareToken } from "@/db/schema";
import crypto from "crypto";
import { ML_DEFAULTS } from "@/lib/ml-defaults";
import { log } from "@/lib/log";

const CAMERA_TRAP_PATH = "/camera-trap";

// ---------------------------------------------------------------------------
// Processing
// ---------------------------------------------------------------------------

export async function createProcessingJob(
  deploymentId: number,
  modelConfig?: {
    detectorModel?: string;
    classifierModel?: string;
    confidenceThreshold?: number;
    frameExtractionRate?: number;
  },
  options?: { compressFirst?: boolean; incremental?: boolean; frameExtractionRate?: number; videoTimestampMethod?: "metadata" | "filename_folder" | "none" }
): Promise<ActionResult<{ jobId: number }>> {
  const incremental = options?.incremental ?? false;
  const user = await requirePermission("camera-trap", "editor");

  try {
    const [deployment] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deploymentId));

    if (!deployment) {
      return { success: false, error: "Instalación no encontrada" };
    }

    // Reject if a job is already active for this deployment. Without this
    // guard, two near-simultaneous createProcessingJob calls would both insert
    // jobs and race on images.jobId — the loser ends up with zero linked
    // images and orphaned detections.
    if (deployment.status === "processing") {
      return {
        success: false,
        error: "Esta instalación ya está siendo procesada",
      };
    }
    const [activeJob] = await db
      .select({ id: processingJobs.id })
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.deploymentId, deploymentId),
          inArray(processingJobs.status, ["pending", "processing"])
        )
      )
      .limit(1);
    if (activeJob) {
      return {
        success: false,
        error: "Ya existe un trabajo activo para esta instalación",
      };
    }

    await requireDeploymentAccess(user, deploymentId);

    // Check for images OR videos (deployments with only videos are valid).
    // For incremental runs, only pick up images that haven't been processed yet
    // (status = 'pending'). The destructive cleanup transaction below is also
    // skipped, so existing detections / verifications / blank confirmations on
    // already-processed images are preserved.
    const deploymentImages = await db
      .select()
      .from(images)
      .where(
        incremental
          ? and(
              eq(images.deploymentId, deploymentId),
              eq(images.status, "pending"),
            )
          : eq(images.deploymentId, deploymentId),
      );

    const deploymentVideos = await db
      .select()
      .from(videos)
      .where(
        incremental
          ? and(
              eq(videos.deploymentId, deploymentId),
              ne(videos.status, "processed"),
            )
          : eq(videos.deploymentId, deploymentId),
      );

    if (deploymentImages.length === 0 && deploymentVideos.length === 0) {
      if (incremental) {
        return {
          success: false,
          error: "No hay imágenes nuevas para procesar",
        };
      }
      log.info({ deploymentId }, "[createProcessingJob] Empty deployment — 0 images, 0 videos");
    }

    // Atomically clean up stale state from any prior jobs and link all images
    // to the new job. Done as a single transaction so a partial failure can't
    // leave detections, identifications, and image.jobId out of sync.
    // (matches the "Las verificaciones existentes se perderán" promise on
    // the Reprocesar dialog):
    //   1. Delete ML-owned detections (jobId IS NOT NULL). Manual detections
    //      (jobId IS NULL) are user-created and preserved. Identifications
    //      cascade via the FK on detection_id.
    //   2. Reset confirmed_blank on every image — a re-run is a clean
    //      re-evaluation, so prior "blank" judgments shouldn't carry over.
    //   3. Reset verification state on identifications belonging to surviving
    //      manual detections (the ML-owned ones were just cascade-deleted).
    //   4. Insert the new job row.
    //   5. Link images to the new job, reset image status, and flip the
    //      deployment to processing.
    // setup_tag and starred* are pure user metadata and stay preserved.
    const imageIds = deploymentImages.map((i) => i.id);
    const job = db.transaction((tx) => {
      // Destructive cleanup runs only for full reprocesses. Incremental jobs
      // touch only the new pending images, leaving existing detections,
      // identifications, and confirmedBlank flags intact.
      if (!incremental && imageIds.length > 0) {
        tx.delete(detections)
          .where(
            and(
              inArray(detections.imageId, imageIds),
              sql`${detections.jobId} IS NOT NULL`
            )
          )
          .run();

        tx.update(images)
          .set({ confirmedBlank: false })
          .where(eq(images.deploymentId, deploymentId))
          .run();

        const remainingDetectionIds = tx
          .select({ id: detections.id })
          .from(detections)
          .where(inArray(detections.imageId, imageIds))
          .all();

        if (remainingDetectionIds.length > 0) {
          tx.update(identifications)
            .set({
              verificationStatus: "unverified",
              correctedSpecies: null,
              verifiedBy: null,
              verifiedAt: null,
            })
            .where(
              inArray(
                identifications.detectionId,
                remainingDetectionIds.map((d) => d.id)
              )
            )
            .run();
        }
      }

      const inserted = tx
        .insert(processingJobs)
        .values({
          deploymentId,
          jobType: incremental ? "ml_incremental" : "ml",
          detectorModel: modelConfig?.detectorModel || ML_DEFAULTS.detectorModel,
          classifierModel: modelConfig?.classifierModel || ML_DEFAULTS.classifierModel,
          confidenceThreshold: modelConfig?.confidenceThreshold ?? ML_DEFAULTS.confidenceThreshold,
          frameExtractionRate: options?.frameExtractionRate ?? modelConfig?.frameExtractionRate ?? 1.0,
          compressFirst: options?.compressFirst ?? false,
          videoTimestampMethod: options?.videoTimestampMethod ?? "metadata",
          status: "pending",
          totalImages: deploymentImages.length,
          totalVideos: deploymentVideos.length,
          processedImages: 0,
          failedImages: 0,
          createdBy: user.email,
        })
        .returning()
        .get();

      if (imageIds.length > 0) {
        tx.update(images)
          .set({ jobId: inserted.id, status: "pending", errorMessage: null })
          .where(inArray(images.id, imageIds))
          .run();
      }

      // Incremental jobs don't flip the deployment to "processing" — the
      // active-job query already prevents concurrent runs, and keeping the
      // deployment in its prior state (e.g. "processed") avoids confusing the
      // UI during the run. The success-path finalization in processJobInternal
      // will set it to "processed" when the job completes (which is what we
      // want anyway: any deployment with newly added images can no longer be
      // considered fully verified).
      if (!incremental) {
        tx.update(deployments)
          .set({ status: "processing", updatedAt: new Date() })
          .where(eq(deployments.id, deploymentId))
          .run();
      }

      return inserted;
    });

    revalidatePath(CAMERA_TRAP_PATH);

    return { success: true, data: { jobId: job.id } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al crear trabajo",
    };
  }
}

/**
 * Check if a job is still in an expected active state. Returns false if the
 * job was externally marked as failed/cancelled (e.g., by stuck job recovery
 * during a hot-reload or server restart).
 */
async function isJobStillActive(jobId: number): Promise<boolean> {
  const [job] = await db
    .select({ status: processingJobs.status })
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId));
  return job?.status === "processing" || job?.status === "pending";
}

/**
 * Internal processing logic — no auth check, safe revalidatePath.
 *
 * Called by the exported `processJob` server action (which adds auth)
 * and by `processNextInQueue` / batch processing (which run outside
 * a request context where requirePermission/revalidatePath would fail).
 */
async function processJobInternal(
  jobId: number
): Promise<ActionResult<{ job: ProcessingJob }>> {
  let cacheDir: string | undefined;

  try {
    const [job] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId));

    if (!job) {
      return { success: false, error: `Trabajo no encontrado: ${jobId}` };
    }

    if (job.status !== "pending") {
      return {
        success: false,
        error: `El trabajo no está pendiente (estado: ${job.status})`,
      };
    }

    await db
      .update(processingJobs)
      .set({
        status: "processing",
        startedAt: new Date(),
        statusMessage: "Iniciando procesamiento...",
      })
      .where(eq(processingJobs.id, jobId));

    // Check if this is a Drive-based deployment
    const [deployment] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, job.deploymentId));

    if (!deployment) {
      return { success: false, error: "Instalación no encontrada" };
    }

    // For Drive deployments: download images + videos to persistent cache
    if (deployment.driveFolderId) {
      // Cancellation check — read job status from DB between download batches
      const checkCancelled = async (): Promise<boolean> => {
        const [j] = await db.select({ status: processingJobs.status })
          .from(processingJobs).where(eq(processingJobs.id, jobId));
        return !j || j.status !== "processing";
      };

      // --- Download images ---
      log.info({ jobId }, "[process] starting image download phase");

      const downloadResult = await downloadDeploymentForProcessing(
        deployment.id,
        jobId,
        async (event) => {
          if (event.phase === "preflight") {
            const msg = event.cached > 0
              ? `${event.cached} en caché, descargando ${event.toDownload}...`
              : `Descargando ${event.toDownload} imágenes de Drive...`;
            await db.update(processingJobs).set({
              cachedImages: event.cached,
              downloadTotal: event.toDownload,
              statusMessage: event.toDownload === 0 ? `${event.cached} imágenes en caché` : msg,
            }).where(eq(processingJobs.id, jobId));
          } else if (event.phase === "downloading") {
            await db.update(processingJobs).set({
              downloadedImages: event.downloaded,
              statusMessage: event.failed > 0
                ? `Descargando... ${event.downloaded} de ${event.total} (${event.failed} fallidos)`
                : `Descargando... ${event.downloaded} de ${event.total}`,
            }).where(eq(processingJobs.id, jobId));
          } else if (event.phase === "thumbnails") {
            await db.update(processingJobs).set({
              statusMessage: `Generando miniaturas... ${event.generated} de ${event.total}`,
            }).where(eq(processingJobs.id, jobId));
          }
        },
        checkCancelled,
      );
      cacheDir = downloadResult.cacheDir;

      // --- Download videos ---
      const deploymentVideos = await db
        .select()
        .from(videos)
        .where(eq(videos.deploymentId, deployment.id));

      if (deploymentVideos.length > 0) {
        log.info({ jobId }, "[process] starting video download phase");

        await downloadVideosForProcessing(
          deployment.id,
          jobId,
          async (event) => {
            if (event.phase === "preflight") {
              const msg = event.cached > 0
                ? `${event.cached} videos en caché, descargando ${event.toDownload}...`
                : `Descargando ${event.toDownload} videos de Drive...`;
              await db.update(processingJobs).set({
                statusMessage: event.toDownload === 0 ? `${event.cached} videos en caché` : msg,
              }).where(eq(processingJobs.id, jobId));
            } else if (event.phase === "downloading") {
              await db.update(processingJobs).set({
                statusMessage: event.failed > 0
                  ? `Descargando videos... ${event.downloaded} de ${event.total} (${event.failed} fallidos)`
                  : `Descargando videos... ${event.downloaded} de ${event.total}`,
              }).where(eq(processingJobs.id, jobId));
            }
          },
          checkCancelled,
        );
      }

      // Fail only if nothing was downloaded/cached for both images AND videos
      const hasImages = downloadResult.downloaded > 0 || downloadResult.skipped > 0;
      const hasVideos = deploymentVideos.some((v) => v.path || v.driveFileId);
      if (!hasImages && !hasVideos && (deployment.totalImages ?? 0) > 0) {
        await db
          .update(processingJobs)
          .set({
            status: "failed",
            errorMessage: "No se pudieron descargar archivos de Drive",
            statusMessage: null,
            completedAt: new Date(),
          })
          .where(eq(processingJobs.id, jobId));

        await db
          .update(deployments)
          .set({ status: "scanned", updatedAt: new Date() })
          .where(eq(deployments.id, job.deploymentId));

        safeRevalidate();
        return {
          success: false,
          error: "No se pudieron descargar archivos de Drive",
        };
      }

      // --- Extract frames from videos ---
      const videosWithPaths = await db
        .select()
        .from(videos)
        .where(eq(videos.deploymentId, deployment.id));

      // Videos already fully extracted — skip them, their frames are re-assigned to this job
      // Videos that need (re-)extraction — have a local path but aren't fully processed
      const videosToExtract = videosWithPaths.filter(
        (v) => v.path && v.status !== "processed"
      );

      if (videosToExtract.length > 0) {
        const fps = job.frameExtractionRate ?? 1.0;
        const tsMethod = job.videoTimestampMethod ?? "metadata";
        let totalExtractedFrames = 0;
        const FFMPEG_CONCURRENCY = 4;

        const thumbDir = path.join(
          process.cwd(),
          "data",
          "thumbnails",
          String(deployment.id)
        );
        await fs.mkdir(thumbDir, { recursive: true });

        // For "filename_folder" method, pre-fetch each video's Drive parent
        // folder name (date). Cache per parent folder ID to avoid redundant calls.
        const folderDateCache = new Map<string, string | null>();
        async function getFolderDateForVideo(driveFileId: string | null): Promise<string | null> {
          if (!driveFileId || tsMethod !== "filename_folder") return null;
          if (folderDateCache.has(driveFileId)) return folderDateCache.get(driveFileId)!;
          try {
            const { getDriveFileParentName } = await import("@/lib/drive-client");
            const name = await getDriveFileParentName(driveFileId);
            const match = name?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
            const date = match ? `${match[1]}-${match[2]}-${match[3]}` : null;
            folderDateCache.set(driveFileId, date);
            return date;
          } catch {
            folderDateCache.set(driveFileId, null);
            return null;
          }
        }

        // Process videos in parallel batches (up to FFMPEG_CONCURRENCY at a time)
        for (let i = 0; i < videosToExtract.length; i += FFMPEG_CONCURRENCY) {
          const batch = videosToExtract.slice(i, i + FFMPEG_CONCURRENCY);
          const batchEnd = Math.min(i + batch.length, videosToExtract.length);

          await db
            .update(processingJobs)
            .set({
              statusMessage: `Extrayendo cuadros de video... (${i + 1}–${batchEnd} de ${videosToExtract.length})`,
            })
            .where(eq(processingJobs.id, jobId));

          await Promise.all(batch.map(async (vid) => {
            // Clean up partial frames from a previous interrupted extraction
            await db
              .delete(images)
              .where(and(eq(images.videoId, vid.id), eq(images.deploymentId, deployment.id)));

            // Use vid.id prefix for unique frame filenames (prevents collisions with parallel extraction)
            const baseName = `vid${vid.id}_${vid.filename.replace(/\.[^.]+$/, "")}`;
            const result = await extractFrames(
              vid.path!,
              cacheDir!,
              baseName,
              fps
            );

            // Update video status and duration
            await db
              .update(videos)
              .set({
                status: result.error && result.frames.length === 0 ? "failed" : "processed",
                duration: result.duration || null,
                errorMessage: result.error ?? null,
              })
              .where(eq(videos.id, vid.id));

            // Compute the video's start time based on the selected method
            let videoStartMs: number | null = null;
            if (tsMethod === "metadata") {
              videoStartMs = result.creationTime ? result.creationTime.getTime() : null;
            } else if (tsMethod === "filename_folder") {
              // Parse HHMMSS from filename + date from Drive parent folder
              const timeMatch = vid.filename.match(/^(\d{2})(\d{2})(\d{2})_/);
              if (timeMatch) {
                const folderDate = await getFolderDateForVideo(vid.driveFileId);
                if (folderDate) {
                  const ts = new Date(`${folderDate}T${timeMatch[1]}:${timeMatch[2]}:${timeMatch[3]}`);
                  if (!isNaN(ts.getTime())) {
                    videoStartMs = ts.getTime();
                  }
                }
              }
            }
            // tsMethod === "none" → videoStartMs stays null

            // Insert frame rows and collect IDs for thumbnail generation
            const frameRecords: { id: number; framePath: string; frameName: string }[] = [];
            for (const frame of result.frames) {
              const frameName = path.basename(frame.path);
              const frameTimestamp = videoStartMs !== null
                ? new Date(videoStartMs + (frame.index / fps) * 1000).toISOString()
                : null;
              const [frameImage] = await db
                .insert(images)
                .values({
                  deploymentId: deployment.id,
                  jobId: jobId,
                  filename: frameName,
                  path: frame.path,
                  videoId: vid.id,
                  frameIndex: frame.index,
                  status: "pending",
                  exifTimestamp: frameTimestamp,
                })
                .returning();
              frameRecords.push({ id: frameImage.id, framePath: frame.path, frameName });
            }

            // Generate thumbnails (outside transaction — I/O heavy)
            const sharp = (await import("sharp")).default;
            for (const { id, framePath, frameName } of frameRecords) {
              try {
                const thumbPath = path.join(thumbDir, `${id}.jpg`);
                const imgData = await fs.readFile(framePath);
                const thumb = await sharp(imgData)
                  .resize(400)
                  .jpeg({ quality: 80 })
                  .toBuffer();
                await fs.writeFile(thumbPath, thumb);
              } catch (err) {
                log.warn(
                  { err, frameName },
                  "[processJob] Thumbnail failed for frame"
                );
              }
            }

            totalExtractedFrames += result.frames.length;
          }));
        }

        // Upload extracted frames to Drive (before ML, so driveFileId survives eviction)
        if (deployment.driveFolderId && totalExtractedFrames > 0) {
          await db
            .update(processingJobs)
            .set({ statusMessage: "Subiendo cuadros a Drive..." })
            .where(eq(processingJobs.id, jobId));

          // Gather all frame image rows for this job that came from videos
          const frameImages = await db
            .select()
            .from(images)
            .where(
              and(
                eq(images.jobId, jobId),
                isNotNull(images.videoId)
              )
            );

          const framesToUpload = frameImages
            .filter((img) => img.path && !img.driveFileId)
            .map((img) => ({
              localPath: img.path!,
              filename: img.filename,
              imageId: img.id,
            }));

          if (framesToUpload.length > 0) {
            const driveFileIds = await uploadFramesToDrive(
              deployment.driveFolderId,
              framesToUpload,
              async (uploaded, total) => {
                await db
                  .update(processingJobs)
                  .set({
                    statusMessage: `Subiendo cuadros a Drive... (${uploaded} de ${total})`,
                  })
                  .where(eq(processingJobs.id, jobId));
              }
            );

            // Set driveFileId on each uploaded frame
            for (const frame of framesToUpload) {
              const driveFileId = driveFileIds.get(frame.filename);
              if (driveFileId) {
                await db
                  .update(images)
                  .set({ driveFileId })
                  .where(eq(images.id, frame.imageId));
              }
            }

            log.info(
              { uploaded: driveFileIds.size, total: framesToUpload.length },
              "[processJob] Uploaded frames to Drive"
            );
          }

          // Delete local source videos from cache (originals are on Drive)
          for (const vid of videosToExtract) {
            if (vid.path) {
              try {
                await fs.unlink(vid.path);
                log.info({ path: vid.path }, "[processJob] Deleted cached video");
              } catch {
                // File may already be gone
              }
            }
          }
        }

        // Update job counts to include extracted frames
        await db
          .update(processingJobs)
          .set({
            extractedFrames: totalExtractedFrames,
            totalImages: sql`${processingJobs.totalImages} + ${totalExtractedFrames}`,
          })
          .where(eq(processingJobs.id, jobId));
      }
    }

    // --- Zombie check: bail out if job was externally killed (e.g., hot-reload recovery) ---
    if (!(await isJobStillActive(jobId))) {
      log.warn({ jobId }, "[processJob] Job is no longer active after download phase — aborting");
      return { success: false, error: "Job was externally terminated" };
    }

    // --- Optional compression phase (compress in cache before ML) ---
    if (job.compressFirst) {
      await db
        .update(processingJobs)
        .set({ statusMessage: "Comprimiendo imágenes..." })
        .where(eq(processingJobs.id, jobId));

      // Get uncompressed JPEG images for this deployment
      const uncompressedJpegs = (await db
        .select()
        .from(images)
        .where(
          and(
            eq(images.deploymentId, deployment.id),
            eq(images.compressed, false),
          ),
        )).filter((img) => {
        const ext = path.extname(img.filename).toLowerCase();
        return ext === ".jpg" || ext === ".jpeg";
      });

      if (uncompressedJpegs.length > 0) {
        const { compressImageBatch } = await import("./drive-actions");
        await compressImageBatch(
          uncompressedJpegs.map((img) => ({ ...img, deploymentId: deployment.id })),
          { uploadToDrive: true, jobId, deploymentId: deployment.id },
          async (compressed, failed) => {
            const processedSoFar = compressed + failed;
            await db
              .update(processingJobs)
              .set({
                statusMessage: `Comprimiendo... (${processedSoFar} de ${uncompressedJpegs.length})`,
              })
              .where(eq(processingJobs.id, jobId));
          },
        );
      }
    }

    // --- Zombie check before ML phase ---
    if (!(await isJobStillActive(jobId))) {
      log.warn({ jobId }, "[processJob] Job is no longer active after compression phase — aborting");
      return { success: false, error: "Job was externally terminated" };
    }

    // Re-fetch job images (paths may have been updated by download + frame extraction)
    const jobImages = await db
      .select()
      .from(images)
      .where(eq(images.jobId, jobId));

    // Empty deployment — nothing to analyze, complete successfully
    if (jobImages.length === 0) {
      if (cacheDir) await cleanupJobTempDir(jobId, cacheDir);

      await db
        .update(processingJobs)
        .set({
          status: "completed",
          completedAt: new Date(),
          statusMessage: null,
        })
        .where(eq(processingJobs.id, jobId));

      await db
        .update(deployments)
        .set({ status: "processed", updatedAt: new Date() })
        .where(eq(deployments.id, job.deploymentId));

      safeRevalidate();
      processNextInQueue();

      const [updatedJob] = await db
        .select()
        .from(processingJobs)
        .where(eq(processingJobs.id, jobId));

      return { success: true, data: { job: updatedJob } };
    }

    // No mock fallback — ML must work
    log.info("[processJob] Checking ML availability...");
    await db
      .update(processingJobs)
      .set({ statusMessage: "Verificando disponibilidad ML..." })
      .where(eq(processingJobs.id, jobId));

    const mlCheck = await checkPytorchWildlife();
    log.info({ available: mlCheck.available, message: mlCheck.message }, "[processJob] ML check");

    if (!mlCheck.available) {
      if (cacheDir) await cleanupJobTempDir(jobId, cacheDir);

      await db
        .update(processingJobs)
        .set({
          status: "failed",
          errorMessage: mlCheck.message,
          statusMessage: null,
          completedAt: new Date(),
        })
        .where(eq(processingJobs.id, jobId));

      // Incremental jobs don't downgrade the deployment status on failure —
      // the prior state (processed/verified) is still accurate because no
      // images were touched.
      if (job.jobType !== "ml_incremental") {
        await db
          .update(deployments)
          .set({ status: "scanned", updatedAt: new Date() })
          .where(eq(deployments.id, job.deploymentId));
      }

      safeRevalidate();

      return { success: false, error: mlCheck.message };
    }

    log.info(
      { total: jobImages.length, withPaths: jobImages.filter((i) => i.path).length },
      "[processJob] Starting ML predictions"
    );
    await db
      .update(processingJobs)
      .set({ statusMessage: "Cargando modelos ML..." })
      .where(eq(processingJobs.id, jobId));

    const mlResult = await runMLPredictions(jobId, {
      imagePaths: jobImages
        .map((img) => img.path)
        .filter((p): p is string => p !== null),
      detectorModel: job.detectorModel || ML_DEFAULTS.detectorModel,
      classifierModel: job.classifierModel || ML_DEFAULTS.classifierModel,
      device: "auto",
      confidenceThreshold: job.confidenceThreshold ?? ML_DEFAULTS.confidenceThreshold,
      batchSize: ML_DEFAULTS.batchSize,
      numWorkers: ML_DEFAULTS.numWorkers,
    });

    log.info(
      {
        success: mlResult.success,
        processed: mlResult.totalProcessed,
        detections: mlResult.totalDetections,
        err: mlResult.error || "none",
      },
      "[processJob] ML result"
    );

    // Cache persists after processing — no cleanup on success

    const finalStatus = mlResult.success ? "completed" : "failed";

    await db
      .update(processingJobs)
      .set({
        status: finalStatus,
        completedAt: new Date(),
        errorMessage: mlResult.error || null,
        statusMessage: null,
      })
      .where(eq(processingJobs.id, jobId));

    // For incremental jobs on success: flip to "processed" (per the chosen
    // status policy — any deployment with newly added images can no longer
    // claim to be fully verified). For incremental jobs on failure: leave
    // the deployment in its prior state, since no work was done.
    if (finalStatus === "completed" || job.jobType !== "ml_incremental") {
      await db
        .update(deployments)
        .set({
          status: finalStatus === "completed" ? "processed" : "scanned",
          updatedAt: new Date(),
        })
        .where(eq(deployments.id, job.deploymentId));
    }

    safeRevalidate();

    // Auto-advance queue
    processNextInQueue();

    const [updatedJob] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId));

    return mlResult.success
      ? { success: true, data: { job: updatedJob } }
      : { success: false, error: mlResult.error || "Procesamiento falló" };
  } catch (error) {
    log.error({ err: error }, "[processJob] Unhandled error");
    // cleanupJobTempDir is cache-aware — only cleans legacy temp dirs
    if (cacheDir) {
      try {
        await cleanupJobTempDir(jobId, cacheDir);
      } catch {
        // Best effort cleanup
      }
    }

    await db
      .update(processingJobs)
      .set({
        status: "failed",
        errorMessage: error instanceof Error ? error.message : "Procesamiento falló",
        statusMessage: null,
        completedAt: new Date(),
      })
      .where(eq(processingJobs.id, jobId));

    // Revert deployment status from "processing" to "scanned" — but not for
    // incremental jobs, which never flipped the deployment to "processing"
    // and shouldn't downgrade a previously processed/verified deployment.
    const [failedJob] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId));
    if (failedJob && failedJob.jobType !== "ml_incremental") {
      await db
        .update(deployments)
        .set({ status: "scanned", updatedAt: new Date() })
        .where(eq(deployments.id, failedJob.deploymentId));
    }

    safeRevalidate();

    // Auto-advance queue even on failure
    processNextInQueue();

    return {
      success: false,
      error: error instanceof Error ? error.message : "Procesamiento falló",
    };
  }
}

/** Safe revalidatePath — silently ignores errors when called outside a request context. */
function safeRevalidate(): void {
  try {
    revalidatePath(CAMERA_TRAP_PATH);
  } catch {
    // Called outside request context (e.g. fire-and-forget queue) — client polls for updates
  }
}

/**
 * Process a job. No mock fallback — ML works via ML_PYTHON_PATH or fails.
 *
 * For Drive-based deployments: downloads images to persistent cache,
 * skips already-cached files, writes cache paths to images.path, runs ML.
 * Cache persists after processing for annotation and re-processing.
 */
export async function processJob(
  jobId: number
): Promise<ActionResult<{ job: ProcessingJob }>> {
  const user = await requirePermission("camera-trap", "editor");

  const [job] = await db
    .select({ deploymentId: processingJobs.deploymentId })
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId));
  if (!job) return { success: false, error: "Trabajo no encontrado" };

  try {
    await requireDeploymentAccess(user, job.deploymentId);
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Sin acceso" };
  }

  return processJobInternal(jobId);
}

export async function getMLStatus() {
  await requirePermission("camera-trap", "viewer");
  return checkPytorchWildlife();
}

// ---------------------------------------------------------------------------
// Cancel Job — Actually kills subprocess via PID
// ---------------------------------------------------------------------------

export async function cancelJob(
  jobId: number
): Promise<ActionResult> {
  const user = await requirePermission("camera-trap", "editor");

  try {
    const [job] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId));

    if (!job) {
      return { success: false, error: "Trabajo no encontrado" };
    }

    await requireDeploymentAccess(user, job.deploymentId);

    // Cancel any running frame extraction
    cancelFrameExtraction();

    // Graceful cancel via stdin (model server stays alive)
    cancelModelServerJob();

    // Fallback: kill the subprocess if PID is stored
    if (job.pid) {
      try {
        process.kill(job.pid, "SIGTERM");
      } catch {
        // Process may have already exited
      }
    }

    // Clean up temp directory for Drive-based jobs
    try {
      await cleanupJobTempDir(jobId);
    } catch {
      // Best effort cleanup
    }

    // Reset images that were reassigned to this job back to unassigned
    await db
      .update(images)
      .set({ status: "pending", jobId: null })
      .where(eq(images.jobId, jobId));

    // Delete any detections created by this (partial) job
    await db.delete(detections).where(eq(detections.jobId, jobId));

    await db
      .update(processingJobs)
      .set({ status: "cancelled", completedAt: new Date(), statusMessage: null })
      .where(eq(processingJobs.id, jobId));

    // If a previous completed job exists, restore deployment to "processed";
    // otherwise revert to "scanned"
    const previousCompleted = await db
      .select({ id: processingJobs.id })
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.deploymentId, job.deploymentId),
          eq(processingJobs.status, "completed")
        )
      );

    const newStatus = previousCompleted.length > 0 ? "processed" : "scanned";
    await db
      .update(deployments)
      .set({ status: newStatus, updatedAt: new Date() })
      .where(eq(deployments.id, job.deploymentId));

    // If restoring to a previous job, reassign images back to that job
    if (previousCompleted.length > 0) {
      const prevJobId = previousCompleted[0].id;
      await db
        .update(images)
        .set({ jobId: prevJobId, status: "processed" })
        .where(
          and(
            eq(images.deploymentId, job.deploymentId),
            sql`${images.jobId} IS NULL`
          )
        );
    }

    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al cancelar",
    };
  }
}

// ---------------------------------------------------------------------------
// Delete Job — Auto-cancels active jobs, cascades detections/identifications
// ---------------------------------------------------------------------------

export async function deleteJob(
  jobId: number
): Promise<ActionResult> {
  const user = await requirePermission("camera-trap", "editor");

  try {
    const [job] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId));

    if (!job) {
      return { success: false, error: "Trabajo no encontrado" };
    }

    await requireDeploymentAccess(user, job.deploymentId);

    // Auto-cancel if active (graceful cancel + kill subprocess, clean up temp dir)
    if (job.status === "processing" || job.status === "pending") {
      cancelModelServerJob();
      if (job.pid) {
        try {
          process.kill(job.pid, "SIGTERM");
        } catch {
          // Process may have already exited
        }
      }
      try {
        await cleanupJobTempDir(jobId);
      } catch {
        // Best effort cleanup
      }
    }

    // 1. Reset images that belonged to this job
    await db
      .update(images)
      .set({ status: "pending", jobId: null })
      .where(eq(images.jobId, jobId));

    // 2. Explicitly delete ML detections for this job (manual detections have job_id=NULL, unaffected)
    await db.delete(detections).where(eq(detections.jobId, jobId));

    // 3. Delete the job
    await db.delete(processingJobs).where(eq(processingJobs.id, jobId));

    // 4. Check for remaining completed jobs
    const remainingJobs = await db
      .select({ id: processingJobs.id })
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.deploymentId, job.deploymentId),
          eq(processingJobs.status, "completed")
        )
      );

    if (remainingJobs.length > 0) {
      // Reassign orphaned images back to the most recent completed job
      const prevJobId = remainingJobs[0].id;
      await db
        .update(images)
        .set({ jobId: prevJobId, status: "processed" })
        .where(
          and(
            eq(images.deploymentId, job.deploymentId),
            sql`${images.jobId} IS NULL`
          )
        );
      // Restore deployment to "processed" if it was reverted
      await db
        .update(deployments)
        .set({ status: "processed", updatedAt: new Date() })
        .where(eq(deployments.id, job.deploymentId));
    } else {
      await db
        .update(deployments)
        .set({ status: "scanned", updatedAt: new Date() })
        .where(eq(deployments.id, job.deploymentId));
    }

    await db.insert(activityLog).values({
      userEmail: user.email,
      action: "delete_job",
      projectId: "camera-trap",
      targetType: "job",
      targetId: String(jobId),
      details: JSON.stringify({ deploymentId: job.deploymentId }),
    });

    revalidatePath("/camera-trap/results");
    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al eliminar trabajo",
    };
  }
}

/** Get deletion stats for a single job (detection + verified counts). */
export async function getJobDeleteStats(
  jobId: number
): Promise<{ detectionsCount: number; verifiedCount: number }> {
  const user = await requirePermission("camera-trap", "viewer");

  const [job] = await db
    .select({ deploymentId: processingJobs.deploymentId })
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId));
  if (!job) return { detectionsCount: 0, verifiedCount: 0 };

  try {
    await requireDeploymentAccess(user, job.deploymentId);
  } catch {
    return { detectionsCount: 0, verifiedCount: 0 };
  }

  const [detStats] = await db
    .select({ cnt: count() })
    .from(detections)
    .where(eq(detections.jobId, jobId));

  const detectionsCount = detStats?.cnt ?? 0;
  if (detectionsCount === 0) return { detectionsCount: 0, verifiedCount: 0 };

  const jobDetectionIds = (
    await db
      .select({ id: detections.id })
      .from(detections)
      .where(eq(detections.jobId, jobId))
  ).map((d) => d.id);

  const [verStats] = await db
    .select({ cnt: count() })
    .from(identifications)
    .where(
      and(
        inArray(identifications.detectionId, jobDetectionIds),
        ne(identifications.verificationStatus, "unverified")
      )
    );

  return { detectionsCount, verifiedCount: verStats?.cnt ?? 0 };
}

/** Get aggregated deletion stats for multiple jobs. */
export async function getJobsDeleteStats(
  jobIds: number[]
): Promise<{ totalDetections: number; totalVerified: number }> {
  const user = await requirePermission("camera-trap", "viewer");

  if (jobIds.length === 0) return { totalDetections: 0, totalVerified: 0 };

  // Verify access to all jobs' deployments
  const jobRows = await db
    .select({ deploymentId: processingJobs.deploymentId })
    .from(processingJobs)
    .where(inArray(processingJobs.id, jobIds));
  for (const j of jobRows) {
    try {
      await requireDeploymentAccess(user, j.deploymentId);
    } catch {
      return { totalDetections: 0, totalVerified: 0 };
    }
  }

  const [detStats] = await db
    .select({ cnt: count() })
    .from(detections)
    .where(inArray(detections.jobId, jobIds));

  const totalDetections = detStats?.cnt ?? 0;
  if (totalDetections === 0) return { totalDetections: 0, totalVerified: 0 };

  const detectionIds = (
    await db
      .select({ id: detections.id })
      .from(detections)
      .where(inArray(detections.jobId, jobIds))
  ).map((d) => d.id);

  let totalVerified = 0;
  if (detectionIds.length > 0) {
    const [verStats] = await db
      .select({ cnt: count() })
      .from(identifications)
      .where(
        and(
          inArray(identifications.detectionId, detectionIds),
          ne(identifications.verificationStatus, "unverified")
        )
      );
    totalVerified = verStats?.cnt ?? 0;
  }

  return { totalDetections, totalVerified };
}

/** Batch delete multiple jobs. Reuses deleteJob logic for each. */
export async function deleteJobs(
  jobIds: number[]
): Promise<ActionResult<{ count: number }>> {
  const user = await requirePermission("camera-trap", "editor");

  if (jobIds.length === 0) {
    return { success: true, data: { count: 0 } };
  }

  try {
    for (const jobId of jobIds) {
      const [job] = await db
        .select()
        .from(processingJobs)
        .where(eq(processingJobs.id, jobId));

      if (!job) continue;

      await requireDeploymentAccess(user, job.deploymentId);

      // Auto-cancel if active
      if (job.status === "processing" || job.status === "pending") {
        cancelModelServerJob();
        if (job.pid) {
          try {
            process.kill(job.pid, "SIGTERM");
          } catch {
            // Process may have already exited
          }
        }
        try {
          await cleanupJobTempDir(jobId);
        } catch {
          // Best effort cleanup
        }
      }

      // Reset images
      await db
        .update(images)
        .set({ status: "pending", jobId: null })
        .where(eq(images.jobId, jobId));

      // Explicitly delete ML detections for this job
      await db.delete(detections).where(eq(detections.jobId, jobId));

      // Delete job
      await db.delete(processingJobs).where(eq(processingJobs.id, jobId));

      // If no completed jobs remain, revert deployment to "scanned"
      const remainingJobs = await db
        .select({ id: processingJobs.id })
        .from(processingJobs)
        .where(
          and(
            eq(processingJobs.deploymentId, job.deploymentId),
            eq(processingJobs.status, "completed")
          )
        );

      if (remainingJobs.length === 0) {
        await db
          .update(deployments)
          .set({ status: "scanned", updatedAt: new Date() })
          .where(eq(deployments.id, job.deploymentId));
      }
    }

    await db.insert(activityLog).values({
      userEmail: user.email,
      action: "delete_jobs",
      projectId: "camera-trap",
      targetType: "job",
      details: JSON.stringify({ jobIds, count: jobIds.length }),
    });

    revalidatePath("/camera-trap/results");
    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: { count: jobIds.length } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al eliminar trabajos",
    };
  }
}

// ---------------------------------------------------------------------------
// Query Functions
// ---------------------------------------------------------------------------

/** Row shape returned to the table UI (deployment + computed stats). */
export interface DeploymentRow {
  id: number;
  name: string;
  status: string;
  driveFolderId: string | null;
  projectLabel: string | null;
  cameraTrapProjectId: number | null;
  siteName: string | null;
  latitude: number | null;
  longitude: number | null;
  dateStart: string | null;
  dateEnd: string | null;
  totalImages: number | null;
  totalVideos: number | null;
  odkSubmissionId: string | null;
  metadataSource: string | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
  excluded: boolean;
  validStart: string | null;
  validEnd: string | null;
  qaNotes: string | null;
  lastProcessedAt: Date | null;
  lastJobStatus: string | null;
  lastCompletedJobId: number | null;
  jobCount: number;
  totalDetections: number | null;
  distinctSpecies: number | null;
  revertibleImageCount: number;
  reviewedCount: number | null;
  totalIdentifications: number | null;
  pendingImageCount: number;
  pendingVideoCount: number;
}

export async function getDeploymentsWithStats(): Promise<DeploymentRow[]> {
  const user = await requirePermission("camera-trap", "viewer");
  const ctProjects = await getUserCameraTrapProjects(user);

  const allDeployments = await db
    .select()
    .from(deployments)
    .where(and(eq(deployments.projectId, "camera-trap"), ctProjectFilter(ctProjects)))
    .orderBy(desc(deployments.updatedAt));

  if (allDeployments.length === 0) return [];

  const deploymentIds = allDeployments.map((d) => d.id);

  // Batch: latest job per deployment
  const latestJobs = await db
    .select({
      deploymentId: processingJobs.deploymentId,
      completedAt: sql<number>`MAX(${processingJobs.completedAt})`.as("completed_at_max"),
      status: processingJobs.status,
      cnt: count(),
    })
    .from(processingJobs)
    .where(inArray(processingJobs.deploymentId, deploymentIds))
    .groupBy(processingJobs.deploymentId);

  const jobMap = new Map(latestJobs.map((j) => [j.deploymentId, j]));

  // For each deployment that has jobs, get the actual latest job to get its status
  const latestJobStatuses = await db
    .select({
      deploymentId: processingJobs.deploymentId,
      status: processingJobs.status,
      completedAt: processingJobs.completedAt,
    })
    .from(processingJobs)
    .where(inArray(processingJobs.deploymentId, deploymentIds))
    .orderBy(desc(processingJobs.createdAt));

  const latestStatusMap = new Map<number, { status: string; completedAt: Date | null }>();
  for (const row of latestJobStatuses) {
    if (!latestStatusMap.has(row.deploymentId)) {
      latestStatusMap.set(row.deploymentId, {
        status: row.status,
        completedAt: row.completedAt,
      });
    }
  }

  // Latest completed job ID per deployment (for direct "Ver Resultados" link)
  const completedJobs = await db
    .select({
      id: processingJobs.id,
      deploymentId: processingJobs.deploymentId,
    })
    .from(processingJobs)
    .where(
      and(
        inArray(processingJobs.deploymentId, deploymentIds),
        eq(processingJobs.status, "completed")
      )
    )
    .orderBy(desc(processingJobs.completedAt));

  const completedJobMap = new Map<number, number>();
  for (const row of completedJobs) {
    if (!completedJobMap.has(row.deploymentId)) {
      completedJobMap.set(row.deploymentId, row.id);
    }
  }

  // Batch: revertible image counts per deployment
  const revertibleCounts = await db
    .select({
      deploymentId: images.deploymentId,
      cnt: count(),
    })
    .from(images)
    .where(
      and(
        inArray(images.deploymentId, deploymentIds),
        eq(images.compressed, true),
        sql`${images.originalFileSize} IS NOT NULL`,
        sql`${images.driveFileId} IS NOT NULL`,
      ),
    )
    .groupBy(images.deploymentId);
  const revertCountMap = new Map(revertibleCounts.map((r) => [r.deploymentId, r.cnt]));

  // Batch: pending image counts per deployment (for "new files since last process" badge)
  const pendingImageCounts = await db
    .select({
      deploymentId: images.deploymentId,
      cnt: count(),
    })
    .from(images)
    .where(
      and(
        inArray(images.deploymentId, deploymentIds),
        eq(images.status, "pending"),
      ),
    )
    .groupBy(images.deploymentId);
  const pendingImageCountMap = new Map(
    pendingImageCounts.map((r) => [r.deploymentId, r.cnt]),
  );

  // Batch: pending video counts per deployment (mirrors pendingImageCounts —
  // drives the "Procesar nuevas" badge for video-bearing deployments).
  const pendingVideoCounts = await db
    .select({
      deploymentId: videos.deploymentId,
      cnt: count(),
    })
    .from(videos)
    .where(
      and(
        inArray(videos.deploymentId, deploymentIds),
        eq(videos.status, "pending"),
      ),
    )
    .groupBy(videos.deploymentId);
  const pendingVideoCountMap = new Map(
    pendingVideoCounts.map((r) => [r.deploymentId, r.cnt]),
  );

  // Batch: detection counts and species counts per DEPLOYMENT (not per job).
  // Counting by deployment rather than by latest completed job means
  // incremental ML runs (which add new detections without deleting prior
  // ones) keep the totals correct. For full reprocesses the destructive
  // transaction has already cleaned up prior detections so per-deployment
  // counting still matches the latest job's results.
  const detCountByDep = new Map<number, number>();
  const specCountByDep = new Map<number, number>();

  const detectionCounts = await db
    .select({ deploymentId: images.deploymentId, cnt: count() })
    .from(detections)
    .innerJoin(images, eq(detections.imageId, images.id))
    .where(inArray(images.deploymentId, deploymentIds))
    .groupBy(images.deploymentId);
  for (const r of detectionCounts) {
    detCountByDep.set(r.deploymentId, r.cnt);
  }

  const speciesCounts = await db
    .select({
      deploymentId: images.deploymentId,
      cnt: sql<number>`count(distinct coalesce(${identifications.correctedSpecies}, ${identifications.species}))`,
    })
    .from(identifications)
    .innerJoin(detections, eq(identifications.detectionId, detections.id))
    .innerJoin(images, eq(detections.imageId, images.id))
    .where(inArray(images.deploymentId, deploymentIds))
    .groupBy(images.deploymentId);
  for (const r of speciesCounts) {
    specCountByDep.set(r.deploymentId, r.cnt);
  }

  // Batch: verification progress per deployment (all identifications, not just latest job)
  const verificationCounts = await db
    .select({
      deploymentId: images.deploymentId,
      total: count(),
      reviewed: sql<number>`sum(case when ${identifications.verificationStatus} != 'unverified' then 1 else 0 end)`,
    })
    .from(identifications)
    .innerJoin(detections, eq(identifications.detectionId, detections.id))
    .innerJoin(images, eq(detections.imageId, images.id))
    .where(inArray(images.deploymentId, deploymentIds))
    .groupBy(images.deploymentId);

  // Batch: blank-reviewable images per deployment. "Blank-reviewable" means
  // the image has no identifications — so either zero detections, or only
  // person/vehicle detections (which don't get classified). These images
  // require an explicit "Confirmar vacía" action to be considered reviewed,
  // so they count toward the review workload even though they have no
  // identifications in their own right.
  const blankCounts = await db
    .select({
      deploymentId: images.deploymentId,
      blankTotal: count(),
      blankReviewed: sql<number>`sum(case when ${images.confirmedBlank} = 1 then 1 else 0 end)`,
    })
    .from(images)
    .where(
      and(
        inArray(images.deploymentId, deploymentIds),
        notExists(
          db
            .select({ one: sql`1` })
            .from(detections)
            .innerJoin(
              identifications,
              eq(identifications.detectionId, detections.id),
            )
            .where(eq(detections.imageId, images.id)),
        ),
      ),
    )
    .groupBy(images.deploymentId);

  const verificationMap = new Map<number, { reviewed: number; total: number }>();
  for (const r of verificationCounts) {
    verificationMap.set(r.deploymentId, { reviewed: Number(r.reviewed), total: r.total });
  }
  for (const r of blankCounts) {
    const existing = verificationMap.get(r.deploymentId) ?? { reviewed: 0, total: 0 };
    verificationMap.set(r.deploymentId, {
      reviewed: existing.reviewed + Number(r.blankReviewed),
      total: existing.total + r.blankTotal,
    });
  }

  return allDeployments.map((d) => {
    const jobInfo = jobMap.get(d.id);
    const latestStatus = latestStatusMap.get(d.id);
    const completedJobId = completedJobMap.get(d.id);
    return {
      id: d.id,
      name: d.name,
      status: d.status,
      driveFolderId: d.driveFolderId,
      projectLabel: d.projectLabel,
      cameraTrapProjectId: d.cameraTrapProjectId,
      siteName: d.siteName,
      latitude: d.latitude,
      longitude: d.longitude,
      dateStart: d.dateStart,
      dateEnd: d.dateEnd,
      totalImages: d.totalImages,
      totalVideos: d.totalVideos,
      odkSubmissionId: d.odkSubmissionId,
      metadataSource: d.metadataSource,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      createdBy: d.createdBy,
      excluded: d.excluded,
      validStart: d.validStart,
      validEnd: d.validEnd,
      qaNotes: d.qaNotes,
      lastProcessedAt: latestStatus?.completedAt ?? null,
      lastJobStatus: latestStatus?.status ?? null,
      lastCompletedJobId: completedJobId ?? null,
      jobCount: jobInfo?.cnt ?? 0,
      totalDetections: completedJobId != null ? (detCountByDep.get(d.id) ?? 0) : null,
      distinctSpecies: completedJobId != null ? (specCountByDep.get(d.id) ?? 0) : null,
      revertibleImageCount: revertCountMap.get(d.id) ?? 0,
      reviewedCount: verificationMap.get(d.id)?.reviewed ?? null,
      totalIdentifications: verificationMap.get(d.id)?.total ?? null,
      pendingImageCount: pendingImageCountMap.get(d.id) ?? 0,
      pendingVideoCount: pendingVideoCountMap.get(d.id) ?? 0,
    };
  });
}

export async function getDeployments(
  limit: number = 50
): Promise<Deployment[]> {
  const user = await requirePermission("camera-trap", "viewer");
  const ctProjects = await getUserCameraTrapProjects(user);
  return db
    .select()
    .from(deployments)
    .where(and(eq(deployments.projectId, "camera-trap"), ctProjectFilter(ctProjects)))
    .orderBy(desc(deployments.updatedAt))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// Deployment Metadata CRUD
// ---------------------------------------------------------------------------

export async function updateDeploymentMetadata(
  id: number,
  fields: {
    name?: string;
    projectLabel?: string | null;
    cameraTrapProjectId?: number | null;
    siteName?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    dateStart?: string | null;
    dateEnd?: string | null;
    excluded?: boolean;
    validStart?: string | null;
    validEnd?: string | null;
    qaNotes?: string | null;
  }
): Promise<ActionResult> {
  const user = await requirePermission("camera-trap", "editor");

  try {
    // Validate QA fields
    const vs = fields.validStart !== undefined ? fields.validStart : undefined;
    const ve = fields.validEnd !== undefined ? fields.validEnd : undefined;
    if (vs && ve && vs > ve) {
      return { success: false, error: "La fecha de inicio válida debe ser anterior a la fecha de fin válida" };
    }
    if (fields.qaNotes && fields.qaNotes.length > 2000) {
      return { success: false, error: "Las notas de calidad no pueden superar los 2000 caracteres" };
    }

    const [existing] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, id));

    if (!existing) {
      return { success: false, error: "Instalación no encontrada" };
    }

    await requireDeploymentAccess(user, id);

    // If changing CT project, also update projectLabel to keep in sync
    const updates: Record<string, unknown> = { ...fields };
    if (fields.cameraTrapProjectId !== undefined && fields.projectLabel === undefined) {
      if (fields.cameraTrapProjectId) {
        const [proj] = await db
          .select({ name: cameraTrapProjects.name })
          .from(cameraTrapProjects)
          .where(eq(cameraTrapProjects.id, fields.cameraTrapProjectId));
        if (proj) updates.projectLabel = proj.name;
      } else {
        updates.projectLabel = null;
      }
    }

    await db
      .update(deployments)
      .set({
        ...updates,
        metadataSource: "manual",
        updatedAt: new Date(),
      })
      .where(eq(deployments.id, id));

    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al actualizar",
    };
  }
}

/** QA-only update — no revalidatePath so the expanded row stays open. */
export async function updateDeploymentQa(
  id: number,
  fields: {
    excluded: boolean;
    validStart: string | null;
    validEnd: string | null;
    qaNotes: string | null;
  }
): Promise<ActionResult> {
  const user = await requirePermission("camera-trap", "editor");

  try {
    if (fields.validStart && fields.validEnd && fields.validStart > fields.validEnd) {
      return { success: false, error: "La fecha de inicio válida debe ser anterior a la fecha de fin válida" };
    }
    if (fields.qaNotes && fields.qaNotes.length > 2000) {
      return { success: false, error: "Las notas de calidad no pueden superar los 2000 caracteres" };
    }

    const [existing] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, id));

    if (!existing) {
      return { success: false, error: "Instalación no encontrada" };
    }

    await requireDeploymentAccess(user, id);

    await db
      .update(deployments)
      .set({
        excluded: fields.excluded,
        validStart: fields.validStart,
        validEnd: fields.validEnd,
        qaNotes: fields.qaNotes,
        updatedAt: new Date(),
      })
      .where(eq(deployments.id, id));

    // Intentionally no revalidatePath — the inline form manages its own state
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al actualizar",
    };
  }
}

export async function bulkUpdateMetadata(
  ids: number[],
  fields: {
    projectLabel?: string | null;
    cameraTrapProjectId?: number | null;
    siteName?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    dateStart?: string | null;
    dateEnd?: string | null;
    excluded?: boolean;
    qaNotes?: string | null;
  }
): Promise<ActionResult<{ count: number }>> {
  const user = await requirePermission("camera-trap", "editor");

  try {
    if (ids.length === 0) {
      return { success: true, data: { count: 0 } };
    }

    // Verify access to all deployments
    for (const id of ids) {
      await requireDeploymentAccess(user, id);
    }

    // Only include non-undefined fields (undefined = "do not change")
    const updates: Record<string, unknown> = { updatedAt: new Date(), metadataSource: "manual" };
    if (fields.cameraTrapProjectId !== undefined) {
      updates.cameraTrapProjectId = fields.cameraTrapProjectId;
      // Keep projectLabel in sync
      if (fields.cameraTrapProjectId && fields.projectLabel === undefined) {
        const [proj] = await db
          .select({ name: cameraTrapProjects.name })
          .from(cameraTrapProjects)
          .where(eq(cameraTrapProjects.id, fields.cameraTrapProjectId));
        if (proj) updates.projectLabel = proj.name;
      }
    }
    if (fields.projectLabel !== undefined) updates.projectLabel = fields.projectLabel;
    if (fields.siteName !== undefined) updates.siteName = fields.siteName;
    if (fields.latitude !== undefined) updates.latitude = fields.latitude;
    if (fields.longitude !== undefined) updates.longitude = fields.longitude;
    if (fields.dateStart !== undefined) updates.dateStart = fields.dateStart || null;
    if (fields.dateEnd !== undefined) updates.dateEnd = fields.dateEnd || null;
    if (fields.excluded !== undefined) updates.excluded = fields.excluded;
    if (fields.qaNotes !== undefined) updates.qaNotes = fields.qaNotes;

    await db
      .update(deployments)
      .set(updates)
      .where(inArray(deployments.id, ids));

    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: { count: ids.length } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al actualizar en lote",
    };
  }
}

export async function deleteDeployments(
  ids: number[]
): Promise<ActionResult<{ count: number }>> {
  const user = await requirePermission("camera-trap", "editor");

  try {
    if (ids.length === 0) {
      return { success: true, data: { count: 0 } };
    }

    // Verify access to all deployments
    for (const id of ids) {
      await requireDeploymentAccess(user, id);
    }

    // Cancel any active jobs on these deployments
    const activeJobs = await db
      .select()
      .from(processingJobs)
      .where(
        and(
          inArray(processingJobs.deploymentId, ids),
          inArray(processingJobs.status, ["pending", "processing"])
        )
      );

    for (const job of activeJobs) {
      if (job.status === "processing") {
        cancelModelServerJob();
        if (job.pid) {
          try {
            process.kill(job.pid, "SIGTERM");
          } catch {
            // Process may have already exited
          }
        }
        try {
          await cleanupJobTempDir(job.id);
        } catch {
          // Best effort cleanup
        }
      }
    }

    // Get names for audit log before deleting
    const toDelete = await db
      .select({ id: deployments.id, name: deployments.name })
      .from(deployments)
      .where(inArray(deployments.id, ids));

    // Cascade delete: deployments → images, jobs → detections → identifications
    await db
      .delete(deployments)
      .where(inArray(deployments.id, ids));

    await db.insert(activityLog).values({
      userEmail: user.email,
      action: "delete_deployments",
      projectId: "camera-trap",
      targetType: "deployment",
      details: JSON.stringify({ count: ids.length, names: toDelete.map(d => d.name) }),
    });

    revalidatePath(CAMERA_TRAP_PATH);
    revalidatePath("/camera-trap/results");
    return { success: true, data: { count: ids.length } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al eliminar",
    };
  }
}

// ---------------------------------------------------------------------------
// Delete blank images from Drive (soft-delete to trash)
// ---------------------------------------------------------------------------

import { thumbnailPath as thumbPathFn } from "@/lib/thumbnail";

const DELETE_BATCH_SIZE = 50;
const CACHE_BASE = path.join(process.cwd(), "data", "cache", "ct-images");

export async function deleteImagesFromDrive(
  imageIds: number[],
): Promise<ActionResult<{ deleted: number; failed: number }>> {
  const user = await requirePermission("camera-trap", "admin");

  try {
    if (imageIds.length === 0) {
      return { success: true, data: { deleted: 0, failed: 0 } };
    }

    // Query images and verify they exist
    const imagesToDelete = await db
      .select()
      .from(images)
      .where(inArray(images.id, imageIds));

    if (imagesToDelete.length === 0) {
      return { success: false, error: "No se encontraron imágenes" };
    }

    // Verify access to all deployments
    const deploymentIds = [...new Set(imagesToDelete.map((img) => img.deploymentId))];
    for (const depId of deploymentIds) {
      await requireDeploymentAccess(user, depId);
    }

    // Safety check: skip images that have any detections (including manual)
    const imageIdsWithDetections = new Set(
      (
        await db
          .select({ imageId: detections.imageId })
          .from(detections)
          .where(inArray(detections.imageId, imageIds))
      ).map((d) => d.imageId),
    );

    const safeImages = imagesToDelete.filter(
      (img) => !imageIdsWithDetections.has(img.id) && img.driveFileId,
    );

    let deleted = 0;
    let failed = 0;

    // Process in batches
    for (let i = 0; i < safeImages.length; i += DELETE_BATCH_SIZE) {
      const batch = safeImages.slice(i, i + DELETE_BATCH_SIZE);

      const results = await Promise.allSettled(
        batch.map(async (img) => {
          // Soft-delete to Drive trash
          await trashFile(img.driveFileId!);

          // Clean up local cache
          const cachePath = img.path || path.join(CACHE_BASE, String(img.deploymentId), img.filename);
          try { await fs.unlink(cachePath); } catch { /* may not exist */ }

          // Clean up thumbnail
          const thumbPath = thumbPathFn(img.deploymentId, img.id);
          try { await fs.unlink(thumbPath); } catch { /* may not exist */ }

          // Delete image row from DB (CASCADE removes detections/identifications)
          await db.delete(images).where(eq(images.id, img.id));
        }),
      );

      for (const result of results) {
        if (result.status === "fulfilled") {
          deleted++;
        } else {
          log.error({ err: result.reason }, "[DeleteImages] Failed");
          failed++;
        }
      }
    }

    // Update deployment totalImages counts
    for (const depId of deploymentIds) {
      const [{ total }] = await db
        .select({ total: count() })
        .from(images)
        .where(eq(images.deploymentId, depId));

      await db
        .update(deployments)
        .set({ totalImages: total, updatedAt: new Date() })
        .where(eq(deployments.id, depId));
    }

    // Activity log
    await db.insert(activityLog).values({
      userEmail: user.email,
      action: "delete_images_drive",
      projectId: "camera-trap",
      targetType: "image",
      details: JSON.stringify({
        deleted,
        failed,
        skippedWithDetections: imageIdsWithDetections.size,
        deploymentIds,
        imageIds: safeImages.map((img) => img.id),
      }),
    });

    revalidatePath(CAMERA_TRAP_PATH);
    revalidatePath("/camera-trap/results");
    return { success: true, data: { deleted, failed } };
  } catch (err) {
    log.error({ err }, "[DeleteImages] Failed");
    return {
      success: false,
      error: err instanceof Error ? err.message : "Error al eliminar imágenes",
    };
  }
}

// ---------------------------------------------------------------------------
// Bulk delete blank images
// ---------------------------------------------------------------------------

export async function checkSetupRetrievalTags(
  jobId: number
): Promise<ActionResult<{ hasDeployment: boolean; hasRetrieval: boolean }>> {
  await requirePermission("camera-trap", "admin");
  try {
    const tags = await db
      .select({ setupTag: images.setupTag })
      .from(images)
      .where(and(eq(images.jobId, jobId), isNotNull(images.setupTag)));
    const tagSet = new Set(tags.map((t) => t.setupTag));
    return {
      success: true,
      data: {
        hasDeployment: tagSet.has("deployment"),
        hasRetrieval: tagSet.has("retrieval"),
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al verificar etiquetas",
    };
  }
}

// Shared eligibility computation for bulk delete operations
interface EligibilitySets {
  eligible: { id: number; confirmedBlank: boolean | null; setupTag: string | null; driveFileId: string | null; deploymentId: number; filename: string; path: string | null }[];
  detectionsByImg: Map<number, number[]>;
  imagesWithOnlyRejected: Set<number>;
  detectionsWithVerifiedOrCorrectedOrRejected: Set<number>;
  jobTotalCount: number;
}

async function computeEligibilitySets(jobId: number): Promise<EligibilitySets> {
  const jobImages = await db
    .select({
      id: images.id,
      confirmedBlank: images.confirmedBlank,
      setupTag: images.setupTag,
      driveFileId: images.driveFileId,
      deploymentId: images.deploymentId,
      filename: images.filename,
      path: images.path,
    })
    .from(images)
    .where(eq(images.jobId, jobId));

  const eligible = jobImages.filter(
    (img) => !img.setupTag && img.driveFileId
  );

  const imageIds = eligible.map((img) => img.id);
  const imageDetectionRows =
    imageIds.length > 0
      ? await db
          .select({ imageId: detections.imageId, id: detections.id })
          .from(detections)
          .where(inArray(detections.imageId, imageIds))
      : [];

  const detectionsByImg = new Map<number, number[]>();
  for (const row of imageDetectionRows) {
    const existing = detectionsByImg.get(row.imageId) || [];
    existing.push(row.id);
    detectionsByImg.set(row.imageId, existing);
  }

  const allDetectionIds = imageDetectionRows.map((d) => d.id);
  const nonRejectedIdents =
    allDetectionIds.length > 0
      ? await db
          .select({ detectionId: identifications.detectionId })
          .from(identifications)
          .where(
            and(
              inArray(identifications.detectionId, allDetectionIds),
              ne(identifications.verificationStatus, "rejected")
            )
          )
      : [];

  const detectionsWithNonRejected = new Set(
    nonRejectedIdents.map((i) => i.detectionId)
  );

  const imagesWithOnlyRejected = new Set<number>();
  for (const [imgId, detIds] of detectionsByImg.entries()) {
    const hasNonRejected = detIds.some((id) => detectionsWithNonRejected.has(id));
    if (!hasNonRejected) {
      imagesWithOnlyRejected.add(imgId);
    }
  }

  const detectionsWithVerifiedOrCorrectedOrRejected = new Set<number>();
  if (allDetectionIds.length > 0) {
    const nonUnverifiedIdents = await db
      .select({ detectionId: identifications.detectionId })
      .from(identifications)
      .where(
        and(
          inArray(identifications.detectionId, allDetectionIds),
          ne(identifications.verificationStatus, "unverified")
        )
      );
    for (const i of nonUnverifiedIdents) {
      detectionsWithVerifiedOrCorrectedOrRejected.add(i.detectionId);
    }
  }

  return {
    eligible,
    detectionsByImg,
    imagesWithOnlyRejected,
    detectionsWithVerifiedOrCorrectedOrRejected,
    jobTotalCount: jobImages.length,
  };
}

// Classify eligible images into the three deletion scopes
function classifyByScope(
  sets: EligibilitySets,
): { confirmedBlank: Set<number>; noDetections: Set<number>; unverifiedDetections: Set<number> } {
  const confirmedBlank = new Set<number>();
  const noDetections = new Set<number>();
  const unverifiedDetections = new Set<number>();

  for (const img of sets.eligible) {
    const detCount = sets.detectionsByImg.get(img.id)?.length ?? 0;

    if (img.confirmedBlank) {
      if (detCount === 0 || sets.imagesWithOnlyRejected.has(img.id)) {
        confirmedBlank.add(img.id);
      }
    }

    if (detCount === 0) {
      noDetections.add(img.id);
    }

    if (detCount > 0) {
      const detIds = sets.detectionsByImg.get(img.id)!;
      const hasNonUnverified = detIds.some((id) =>
        sets.detectionsWithVerifiedOrCorrectedOrRejected.has(id)
      );
      if (!hasNonUnverified) {
        unverifiedDetections.add(img.id);
      }
    }
  }

  return { confirmedBlank, noDetections, unverifiedDetections };
}

export interface BulkDeleteCounts {
  confirmedBlankCount: number;
  noDetectionsCount: number;
  unverifiedDetectionsCount: number;
  /** Pre-computed union sizes for all 7 checkbox combinations (keyed like "cb", "nd", "cb_nd", etc.) */
  unionSizes: Record<string, number>;
  jobTotalCount: number;
}

export async function countDeletableImages(
  jobId: number,
): Promise<ActionResult<BulkDeleteCounts>> {
  await requirePermission("camera-trap", "admin");

  try {
    const sets = await computeEligibilitySets(jobId);
    const { confirmedBlank: cb, noDetections: nd, unverifiedDetections: ud } = classifyByScope(sets);

    // Pre-compute union sizes for all 7 non-empty checkbox combinations
    const union = (...sets: Set<number>[]) => {
      const merged = new Set<number>();
      for (const s of sets) for (const id of s) merged.add(id);
      return merged.size;
    };

    return {
      success: true,
      data: {
        confirmedBlankCount: cb.size,
        noDetectionsCount: nd.size,
        unverifiedDetectionsCount: ud.size,
        unionSizes: {
          cb: cb.size,
          nd: nd.size,
          ud: ud.size,
          cb_nd: union(cb, nd),
          cb_ud: union(cb, ud),
          nd_ud: union(nd, ud),
          cb_nd_ud: union(cb, nd, ud),
        },
        jobTotalCount: sets.jobTotalCount,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al contar imágenes",
    };
  }
}

export async function bulkDeleteBlankImages(
  jobId: number,
  scope: { confirmedBlank: boolean; noDetections: boolean; unverifiedDetections: boolean }
): Promise<ActionResult<{ deleted: number; failed: number; skipped: number }>> {
  const user = await requirePermission("camera-trap", "editor");

  try {
    const sets = await computeEligibilitySets(jobId);
    const classified = classifyByScope(sets);

    // Build the set of images to delete based on selected scopes
    const toDelete = new Set<number>();
    if (scope.confirmedBlank) for (const id of classified.confirmedBlank) toDelete.add(id);
    if (scope.noDetections) for (const id of classified.noDetections) toDelete.add(id);
    if (scope.unverifiedDetections) for (const id of classified.unverifiedDetections) toDelete.add(id);

    const imagesToDelete = sets.eligible.filter((img) => toDelete.has(img.id));
    const skipped = sets.eligible.length - imagesToDelete.length;
    const totalBatches = Math.ceil(imagesToDelete.length / DELETE_BATCH_SIZE);

    log.info(
      {
        toDelete: imagesToDelete.length,
        jobId,
        totalBatches,
        scope,
        skipped,
      },
      "[BulkDeleteBlanks] Starting"
    );

    let deleted = 0;
    let failed = 0;

    // Process in batches. DB delete (atomic per batch) happens BEFORE Drive
    // trash so that if Drive fails we leave the file in Drive (recoverable)
    // rather than orphaning a row in the DB. Drive trash is also recoverable
    // from the user's Drive trash if needed.
    for (let i = 0; i < imagesToDelete.length; i += DELETE_BATCH_SIZE) {
      const batch = imagesToDelete.slice(i, i + DELETE_BATCH_SIZE);
      const batchImageIds = batch.map((img) => img.id);
      const batchDetectionIds: number[] = [];
      for (const img of batch) {
        const imgDets = sets.detectionsByImg.get(img.id);
        if (imgDets && imgDets.length > 0) {
          batchDetectionIds.push(...imgDets);
        }
      }

      // Step 1: atomic DB cleanup for the whole batch.
      try {
        db.transaction((tx) => {
          if (batchDetectionIds.length > 0) {
            tx.delete(identifications)
              .where(inArray(identifications.detectionId, batchDetectionIds))
              .run();
            tx.delete(detections)
              .where(inArray(detections.id, batchDetectionIds))
              .run();
          }
          tx.delete(images).where(inArray(images.id, batchImageIds)).run();
        });
      } catch (err) {
        log.error({ err }, "[BulkDeleteBlanks] DB batch failed, skipping Drive trash");
        failed += batch.length;
        continue;
      }

      // Step 2: trash files in Drive + clean caches/thumbnails.
      // DB rows are already gone — remaining ops are best-effort cleanup.
      const fsResults = await Promise.allSettled(
        batch.map(async (img) => {
          await trashFile(img.driveFileId!);
          const cachePath =
            img.path || path.join(CACHE_BASE, String(img.deploymentId), img.filename);
          try { await fs.unlink(cachePath); } catch { /* may not exist */ }
          const thumbPath = thumbPathFn(img.deploymentId, img.id);
          try { await fs.unlink(thumbPath); } catch { /* may not exist */ }
        })
      );

      const batchNum = Math.floor(i / DELETE_BATCH_SIZE) + 1;
      for (const result of fsResults) {
        if (result.status === "fulfilled") {
          deleted++;
        } else {
          // DB row is gone but Drive trash failed — count as deleted (the
          // primary intent succeeded) and log so the orphaned Drive file can
          // be cleaned up manually.
          log.error(
            { err: result.reason },
            "[BulkDeleteBlanks] Drive/cache cleanup failed (DB row deleted)"
          );
          deleted++;
        }
      }
      log.info(
        {
          batchNum,
          totalBatches,
          deleted,
          failed,
          total: imagesToDelete.length,
        },
        "[BulkDeleteBlanks] Batch progress"
      );
    }

    // Update deployment totalImages counts
    const deploymentIds = [...new Set(imagesToDelete.map((img) => img.deploymentId))];
    for (const depId of deploymentIds) {
      const [{ total }] = await db
        .select({ total: count() })
        .from(images)
        .where(eq(images.deploymentId, depId));

      await db
        .update(deployments)
        .set({ totalImages: total, updatedAt: new Date() })
        .where(eq(deployments.id, depId));
    }

    log.info(
      { jobId, deleted, failed, skipped },
      "[BulkDeleteBlanks] Complete"
    );

    // Activity log
    await db.insert(activityLog).values({
      userEmail: user.email,
      action: "bulk_delete_blanks",
      projectId: "camera-trap",
      targetType: "image",
      details: JSON.stringify({
        jobId,
        scope,
        deleted,
        failed,
        skipped,
      }),
    });

    revalidatePath(CAMERA_TRAP_PATH);
    revalidatePath(`/camera-trap/results/${jobId}`);
    return { success: true, data: { deleted, failed, skipped } };
  } catch (err) {
    log.error({ err }, "[BulkDeleteBlanks] Failed");
    return {
      success: false,
      error: err instanceof Error ? err.message : "Error al eliminar imágenes",
    };
  }
}

/** Get cascade stats for a set of deployments (for delete confirmation). */
export async function getDeploymentsCascadeStats(
  ids: number[]
): Promise<{ totalImages: number; totalDetections: number; totalVerified: number; hasUploadCounts: boolean }> {
  const user = await requirePermission("camera-trap", "viewer");

  if (ids.length === 0) return { totalImages: 0, totalDetections: 0, totalVerified: 0, hasUploadCounts: false };

  // Verify access to all deployments
  for (const id of ids) {
    try {
      await requireDeploymentAccess(user, id);
    } catch {
      return { totalImages: 0, totalDetections: 0, totalVerified: 0, hasUploadCounts: false };
    }
  }

  // Check if any selected deployments have biochoco upload counts
  const deploymentsWithCounts = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      and(
        inArray(deployments.id, ids),
        or(
          isNotNull(deployments.uploadCameraCount),
          isNotNull(deployments.uploadAudioCount),
          isNotNull(deployments.uploadIbuttonCount)
        )
      )
    );
  const hasUploadCounts = deploymentsWithCounts.length > 0;

  const [imgStats] = await db
    .select({ cnt: count() })
    .from(images)
    .where(inArray(images.deploymentId, ids));

  const jobRows = await db
    .select({ id: processingJobs.id })
    .from(processingJobs)
    .where(inArray(processingJobs.deploymentId, ids));

  if (jobRows.length === 0) {
    return { totalImages: imgStats?.cnt ?? 0, totalDetections: 0, totalVerified: 0, hasUploadCounts };
  }

  const jobIds = jobRows.map((j) => j.id);

  const [detStats] = await db
    .select({ cnt: count() })
    .from(detections)
    .where(inArray(detections.jobId, jobIds));

  const detectionIds = (
    await db
      .select({ id: detections.id })
      .from(detections)
      .where(inArray(detections.jobId, jobIds))
  ).map((d) => d.id);

  let totalVerified = 0;
  if (detectionIds.length > 0) {
    const [verStats] = await db
      .select({ cnt: count() })
      .from(identifications)
      .where(
        and(
          inArray(identifications.detectionId, detectionIds),
          ne(identifications.verificationStatus, "unverified")
        )
      );
    totalVerified = verStats?.cnt ?? 0;
  }

  return {
    totalImages: imgStats?.cnt ?? 0,
    totalDetections: detStats?.cnt ?? 0,
    totalVerified,
    hasUploadCounts,
  };
}

// ---------------------------------------------------------------------------
// Deployment Verification Completion
// ---------------------------------------------------------------------------

/**
 * Check if all identifications for a deployment have been reviewed.
 * If so, auto-transition from "processed" → "verified".
 * Returns true if the deployment was auto-completed.
 */
async function maybeAutoCompleteDeployment(deploymentId: number): Promise<boolean> {
  const [unverifiedResult] = await db
    .select({ cnt: count() })
    .from(identifications)
    .innerJoin(detections, eq(identifications.detectionId, detections.id))
    .innerJoin(images, eq(detections.imageId, images.id))
    .where(
      and(
        eq(images.deploymentId, deploymentId),
        eq(identifications.verificationStatus, "unverified")
      )
    );

  if ((unverifiedResult?.cnt ?? 0) > 0) return false;

  // Also ensure there's at least one identification (don't auto-verify empty deployments)
  const [totalResult] = await db
    .select({ cnt: count() })
    .from(identifications)
    .innerJoin(detections, eq(identifications.detectionId, detections.id))
    .innerJoin(images, eq(detections.imageId, images.id))
    .where(eq(images.deploymentId, deploymentId));

  if ((totalResult?.cnt ?? 0) === 0) return false;

  const [deployment] = await db
    .select({ status: deployments.status })
    .from(deployments)
    .where(eq(deployments.id, deploymentId));

  if (deployment?.status !== "processed") return false;

  await db
    .update(deployments)
    .set({ status: "verified", updatedAt: new Date() })
    .where(eq(deployments.id, deploymentId));

  return true;
}

export async function markVerified(
  deploymentId: number
): Promise<ActionResult> {
  const user = await requirePermission("camera-trap", "editor");

  try {
    const [deployment] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deploymentId));

    if (!deployment) {
      return { success: false, error: "Instalación no encontrada" };
    }

    await requireDeploymentAccess(user, deploymentId);

    if (deployment.status !== "processed") {
      return {
        success: false,
        error: "Solo se pueden verificar instalaciones con estado 'procesada'",
      };
    }

    await db
      .update(deployments)
      .set({ status: "verified", updatedAt: new Date() })
      .where(eq(deployments.id, deploymentId));

    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al verificar",
    };
  }
}

export async function undoVerified(
  deploymentId: number
): Promise<ActionResult> {
  const user = await requirePermission("camera-trap", "editor");

  try {
    await requireDeploymentAccess(user, deploymentId);

    const [deployment] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deploymentId));

    if (!deployment) {
      return { success: false, error: "Instalación no encontrada" };
    }

    if (deployment.status !== "verified") {
      return {
        success: false,
        error: "Solo se puede re-abrir instalaciones con estado 'verificada'",
      };
    }

    await db
      .update(deployments)
      .set({ status: "processed", updatedAt: new Date() })
      .where(eq(deployments.id, deploymentId));

    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al re-abrir revisión",
    };
  }
}

/** Get the count of unverified identifications for a deployment (for confirmation dialogs). */
export async function getUnverifiedCount(
  deploymentId: number
): Promise<ActionResult<{ unverified: number; total: number }>> {
  const user = await requirePermission("camera-trap", "viewer");

  try {
    await requireDeploymentAccess(user, deploymentId);

    const [totalResult] = await db
      .select({ cnt: count() })
      .from(identifications)
      .innerJoin(detections, eq(identifications.detectionId, detections.id))
      .innerJoin(images, eq(detections.imageId, images.id))
      .where(eq(images.deploymentId, deploymentId));

    const [unverifiedResult] = await db
      .select({ cnt: count() })
      .from(identifications)
      .innerJoin(detections, eq(identifications.detectionId, detections.id))
      .innerJoin(images, eq(detections.imageId, images.id))
      .where(
        and(
          eq(images.deploymentId, deploymentId),
          eq(identifications.verificationStatus, "unverified")
        )
      );

    return {
      success: true,
      data: {
        unverified: unverifiedResult?.cnt ?? 0,
        total: totalResult?.cnt ?? 0,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al obtener conteo",
    };
  }
}

// ---------------------------------------------------------------------------
// Verified Empty
// ---------------------------------------------------------------------------

export async function markVerifiedEmpty(
  deploymentId: number
): Promise<ActionResult> {
  const user = await requirePermission("camera-trap", "editor");

  try {
    const [deployment] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deploymentId));

    if (!deployment) {
      return { success: false, error: "Implementación no encontrada" };
    }

    await requireDeploymentAccess(user, deploymentId);

    if (deployment.status !== "processed") {
      return {
        success: false,
        error: "Solo se pueden verificar implementaciones con estado 'procesada'",
      };
    }

    // Verify there are truly 0 detections for this deployment
    const completedJobs = await db
      .select({ id: processingJobs.id })
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.deploymentId, deploymentId),
          eq(processingJobs.status, "completed")
        )
      );

    if (completedJobs.length > 0) {
      const jobIds = completedJobs.map((j) => j.id);
      const [detStats] = await db
        .select({ cnt: count() })
        .from(detections)
        .where(inArray(detections.jobId, jobIds));

      if ((detStats?.cnt ?? 0) > 0) {
        return {
          success: false,
          error: "Esta implementación tiene detecciones — no se puede marcar como vacía",
        };
      }
    }

    await db
      .update(deployments)
      .set({ status: "verified_empty", updatedAt: new Date() })
      .where(eq(deployments.id, deploymentId));

    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al verificar",
    };
  }
}

export async function undoVerifiedEmpty(
  deploymentId: number
): Promise<ActionResult> {
  const user = await requirePermission("camera-trap", "editor");

  try {
    await requireDeploymentAccess(user, deploymentId);

    const [deployment] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deploymentId));

    if (!deployment) {
      return { success: false, error: "Implementación no encontrada" };
    }

    if (deployment.status !== "verified_empty") {
      return {
        success: false,
        error: "Solo se puede deshacer la verificación de implementaciones con estado 'vacía verificada'",
      };
    }

    await db
      .update(deployments)
      .set({ status: "processed", updatedAt: new Date() })
      .where(eq(deployments.id, deploymentId));

    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al deshacer verificación",
    };
  }
}

// ---------------------------------------------------------------------------
// Processing Queue
// ---------------------------------------------------------------------------

export async function queueProcessing(
  deploymentIds: number[],
  options?: { compressFirst?: boolean; frameExtractionRate?: number; videoTimestampMethod?: "metadata" | "filename_folder" | "none" }
): Promise<ActionResult<{ jobIds: number[] }>> {
  const user = await requirePermission("camera-trap", "editor");

  try {
    if (deploymentIds.length === 0) {
      return { success: true, data: { jobIds: [] } };
    }

    // Verify access to all deployments
    for (const id of deploymentIds) {
      await requireDeploymentAccess(user, id);
    }

    const jobIds: number[] = [];

    for (const depId of deploymentIds) {
      const [deployment] = await db
        .select()
        .from(deployments)
        .where(eq(deployments.id, depId));

      if (!deployment) continue;

      // Skip if already processing
      if (deployment.status === "processing") continue;

      // Auto-scan if unscanned
      if (deployment.status === "unscanned" && deployment.driveFolderId) {
        const { scanDeploymentImages } = await import("./drive-actions");
        await scanDeploymentImages(depId);
      }

      // Create job
      const result = await createProcessingJob(depId, undefined, options);
      if (result.success) {
        jobIds.push(result.data.jobId);
      }
    }

    // Start the first job (fire-and-forget, no auth needed — already verified above)
    if (jobIds.length > 0) {
      processJobInternal(jobIds[0]);
    }

    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: { jobIds } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al encolar procesamiento",
    };
  }
}

/**
 * Queue an incremental ML run that processes only newly-added pending images
 * on a deployment. Existing detections, identifications, verification state,
 * and confirmedBlank flags are preserved. On success the deployment is set to
 * "processed" (downgrading from verified/verified_empty if applicable, since
 * the deployment now contains unreviewed images).
 */
export async function queueIncrementalProcessing(
  deploymentId: number,
  options?: { frameExtractionRate?: number; videoTimestampMethod?: "metadata" | "filename_folder" | "none" },
): Promise<ActionResult<{ jobId: number }>> {
  const user = await requirePermission("camera-trap", "editor");

  try {
    await requireDeploymentAccess(user, deploymentId);

    const result = await createProcessingJob(deploymentId, undefined, {
      incremental: true,
      frameExtractionRate: options?.frameExtractionRate,
      videoTimestampMethod: options?.videoTimestampMethod,
    });
    if (!result.success) return result;

    // Fire-and-forget — auth already verified above.
    processJobInternal(result.data.jobId);

    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: { jobId: result.data.jobId } };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : "Error al encolar procesamiento incremental",
    };
  }
}

/** Called at end of processJob to auto-advance the queue. */
async function processNextInQueue(): Promise<void> {
  const [nextJob] = await db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.status, "pending"))
    .orderBy(processingJobs.createdAt)
    .limit(1);

  if (nextJob) {
    log.info({ jobId: nextJob.id, deploymentId: nextJob.deploymentId }, "[Queue] Auto-advancing to next job");
    processJobInternal(nextJob.id);
  }
}

/** Cancel all pending jobs in the queue. */
export async function cancelQueue(): Promise<ActionResult<{ cancelled: number }>> {
  await requirePermission("camera-trap", "editor");

  try {
    // Cancel the currently running job
    const [activeJob] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.status, "processing"))
      .limit(1);

    if (activeJob) {
      await cancelJob(activeJob.id);
    }

    // Mark all pending jobs as cancelled
    const pendingJobs = await db
      .select({ id: processingJobs.id, deploymentId: processingJobs.deploymentId })
      .from(processingJobs)
      .where(eq(processingJobs.status, "pending"));

    if (pendingJobs.length > 0) {
      await db
        .update(processingJobs)
        .set({ status: "cancelled", completedAt: new Date(), statusMessage: null })
        .where(inArray(processingJobs.id, pendingJobs.map((j) => j.id)));

      // Revert deployment statuses
      const depIds = [...new Set(pendingJobs.map((j) => j.deploymentId))];
      await db
        .update(deployments)
        .set({ status: "scanned", updatedAt: new Date() })
        .where(inArray(deployments.id, depIds));
    }

    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: { cancelled: pendingJobs.length + (activeJob ? 1 : 0) } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al cancelar cola",
    };
  }
}

/** Get CT projects the user can access, for filter dropdown and edit forms. */
export async function getDistinctProjects(): Promise<{ id: number; name: string }[]> {
  const user = await requirePermission("camera-trap", "viewer");
  const ctProjects = await getUserCameraTrapProjects(user);

  if (ctProjects === "all") {
    return db
      .select({ id: cameraTrapProjects.id, name: cameraTrapProjects.name })
      .from(cameraTrapProjects)
      .orderBy(cameraTrapProjects.name);
  }

  if (ctProjects.length === 0) return [];

  return db
    .select({ id: cameraTrapProjects.id, name: cameraTrapProjects.name })
    .from(cameraTrapProjects)
    .where(inArray(cameraTrapProjects.id, ctProjects))
    .orderBy(cameraTrapProjects.name);
}

export async function getDeployment(id: number) {
  const user = await requirePermission("camera-trap", "viewer");

  const [deployment] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, id));

  if (!deployment) return null;

  // Check CT project access
  try {
    await requireDeploymentAccess(user, id);
  } catch {
    return null;
  }

  const deploymentImages = await db
    .select()
    .from(images)
    .where(eq(images.deploymentId, id));

  const deploymentVideos = await db
    .select()
    .from(videos)
    .where(eq(videos.deploymentId, id));

  const jobs = await db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.deploymentId, id))
    .orderBy(desc(processingJobs.createdAt));

  // Stats for the entire deployment (used by the detail page banner). Counted
  // per deployment so they remain correct after incremental ML runs — the
  // latest completed job may only contain a small batch of newly added images,
  // but the banner should reflect every detection on the deployment.
  // latestCompletedJob is still computed below for the return shape so the
  // "Resultados" button keeps linking to /camera-trap/results/{jobId}.
  const latestCompletedJob = jobs.find((j) => j.status === "completed");

  const [detResult] = await db
    .select({ cnt: count() })
    .from(detections)
    .innerJoin(images, eq(detections.imageId, images.id))
    .where(eq(images.deploymentId, id));
  const totalDetections = detResult?.cnt ?? 0;

  const [specResult] = await db
    .select({
      cnt: sql<number>`count(distinct coalesce(${identifications.correctedSpecies}, ${identifications.species}))`,
    })
    .from(identifications)
    .innerJoin(detections, eq(identifications.detectionId, detections.id))
    .innerJoin(images, eq(detections.imageId, images.id))
    .where(eq(images.deploymentId, id));
  const distinctSpeciesCount = specResult?.cnt ?? 0;

  const [verResult] = await db
    .select({ cnt: count() })
    .from(identifications)
    .innerJoin(detections, eq(identifications.detectionId, detections.id))
    .innerJoin(images, eq(detections.imageId, images.id))
    .where(
      and(
        eq(images.deploymentId, id),
        ne(identifications.verificationStatus, "unverified")
      )
    );
  const verifiedCount = verResult?.cnt ?? 0;

  // Deployment-wide verification progress (across all jobs + manual detections)
  const [totalIdResult] = await db
    .select({ cnt: count() })
    .from(identifications)
    .innerJoin(detections, eq(identifications.detectionId, detections.id))
    .innerJoin(images, eq(detections.imageId, images.id))
    .where(eq(images.deploymentId, id));

  const [reviewedResult] = await db
    .select({ cnt: count() })
    .from(identifications)
    .innerJoin(detections, eq(identifications.detectionId, detections.id))
    .innerJoin(images, eq(detections.imageId, images.id))
    .where(
      and(
        eq(images.deploymentId, id),
        ne(identifications.verificationStatus, "unverified")
      )
    );

  // Blank-reviewable images — images with no identifications (either zero
  // detections, or only person/vehicle detections, which never get
  // classified). Each one requires an explicit "Confirmar vacía" action to
  // count as reviewed.
  const [blankResult] = await db
    .select({
      blankTotal: count(),
      blankReviewed: sql<number>`sum(case when ${images.confirmedBlank} = 1 then 1 else 0 end)`,
    })
    .from(images)
    .where(
      and(
        eq(images.deploymentId, id),
        notExists(
          db
            .select({ one: sql`1` })
            .from(detections)
            .innerJoin(
              identifications,
              eq(identifications.detectionId, detections.id),
            )
            .where(eq(detections.imageId, images.id)),
        ),
      ),
    );

  const blankTotal = blankResult?.blankTotal ?? 0;
  const blankReviewed = Number(blankResult?.blankReviewed ?? 0);

  const pendingVideoCount = deploymentVideos.filter((v) => v.status === "pending").length;

  return {
    deployment,
    images: deploymentImages,
    videos: deploymentVideos,
    jobs,
    stats: {
      totalDetections,
      distinctSpeciesCount,
      verifiedCount,
      latestCompletedJobId: latestCompletedJob?.id ?? null,
      totalIdentifications: (totalIdResult?.cnt ?? 0) + blankTotal,
      reviewedCount: (reviewedResult?.cnt ?? 0) + blankReviewed,
      pendingVideoCount,
    },
  };
}

/** Fetch all data needed to render the image gallery for a given processing job.
 *  Shared by both the results page and the embedded gallery on the detail page. */
export async function getJobResultsData(jobId: number) {
  const [job] = await db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId));

  if (!job) return null;

  const [deployment] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, job.deploymentId));

  const jobImages = await db
    .select()
    .from(images)
    .where(eq(images.jobId, jobId))
    .orderBy(IMAGE_TIMESTAMP_ORDER, images.filename);

  const imageIds = jobImages.map((img) => img.id);
  const jobDetections =
    imageIds.length > 0
      ? await db
          .select()
          .from(detections)
          .where(inArray(detections.imageId, imageIds))
      : [];

  const detectionIds = jobDetections.map((d) => d.id);
  const jobIdentifications =
    detectionIds.length > 0
      ? await db
          .select()
          .from(identifications)
          .where(inArray(identifications.detectionId, detectionIds))
      : [];

  const identByDetection = new Map<number, (typeof jobIdentifications)[number]>();
  for (const ident of jobIdentifications) {
    identByDetection.set(ident.detectionId, ident);
  }

  // Resolve confidence thresholds for any custom classifier models referenced
  // by these identifications. Used by displaySpecies() at the read boundary
  // so re-tuning a threshold is a single UPDATE — no reprocess needed.
  const modelIdSet = new Set<number>();
  for (const ident of jobIdentifications) {
    if (ident.classifierModelId != null) modelIdSet.add(ident.classifierModelId);
  }
  const modelRows =
    modelIdSet.size > 0
      ? await db
          .select({
            id: cameraTrapModels.id,
            confidenceThreshold: cameraTrapModels.confidenceThreshold,
          })
          .from(cameraTrapModels)
          .where(inArray(cameraTrapModels.id, [...modelIdSet]))
      : [];
  const modelById = new Map<number, ModelForDisplay>(
    modelRows.map((m) => [m.id, { confidenceThreshold: m.confidenceThreshold }]),
  );

  // Effective species label for display. Verified/corrected identifications
  // are NEVER relabeled — human verdict always wins. Unverified custom-
  // classifier predictions below their model's confidence threshold collapse
  // into "Sin identificar".
  function effectiveSpecies(
    ident: (typeof jobIdentifications)[number] | undefined,
  ): string | null {
    if (!ident) return null;
    if (
      ident.verificationStatus === "verified" ||
      ident.verificationStatus === "corrected"
    ) {
      return ident.correctedSpecies || ident.species;
    }
    return displaySpecies(
      {
        species: ident.species,
        confidence: ident.confidence,
        classifierModelId: ident.classifierModelId,
      },
      modelById,
    ).label;
  }

  const detectionsByImage = new Map<number, (typeof jobDetections)>();
  for (const det of jobDetections) {
    const existing = detectionsByImage.get(det.imageId) || [];
    existing.push(det);
    detectionsByImage.set(det.imageId, existing);
  }

  const speciesCount: Record<string, number> = {};
  for (const ident of jobIdentifications) {
    const sp = effectiveSpecies(ident);
    if (!sp) continue;
    speciesCount[sp] = (speciesCount[sp] || 0) + 1;
  }

  // Look up display-name metadata (common/spanish names) for the species
  // present in this job so the client can render labels in the user's
  // preferred display mode.
  const speciesNames = Object.keys(speciesCount);
  const speciesRecords = speciesNames.length > 0
    ? await db
        .select()
        .from(species)
        .where(inArray(species.scientificName, speciesNames))
    : [];
  const speciesRecordMap = new Map(speciesRecords.map((r) => [r.scientificName, r]));

  const sortedSpecies = Object.entries(speciesCount)
    .sort(([, a], [, b]) => b - a)
    .map(([name, count]) => {
      const r = speciesRecordMap.get(name);
      return {
        scientificName: name,
        commonName: r?.commonName ?? null,
        spanishName: r?.spanishName ?? null,
        count,
      };
    });

  const verified = jobIdentifications.filter(
    (i) => i.verificationStatus === "verified" || i.verificationStatus === "corrected"
  ).length;
  const unverified = jobIdentifications.filter(
    (i) => i.verificationStatus === "unverified"
  ).length;

  // Query videos for this deployment to build a name map
  const jobVideos = deployment
    ? await db.select().from(videos).where(eq(videos.deploymentId, deployment.id))
    : [];
  const videoMap = new Map(jobVideos.map((v) => [v.id, v]));

  const gridImages = jobImages.map((img) => {
    const imgDets = detectionsByImage.get(img.id) || [];
    const vid = img.videoId ? videoMap.get(img.videoId) : null;
    return {
      id: img.id,
      filename: img.filename,
      path: img.path,
      status: img.status,
      thumbnailPath: img.thumbnailPath,
      videoId: img.videoId ?? null,
      frameIndex: img.frameIndex ?? null,
      videoFilename: vid?.filename ?? null,
      confirmedBlank: img.confirmedBlank ?? false,
      starred: img.starred ?? false,
      setupTag: img.setupTag ?? null,
      detections: imgDets.map((det) => {
        const ident = identByDetection.get(det.id);
        return {
          id: det.id,
          species: effectiveSpecies(ident),
          confidence: ident?.confidence || null,
          detectionConfidence: det.detectionConfidence,
          detectionClass: det.detectionClass,
          verificationStatus: ident?.verificationStatus || "unverified",
        };
      }),
    };
  });

  return {
    job,
    deployment,
    gridImages,
    speciesList: sortedSpecies,
    detectionCount: jobDetections.length,
    verified,
    unverified,
    totalIdentifications: jobIdentifications.length,
  };
}

/** Fetch all data needed to render the image gallery for an entire deployment.
 *  Used by the deployment detail page so the gallery and counts reflect every
 *  image in the deployment, not just the latest completed job's image set.
 *  For the per-job view (Trabajo #N) use getJobResultsData(jobId) instead.
 *
 *  Mirrors getJobResultsData's body almost line-for-line — only the input
 *  query widens from `WHERE images.jobId = jobId` to
 *  `WHERE images.deploymentId = deploymentId`. The detectionsByImage grouping
 *  is what guarantees one gridImage entry per physical image regardless of
 *  how many detections (ML or manual) it has. */
export async function getDeploymentResultsData(deploymentId: number) {
  const user = await requirePermission("camera-trap", "viewer");

  const [deployment] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, deploymentId));

  if (!deployment) return null;

  try {
    await requireDeploymentAccess(user, deploymentId);
  } catch {
    return null;
  }

  // Latest completed job — informational only, used by the page header for
  // model version / timing display. Never used as a filter on the image set.
  const [latestJob] = await db
    .select()
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.deploymentId, deploymentId),
        eq(processingJobs.status, "completed"),
      ),
    )
    .orderBy(desc(processingJobs.completedAt))
    .limit(1);

  // ALL images in the deployment, regardless of which job processed them.
  const deploymentImages = await db
    .select()
    .from(images)
    .where(eq(images.deploymentId, deploymentId))
    .orderBy(IMAGE_TIMESTAMP_ORDER, images.filename);

  const imageIds = deploymentImages.map((img) => img.id);
  const allDetections =
    imageIds.length > 0
      ? await db
          .select()
          .from(detections)
          .where(inArray(detections.imageId, imageIds))
      : [];

  const detectionIds = allDetections.map((d) => d.id);
  const allIdentifications =
    detectionIds.length > 0
      ? await db
          .select()
          .from(identifications)
          .where(inArray(identifications.detectionId, detectionIds))
      : [];

  const identByDetection = new Map<number, (typeof allIdentifications)[number]>();
  for (const ident of allIdentifications) {
    identByDetection.set(ident.detectionId, ident);
  }

  const detectionsByImage = new Map<number, (typeof allDetections)>();
  for (const det of allDetections) {
    const existing = detectionsByImage.get(det.imageId) || [];
    existing.push(det);
    detectionsByImage.set(det.imageId, existing);
  }

  const speciesCount: Record<string, number> = {};
  for (const ident of allIdentifications) {
    const sp = ident.correctedSpecies || ident.species;
    speciesCount[sp] = (speciesCount[sp] || 0) + 1;
  }

  const speciesNames = Object.keys(speciesCount);
  const speciesRecords = speciesNames.length > 0
    ? await db
        .select()
        .from(species)
        .where(inArray(species.scientificName, speciesNames))
    : [];
  const speciesRecordMap = new Map(speciesRecords.map((r) => [r.scientificName, r]));

  const sortedSpecies = Object.entries(speciesCount)
    .sort(([, a], [, b]) => b - a)
    .map(([name, count]) => {
      const r = speciesRecordMap.get(name);
      return {
        scientificName: name,
        commonName: r?.commonName ?? null,
        spanishName: r?.spanishName ?? null,
        count,
      };
    });

  const verified = allIdentifications.filter(
    (i) => i.verificationStatus === "verified" || i.verificationStatus === "corrected"
  ).length;
  const unverified = allIdentifications.filter(
    (i) => i.verificationStatus === "unverified"
  ).length;

  const deploymentVideos = await db
    .select()
    .from(videos)
    .where(eq(videos.deploymentId, deploymentId));
  const videoMap = new Map(deploymentVideos.map((v) => [v.id, v]));

  const gridImages = deploymentImages.map((img) => {
    const imgDets = detectionsByImage.get(img.id) || [];
    const vid = img.videoId ? videoMap.get(img.videoId) : null;
    return {
      id: img.id,
      filename: img.filename,
      path: img.path,
      status: img.status,
      thumbnailPath: img.thumbnailPath,
      videoId: img.videoId ?? null,
      frameIndex: img.frameIndex ?? null,
      videoFilename: vid?.filename ?? null,
      confirmedBlank: img.confirmedBlank ?? false,
      starred: img.starred ?? false,
      setupTag: img.setupTag ?? null,
      detections: imgDets.map((det) => {
        const ident = identByDetection.get(det.id);
        return {
          id: det.id,
          species: ident?.correctedSpecies || ident?.species || null,
          confidence: ident?.confidence || null,
          detectionConfidence: det.detectionConfidence,
          detectionClass: det.detectionClass,
          verificationStatus: ident?.verificationStatus || "unverified",
        };
      }),
    };
  });

  return {
    job: latestJob ?? null,
    deployment,
    gridImages,
    speciesList: sortedSpecies,
    detectionCount: allDetections.length,
    verified,
    unverified,
    totalIdentifications: allIdentifications.length,
  };
}

export async function getRecentJobs(limit: number = 50) {
  const user = await requirePermission("camera-trap", "viewer");
  const ctProjects = await getUserCameraTrapProjects(user);
  const pf = ctProjectFilter(ctProjects);

  // Scope jobs to accessible deployments
  let jobFilter: ReturnType<typeof inArray> | undefined;
  if (pf) {
    const accessibleDeps = await db
      .select({ id: deployments.id })
      .from(deployments)
      .where(and(eq(deployments.projectId, "camera-trap"), pf));
    const depIds = accessibleDeps.map((d) => d.id);
    if (depIds.length === 0) return [];
    jobFilter = inArray(processingJobs.deploymentId, depIds);
  }

  const jobs = await db
    .select()
    .from(processingJobs)
    .where(jobFilter)
    .orderBy(desc(processingJobs.createdAt))
    .limit(limit);

  if (jobs.length === 0) return [];

  const jobIds = jobs.map((j) => j.id);

  // Batch: deployments
  const deploymentIds = [...new Set(jobs.map((j) => j.deploymentId))];
  const deploymentRows = await db
    .select()
    .from(deployments)
    .where(inArray(deployments.id, deploymentIds));
  const deploymentMap = new Map(deploymentRows.map((d) => [d.id, d]));

  // Batch: detection counts per job (join through images to include manual detections)
  const detectionCounts = await db
    .select({ jobId: images.jobId, cnt: count() })
    .from(detections)
    .innerJoin(images, eq(detections.imageId, images.id))
    .where(inArray(images.jobId, jobIds))
    .groupBy(images.jobId);
  const detCountMap = new Map(detectionCounts.map((r) => [r.jobId, r.cnt]));

  // Batch: distinct species counts per job (join through images to include manual detections)
  const speciesCounts = await db
    .select({
      jobId: images.jobId,
      cnt: sql<number>`count(distinct coalesce(${identifications.correctedSpecies}, ${identifications.species}))`,
    })
    .from(identifications)
    .innerJoin(detections, eq(identifications.detectionId, detections.id))
    .innerJoin(images, eq(detections.imageId, images.id))
    .where(inArray(images.jobId, jobIds))
    .groupBy(images.jobId);
  const specCountMap = new Map(speciesCounts.map((r) => [r.jobId, r.cnt]));

  // Batch: verified/corrected/rejected identification counts per job
  const verifiedCounts = await db
    .select({ jobId: images.jobId, cnt: count() })
    .from(identifications)
    .innerJoin(detections, eq(identifications.detectionId, detections.id))
    .innerJoin(images, eq(detections.imageId, images.id))
    .where(
      and(
        inArray(images.jobId, jobIds),
        ne(identifications.verificationStatus, "unverified")
      )
    )
    .groupBy(images.jobId);
  const verCountMap = new Map(verifiedCounts.map((r) => [r.jobId, r.cnt]));

  return jobs.map((job) => ({
    ...job,
    deployment: deploymentMap.get(job.deploymentId) || null,
    detectionsCount: detCountMap.get(job.id) || 0,
    speciesCount: specCountMap.get(job.id) || 0,
    verifiedCount: verCountMap.get(job.id) || 0,
  }));
}

export async function getResultsStats() {
  const user = await requirePermission("camera-trap", "viewer");
  const ctProjects = await getUserCameraTrapProjects(user);
  const pf = ctProjectFilter(ctProjects);

  // Get accessible deployment IDs for scoping
  let depIds: number[] | null = null;
  if (pf) {
    const accessibleDeps = await db
      .select({ id: deployments.id })
      .from(deployments)
      .where(and(eq(deployments.projectId, "camera-trap"), pf));
    depIds = accessibleDeps.map((d) => d.id);
    if (depIds.length === 0) {
      return { totalJobs: 0, totalImagesProcessed: 0, totalDetections: 0, uniqueSpecies: 0 };
    }
  }

  const jobWhere = depIds ? inArray(processingJobs.deploymentId, depIds) : undefined;
  const imgWhere = depIds ? inArray(images.deploymentId, depIds) : undefined;

  const [jobStats] = await db
    .select({
      totalJobs: count(),
      totalProcessed: sum(processingJobs.processedImages),
    })
    .from(processingJobs)
    .where(jobWhere);

  const [detStats] = await db
    .select({ totalDetections: count() })
    .from(detections)
    .innerJoin(images, eq(detections.imageId, images.id))
    .where(imgWhere);

  const [specStats] = await db
    .select({ totalSpecies: sql<number>`count(distinct coalesce(${identifications.correctedSpecies}, ${identifications.species}))` })
    .from(identifications)
    .innerJoin(detections, eq(identifications.detectionId, detections.id))
    .innerJoin(images, eq(detections.imageId, images.id))
    .where(imgWhere);

  return {
    totalJobs: jobStats?.totalJobs || 0,
    totalImagesProcessed: Number(jobStats?.totalProcessed) || 0,
    totalDetections: detStats?.totalDetections || 0,
    uniqueSpecies: specStats?.totalSpecies || 0,
  };
}

export async function getJobWithDetails(jobId: number) {
  const user = await requirePermission("camera-trap", "viewer");

  const [job] = await db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId));

  if (!job) return null;

  try {
    await requireDeploymentAccess(user, job.deploymentId);
  } catch {
    return null;
  }

  const [deployment] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, job.deploymentId));

  const jobImages = await db
    .select()
    .from(images)
    .where(eq(images.jobId, jobId));

  return { job, deployment, images: jobImages };
}

export async function getImageWithDetections(imageId: number) {
  const user = await requirePermission("camera-trap", "viewer");

  const [row] = await db
    .select({
      image: images,
      deploymentName: deployments.name,
    })
    .from(images)
    .leftJoin(deployments, eq(images.deploymentId, deployments.id))
    .where(eq(images.id, imageId));

  if (!row) return null;

  try {
    await requireDeploymentAccess(user, row.image.deploymentId);
  } catch {
    return null;
  }

  const image = row.image;
  const deploymentName = row.deploymentName;

  const imageDetections = await db
    .select()
    .from(detections)
    .where(eq(detections.imageId, imageId));

  const detectionIds = imageDetections.map((d) => d.id);
  const imageIdentifications =
    detectionIds.length > 0
      ? await db
          .select()
          .from(identifications)
          .where(inArray(identifications.detectionId, detectionIds))
      : [];

  const identByDetection = new Map<
    number,
    (typeof imageIdentifications)[number]
  >();
  for (const ident of imageIdentifications) {
    identByDetection.set(ident.detectionId, ident);
  }

  return {
    image,
    deploymentName,
    detections: imageDetections.map((det) => ({
      ...det,
      identification: identByDetection.get(det.id) || null,
    })),
  };
}

export async function getJobImageIds(jobId: number): Promise<number[]> {
  const user = await requirePermission("camera-trap", "viewer");

  const [job] = await db
    .select({ deploymentId: processingJobs.deploymentId })
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId));
  if (!job) return [];

  try {
    await requireDeploymentAccess(user, job.deploymentId);
  } catch {
    return [];
  }

  const rows = await db
    .select({ id: images.id })
    .from(images)
    .where(eq(images.jobId, jobId))
    .orderBy(IMAGE_TIMESTAMP_ORDER, images.filename);

  return rows.map((r) => r.id);
}

/**
 * Fetch all data needed to render the image annotation client for a single image.
 * Used by the embedded annotation view on the deployment detail page.
 *
 * When `navigationIds` is provided (and non-empty), prev/next/currentIndex/totalImages
 * are computed from that ordered list instead of all images in the job. This lets the
 * caller scope navigation to a filtered subset (see deployment-gallery-client.tsx).
 */
export async function getImageAnnotationData(
  imageId: number,
  jobId: number,
  navigationIds?: number[],
) {
  // Fetch the image first because every other query needs its deploymentId
  // (verification stats, frequent species). Returning early on a missing
  // image avoids fanning out queries we'd throw away.
  const data = await getImageWithDetections(imageId);
  if (!data) return null;

  const { image, deploymentName, detections: rawDetections } = data;
  const useFilter = navigationIds !== undefined && navigationIds.length > 0;

  // Verification stats are intentionally deployment-scoped (not per-job).
  // The annotation header reads "X/Y revisadas" — that's the user's mental
  // model of "how much of THIS deployment have I reviewed?", not "how much of
  // the latest ML job". An incremental run would otherwise show "0/2" instead
  // of the deployment-wide progress.
  const [fullJobImageIds, speciesList, verificationStats, frequentSpeciesResult] = await Promise.all([
    useFilter ? Promise.resolve([] as number[]) : getJobImageIds(jobId),
    getSpeciesList(),
    getDeploymentVerificationStats(image.deploymentId),
    getFrequentSpecies(image.deploymentId),
  ]);

  const imageIds = useFilter ? navigationIds! : fullJobImageIds;
  const frequentSpecies = frequentSpeciesResult.success ? frequentSpeciesResult.data : [];

  const currentIndex = imageIds.indexOf(imageId);
  const prevImageId = currentIndex > 0 ? imageIds[currentIndex - 1] : null;
  const nextImageId =
    currentIndex >= 0 && currentIndex < imageIds.length - 1
      ? imageIds[currentIndex + 1]
      : null;

  const boxes = rawDetections.map((det) => ({
    id: det.id,
    x: det.bboxX,
    y: det.bboxY,
    width: det.bboxWidth,
    height: det.bboxHeight,
    detectionConfidence: det.detectionConfidence,
    detectionClass: det.detectionClass,
    species: det.identification?.correctedSpecies || det.identification?.species || null,
    speciesConfidence: det.identification?.confidence || null,
    verificationStatus: det.identification?.verificationStatus || "unverified",
  }));

  const annotationDetections = rawDetections.map((det) => ({
    id: det.id,
    detectionClass: det.detectionClass,
    detectionConfidence: det.detectionConfidence,
    bboxX: det.bboxX,
    bboxY: det.bboxY,
    bboxWidth: det.bboxWidth,
    bboxHeight: det.bboxHeight,
    identification: det.identification
      ? {
          id: det.identification.id,
          species: det.identification.species,
          confidence: det.identification.confidence,
          verificationStatus: det.identification.verificationStatus,
          correctedSpecies: det.identification.correctedSpecies,
        }
      : null,
  }));

  // Format timestamp
  const rawTimestamp = image.exifTimestamp
    ? new Date(image.exifTimestamp)
    : image.fileModified
      ? new Date(image.fileModified)
      : null;
  const timestamp =
    rawTimestamp && !isNaN(rawTimestamp.getTime())
      ? rawTimestamp.toLocaleDateString("es-EC", {
          day: "numeric",
          month: "short",
          year: "numeric",
        }) +
        ", " +
        rawTimestamp.toLocaleTimeString("es-EC", {
          hour: "2-digit",
          minute: "2-digit",
        })
      : null;

  return {
    image: {
      id: image.id,
      filename: image.filename,
      confirmedBlank: image.confirmedBlank,
      starred: image.starred,
      starredBy: image.starredBy,
      setupTag: image.setupTag as "deployment" | "retrieval" | null,
      videoId: image.videoId,
      frameIndex: image.frameIndex,
    },
    deploymentName,
    timestamp,
    boxes,
    detections: annotationDetections,
    speciesList,
    frequentSpecies,
    prevImageId,
    nextImageId,
    currentIndex,
    totalImages: imageIds.length,
    verificationStats,
  };
}

/**
 * Session-wide annotation context, fetched once when the annotation overlay
 * opens. Returns data that is stable across neighbor images in the same
 * deployment / job, so per-navigation queries don't have to refetch it.
 *
 * Pair with `getImagePayload` for the per-image cost.
 *
 * When `navigationIds` is provided (and non-empty), it's returned as `imageIds`
 * directly; otherwise the full job image list is fetched.
 */
export async function getAnnotationSessionContext(
  jobId: number,
  deploymentId: number,
  navigationIds?: number[],
) {
  const user = await requirePermission("camera-trap", "viewer");
  await requireDeploymentAccess(user, deploymentId);

  const useFilter = navigationIds !== undefined && navigationIds.length > 0;

  const [speciesList, freqResult, verificationStats, fullJobImageIds, deploymentRow] =
    await Promise.all([
      getSpeciesList(),
      getFrequentSpecies(deploymentId),
      getDeploymentVerificationStats(deploymentId),
      useFilter ? Promise.resolve([] as number[]) : getJobImageIds(jobId),
      db
        .select({ name: deployments.name })
        .from(deployments)
        .where(eq(deployments.id, deploymentId)),
    ]);

  return {
    speciesList,
    frequentSpecies: freqResult.success ? freqResult.data : [],
    deploymentName: deploymentRow[0]?.name ?? null,
    imageIds: useFilter ? navigationIds! : fullJobImageIds,
    verificationStats,
  };
}

/**
 * Lightweight per-image annotation payload. Only fetches the image row,
 * its detections, and their identifications — about a third of the work of
 * `getImageAnnotationData`. Designed to be safe to call speculatively from
 * the client-side prefetch queue while the user is annotating.
 *
 * Returns `null` for images the current user can't access (consistent with
 * `getImageWithDetections`), so prefetch consumers can ignore failures.
 */
export async function getImagePayload(imageId: number) {
  const data = await getImageWithDetections(imageId);
  if (!data) return null;

  const { image, deploymentName, detections: rawDetections } = data;

  const boxes = rawDetections.map((det) => ({
    id: det.id,
    x: det.bboxX,
    y: det.bboxY,
    width: det.bboxWidth,
    height: det.bboxHeight,
    detectionConfidence: det.detectionConfidence,
    detectionClass: det.detectionClass,
    species: det.identification?.correctedSpecies || det.identification?.species || null,
    speciesConfidence: det.identification?.confidence || null,
    verificationStatus: det.identification?.verificationStatus || "unverified",
  }));

  const annotationDetections = rawDetections.map((det) => ({
    id: det.id,
    detectionClass: det.detectionClass,
    detectionConfidence: det.detectionConfidence,
    bboxX: det.bboxX,
    bboxY: det.bboxY,
    bboxWidth: det.bboxWidth,
    bboxHeight: det.bboxHeight,
    identification: det.identification
      ? {
          id: det.identification.id,
          species: det.identification.species,
          confidence: det.identification.confidence,
          verificationStatus: det.identification.verificationStatus,
          correctedSpecies: det.identification.correctedSpecies,
        }
      : null,
  }));

  const rawTimestamp = image.exifTimestamp
    ? new Date(image.exifTimestamp)
    : image.fileModified
      ? new Date(image.fileModified)
      : null;
  const timestamp =
    rawTimestamp && !isNaN(rawTimestamp.getTime())
      ? rawTimestamp.toLocaleDateString("es-EC", {
          day: "numeric",
          month: "short",
          year: "numeric",
        }) +
        ", " +
        rawTimestamp.toLocaleTimeString("es-EC", {
          hour: "2-digit",
          minute: "2-digit",
        })
      : null;

  return {
    image: {
      id: image.id,
      filename: image.filename,
      deploymentId: image.deploymentId,
      confirmedBlank: image.confirmedBlank,
      starred: image.starred,
      starredBy: image.starredBy,
      setupTag: image.setupTag as "deployment" | "retrieval" | null,
      videoId: image.videoId,
      frameIndex: image.frameIndex,
    },
    deploymentName,
    timestamp,
    boxes,
    detections: annotationDetections,
  };
}

// ---------------------------------------------------------------------------
// Annotation / Verification
// ---------------------------------------------------------------------------

export async function verifyIdentification(
  identificationId: number
): Promise<ActionResult> {
  const user = await requirePermission("camera-trap", "editor");

  try {
    const depId = await getDeploymentIdForIdentification(identificationId);
    if (!depId) {
      return { success: false, error: "Identificación no encontrada" };
    }
    await requireDeploymentAccess(user, depId);

    await db
      .update(identifications)
      .set({
        verificationStatus: "verified",
        verifiedBy: user.email,
        verifiedAt: new Date(),
      })
      .where(
        and(
          eq(identifications.id, identificationId),
          eq(identifications.verificationStatus, "unverified")
        )
      );

    await maybeAutoCompleteDeployment(depId);
    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al verificar",
    };
  }
}

export async function rejectIdentification(
  identificationId: number
): Promise<ActionResult> {
  const user = await requirePermission("camera-trap", "editor");

  try {
    const depId = await getDeploymentIdForIdentification(identificationId);
    if (!depId) {
      return { success: false, error: "Identificación no encontrada" };
    }
    await requireDeploymentAccess(user, depId);

    await db
      .update(identifications)
      .set({
        verificationStatus: "rejected",
        verifiedBy: user.email,
        verifiedAt: new Date(),
      })
      .where(
        and(
          eq(identifications.id, identificationId),
          eq(identifications.verificationStatus, "unverified")
        )
      );

    await maybeAutoCompleteDeployment(depId);
    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al rechazar",
    };
  }
}

export async function correctIdentification(
  identificationId: number,
  newSpecies: string
): Promise<ActionResult> {
  const user = await requirePermission("camera-trap", "editor");

  try {
    const depId = await getDeploymentIdForIdentification(identificationId);
    if (!depId) {
      return { success: false, error: "Identificación no encontrada" };
    }
    await requireDeploymentAccess(user, depId);

    await db
      .update(identifications)
      .set({
        verificationStatus: "corrected",
        correctedSpecies: newSpecies,
        verifiedBy: user.email,
        verifiedAt: new Date(),
      })
      .where(
        and(
          eq(identifications.id, identificationId),
          inArray(identifications.verificationStatus, ["unverified", "verified", "corrected"])
        )
      );

    await maybeAutoCompleteDeployment(depId);
    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al corregir",
    };
  }
}

export async function bulkVerify(
  identificationIds: number[]
): Promise<ActionResult<{ count: number }>> {
  const user = await requirePermission("camera-trap", "editor");

  try {
    if (identificationIds.length === 0) {
      return { success: true, data: { count: 0 } };
    }

    // Verify access to all identifications' deployments
    const depRows = await db
      .select({ deploymentId: images.deploymentId })
      .from(identifications)
      .innerJoin(detections, eq(identifications.detectionId, detections.id))
      .innerJoin(images, eq(detections.imageId, images.id))
      .where(inArray(identifications.id, identificationIds))
      .groupBy(images.deploymentId);
    for (const row of depRows) {
      await requireDeploymentAccess(user, row.deploymentId);
    }

    await db
      .update(identifications)
      .set({
        verificationStatus: "verified",
        verifiedBy: user.email,
        verifiedAt: new Date(),
      })
      .where(
        and(
          inArray(identifications.id, identificationIds),
          eq(identifications.verificationStatus, "unverified")
        )
      );

    for (const row of depRows) {
      await maybeAutoCompleteDeployment(row.deploymentId);
    }
    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: { count: identificationIds.length } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al verificar en lote",
    };
  }
}

export async function bulkVerifyByThreshold(
  jobId: number,
  minConfidence: number
): Promise<ActionResult<{ count: number }>> {
  const user = await requirePermission("camera-trap", "editor");

  try {
    const [job] = await db
      .select({ deploymentId: processingJobs.deploymentId })
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId));
    if (!job) return { success: true, data: { count: 0 } };

    await requireDeploymentAccess(user, job.deploymentId);

    const jobImages = await db
      .select({ id: images.id })
      .from(images)
      .where(eq(images.jobId, jobId));

    if (jobImages.length === 0) {
      return { success: true, data: { count: 0 } };
    }

    const imageIds = jobImages.map((img) => img.id);
    const jobDets = await db
      .select({ id: detections.id })
      .from(detections)
      .where(inArray(detections.imageId, imageIds));

    if (jobDets.length === 0) {
      return { success: true, data: { count: 0 } };
    }

    const detectionIds = jobDets.map((d) => d.id);

    const unverifiedAboveThreshold = await db
      .select({ id: identifications.id })
      .from(identifications)
      .where(
        and(
          inArray(identifications.detectionId, detectionIds),
          eq(identifications.verificationStatus, "unverified"),
          gte(identifications.confidence, minConfidence)
        )
      );

    if (unverifiedAboveThreshold.length === 0) {
      return { success: true, data: { count: 0 } };
    }

    const ids = unverifiedAboveThreshold.map((i) => i.id);

    await db
      .update(identifications)
      .set({
        verificationStatus: "verified",
        verifiedBy: user.email,
        verifiedAt: new Date(),
      })
      .where(inArray(identifications.id, ids));

    await maybeAutoCompleteDeployment(job.deploymentId);
    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: { count: ids.length } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al verificar por umbral",
    };
  }
}

// ---------------------------------------------------------------------------
// Species + Verification Stats
// ---------------------------------------------------------------------------

export async function getSpeciesList() {
  await requirePermission("camera-trap", "viewer");
  return db.select().from(species).orderBy(species.commonName);
}

export async function getJobSpecies(jobId: number): Promise<string[]> {
  const user = await requirePermission("camera-trap", "viewer");

  const [job] = await db
    .select({ deploymentId: processingJobs.deploymentId })
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId));
  if (!job) return [];

  try {
    await requireDeploymentAccess(user, job.deploymentId);
  } catch {
    return [];
  }

  const jobImages = await db
    .select({ id: images.id })
    .from(images)
    .where(eq(images.jobId, jobId));

  if (jobImages.length === 0) return [];

  const imageIds = jobImages.map((img) => img.id);
  const jobDets = await db
    .select({ id: detections.id })
    .from(detections)
    .where(inArray(detections.imageId, imageIds));

  if (jobDets.length === 0) return [];

  const detectionIds = jobDets.map((d) => d.id);
  const idents = await db
    .select({ species: identifications.species })
    .from(identifications)
    .where(inArray(identifications.detectionId, detectionIds));

  return [...new Set(idents.map((i) => i.species))].sort();
}

/**
 * FIX: Single JOIN query instead of N+1 loop.
 */
export async function getNextUnverifiedImageId(
  jobId: number,
  currentImageId?: number
): Promise<number | null> {
  const user = await requirePermission("camera-trap", "viewer");

  const [job] = await db
    .select({ deploymentId: processingJobs.deploymentId })
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId));
  if (!job) return null;

  try {
    await requireDeploymentAccess(user, job.deploymentId);
  } catch {
    return null;
  }

  const conditions = [
    eq(images.jobId, jobId),
    eq(identifications.verificationStatus, "unverified"),
  ];

  if (currentImageId) {
    conditions.push(sql`${images.id} > ${currentImageId}` as ReturnType<typeof eq>);
  }

  const result = await db
    .select({ id: images.id })
    .from(images)
    .innerJoin(detections, eq(detections.imageId, images.id))
    .innerJoin(identifications, eq(identifications.detectionId, detections.id))
    .where(and(...conditions))
    .orderBy(images.id)
    .limit(1);

  return result.length > 0 ? result[0].id : null;
}

export async function getJobVerificationStats(
  jobId: number
): Promise<VerificationStats> {
  const user = await requirePermission("camera-trap", "viewer");
  const emptyStats: VerificationStats = { total: 0, verified: 0, rejected: 0, corrected: 0, unverified: 0 };

  const [job] = await db
    .select({ deploymentId: processingJobs.deploymentId })
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId));
  if (!job) return emptyStats;

  try {
    await requireDeploymentAccess(user, job.deploymentId);
  } catch {
    return emptyStats;
  }

  const jobImages = await db
    .select({ id: images.id, confirmedBlank: images.confirmedBlank })
    .from(images)
    .where(eq(images.jobId, jobId));

  if (jobImages.length === 0) return emptyStats;

  const imageIds = jobImages.map((img) => img.id);
  // Pull detections with their identification (if any). Person/vehicle
  // detections have no identification row, so we can't just count
  // detections — we need to know which images have at least one
  // identification (i.e. animal detection).
  const detsWithIdent = await db
    .select({
      detectionId: detections.id,
      imageId: detections.imageId,
      identVerificationStatus: identifications.verificationStatus,
    })
    .from(detections)
    .innerJoin(identifications, eq(identifications.detectionId, detections.id))
    .where(inArray(detections.imageId, imageIds));

  // Blank-reviewable images: no identifications whatsoever. Either the
  // image has zero detections or only person/vehicle detections (which
  // aren't classified). Each one counts as a single review unit, marked
  // reviewed when confirmedBlank = true.
  const imagesWithIdentifications = new Set(detsWithIdent.map((d) => d.imageId));
  let blankTotal = 0;
  let blankReviewed = 0;
  for (const img of jobImages) {
    if (!imagesWithIdentifications.has(img.id)) {
      blankTotal++;
      if (img.confirmedBlank) blankReviewed++;
    }
  }

  const stats: VerificationStats = {
    total: blankTotal + detsWithIdent.length,
    verified: 0,
    rejected: 0,
    corrected: 0,
    unverified: blankTotal - blankReviewed,
  };

  for (const i of detsWithIdent) {
    if (i.identVerificationStatus === "verified") stats.verified++;
    else if (i.identVerificationStatus === "rejected") stats.rejected++;
    else if (i.identVerificationStatus === "corrected") stats.corrected++;
    else stats.unverified++;
  }

  return stats;
}

export async function getDeploymentVerificationStats(
  deploymentId: number
): Promise<VerificationStats> {
  const user = await requirePermission("camera-trap", "viewer");
  const emptyStats: VerificationStats = { total: 0, verified: 0, rejected: 0, corrected: 0, unverified: 0 };

  try {
    await requireDeploymentAccess(user, deploymentId);
  } catch {
    return emptyStats;
  }

  const deploymentJobs = await db
    .select({ id: processingJobs.id })
    .from(processingJobs)
    .where(eq(processingJobs.deploymentId, deploymentId));

  if (deploymentJobs.length === 0) return emptyStats;

  const jobIds = deploymentJobs.map((j) => j.id);
  const jobImages = await db
    .select({ id: images.id, confirmedBlank: images.confirmedBlank })
    .from(images)
    .where(inArray(images.jobId, jobIds));

  if (jobImages.length === 0) return emptyStats;

  const imageIds = jobImages.map((img) => img.id);
  const detsWithIdent = await db
    .select({
      detectionId: detections.id,
      imageId: detections.imageId,
      identVerificationStatus: identifications.verificationStatus,
    })
    .from(detections)
    .innerJoin(identifications, eq(identifications.detectionId, detections.id))
    .where(inArray(detections.imageId, imageIds));

  // Blank-reviewable images: no identifications whatsoever (zero detections
  // or only person/vehicle detections). Reviewed when confirmedBlank = true.
  const imagesWithIdentifications = new Set(detsWithIdent.map((d) => d.imageId));
  let blankTotal = 0;
  let blankReviewed = 0;
  for (const img of jobImages) {
    if (!imagesWithIdentifications.has(img.id)) {
      blankTotal++;
      if (img.confirmedBlank) blankReviewed++;
    }
  }

  const stats: VerificationStats = {
    total: blankTotal + detsWithIdent.length,
    verified: 0,
    rejected: 0,
    corrected: 0,
    unverified: blankTotal - blankReviewed,
  };

  for (const i of detsWithIdent) {
    if (i.identVerificationStatus === "verified") stats.verified++;
    else if (i.identVerificationStatus === "rejected") stats.rejected++;
    else if (i.identVerificationStatus === "corrected") stats.corrected++;
    else stats.unverified++;
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Species CRUD
// ---------------------------------------------------------------------------

export async function createSpecies(data: {
  scientificName: string;
  commonName: string;
  spanishName?: string | null;
  taxonomicRank?: TaxonomicRank;
  type?: string;
}): Promise<ActionResult<Species>> {
  await requirePermission("camera-trap", "editor");

  try {
    const [result] = await db
      .insert(species)
      .values({
        scientificName: data.scientificName.trim(),
        commonName: data.commonName.trim(),
        spanishName: data.spanishName?.trim() || null,
        taxonomicRank: data.taxonomicRank || "species",
        type: (data.type as Species["type"]) || "mammal",
      })
      .returning();

    revalidatePath("/camera-trap/species");
    return { success: true, data: result };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error al crear especie";
    if (msg.includes("UNIQUE constraint")) {
      return { success: false, error: "Ya existe una especie con ese nombre científico" };
    }
    return { success: false, error: msg };
  }
}

export async function updateSpecies(
  id: number,
  data: {
    scientificName?: string;
    commonName?: string;
    spanishName?: string | null;
    taxonomicRank?: TaxonomicRank;
    type?: string;
  }
): Promise<ActionResult<Species>> {
  const user = await requirePermission("camera-trap", "editor");

  try {
    const updates: Record<string, unknown> = {};
    if (data.scientificName !== undefined) updates.scientificName = data.scientificName.trim();
    if (data.commonName !== undefined) updates.commonName = data.commonName.trim();
    if (data.spanishName !== undefined) updates.spanishName = data.spanishName?.trim() || null;
    if (data.taxonomicRank !== undefined) updates.taxonomicRank = data.taxonomicRank;
    if (data.type !== undefined) updates.type = data.type;

    // Fetch old record to detect scientificName change
    const [old] = await db
      .select()
      .from(species)
      .where(eq(species.id, id));

    if (!old) {
      return { success: false, error: "Especie no encontrada" };
    }

    const newName = (updates.scientificName as string | undefined) ?? old.scientificName;
    const nameChanged = newName !== old.scientificName;

    if (nameChanged) {
      // Use transaction to atomically update species + cascade to identifications
      const result = db.transaction((tx) => {
        const updated = tx
          .update(species)
          .set(updates)
          .where(eq(species.id, id))
          .returning()
          .get();

        // Cascade to identifications.species
        tx.update(identifications)
          .set({ species: newName })
          .where(eq(identifications.species, old.scientificName))
          .run();

        // Cascade to identifications.correctedSpecies
        tx.update(identifications)
          .set({ correctedSpecies: newName })
          .where(eq(identifications.correctedSpecies, old.scientificName))
          .run();

        // Cascade to audioIdentifications.species
        tx.update(audioIdentifications)
          .set({ species: newName })
          .where(eq(audioIdentifications.species, old.scientificName))
          .run();

        // Cascade to audioIdentifications.correctedSpecies
        tx.update(audioIdentifications)
          .set({ correctedSpecies: newName })
          .where(eq(audioIdentifications.correctedSpecies, old.scientificName))
          .run();

        tx.insert(activityLog).values({
          userEmail: user.email,
          action: "rename_species",
          projectId: "camera-trap",
          targetType: "species",
          targetId: String(id),
          details: JSON.stringify({
            oldName: old.scientificName,
            newName,
          }),
        }).run();

        return updated;
      });

      revalidatePath("/camera-trap/species");
      revalidatePath("/camera-trap/results");
      return { success: true, data: result };
    }

    // No name change — simple update, no cascade needed
    const [result] = await db
      .update(species)
      .set(updates)
      .where(eq(species.id, id))
      .returning();

    revalidatePath("/camera-trap/species");
    return { success: true, data: result! };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error al actualizar especie";
    if (msg.includes("UNIQUE constraint")) {
      return { success: false, error: "Ya existe una especie con ese nombre científico" };
    }
    return { success: false, error: msg };
  }
}

export async function deleteSpecies(id: number): Promise<ActionResult> {
  const user = await requirePermission("camera-trap", "editor");

  try {
    const [sp] = await db
      .select()
      .from(species)
      .where(eq(species.id, id));

    if (!sp) {
      return { success: false, error: "Especie no encontrada" };
    }

    // TOCTOU: re-check usage count at delete time
    const [usage] = await db
      .select({ cnt: count() })
      .from(identifications)
      .where(eq(identifications.correctedSpecies, sp.scientificName));

    if ((usage?.cnt ?? 0) > 0) {
      return {
        success: false,
        error: `No se puede eliminar: la especie está referenciada en ${usage.cnt} correcciones`,
      };
    }

    await db.delete(species).where(eq(species.id, id));

    await db.insert(activityLog).values({
      userEmail: user.email,
      action: "delete_species",
      projectId: "camera-trap",
      targetType: "species",
      targetId: String(id),
      details: JSON.stringify({ scientificName: sp.scientificName, commonName: sp.commonName }),
    });

    revalidatePath("/camera-trap/species");
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al eliminar especie",
    };
  }
}

export async function getSpeciesUsageCount(
  id: number
): Promise<ActionResult<number>> {
  await requirePermission("camera-trap", "viewer");

  const [sp] = await db
    .select()
    .from(species)
    .where(eq(species.id, id));

  if (!sp) {
    return { success: false, error: "Especie no encontrada" };
  }

  const [usage] = await db
    .select({ cnt: count() })
    .from(identifications)
    .where(eq(identifications.correctedSpecies, sp.scientificName));

  return { success: true, data: usage?.cnt ?? 0 };
}

export async function getFrequentSpecies(
  deploymentId: number,
  limit = 8
): Promise<ActionResult<Species[]>> {
  await requirePermission("camera-trap", "viewer");

  const rows = await db
    .select({
      id: species.id,
      scientificName: species.scientificName,
      commonName: species.commonName,
      spanishName: species.spanishName,
      type: species.type,
      taxonomicRank: species.taxonomicRank,
    })
    .from(identifications)
    .innerJoin(detections, eq(detections.id, identifications.detectionId))
    .innerJoin(images, eq(images.id, detections.imageId))
    .innerJoin(species, eq(species.scientificName, identifications.correctedSpecies))
    .where(
      and(
        eq(images.deploymentId, deploymentId),
        isNotNull(identifications.correctedSpecies)
      )
    )
    .groupBy(identifications.correctedSpecies)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);

  return { success: true, data: rows as Species[] };
}

export async function deleteDetection(
  detectionId: number
): Promise<ActionResult> {
  const user = await requirePermission("camera-trap", "editor");

  try {
    const depId = await getDeploymentIdForDetection(detectionId);
    if (!depId) {
      return { success: false, error: "Detección no encontrada" };
    }
    await requireDeploymentAccess(user, depId);

    // Fetch detection + image info for activity log
    const [det] = await db
      .select({
        id: detections.id,
        imageId: detections.imageId,
        filename: images.filename,
      })
      .from(detections)
      .innerJoin(images, eq(images.id, detections.imageId))
      .where(eq(detections.id, detectionId));

    if (!det) {
      return { success: false, error: "Detección no encontrada" };
    }

    // Hard delete — CASCADE will remove the identification row
    await db.delete(detections).where(eq(detections.id, detectionId));

    await db.insert(activityLog).values({
      userEmail: user.email,
      action: "delete_detection",
      projectId: "camera-trap",
      targetType: "detection",
      targetId: String(detectionId),
      details: JSON.stringify({
        imageId: det.imageId,
        filename: det.filename,
      }),
    });

    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al eliminar detección",
    };
  }
}

export async function assignSpecies(
  identificationId: number,
  newSpecies: string
): Promise<ActionResult> {
  const user = await requirePermission("camera-trap", "editor");

  try {
    const depId = await getDeploymentIdForIdentification(identificationId);
    if (!depId) {
      return { success: false, error: "Identificación no encontrada" };
    }
    await requireDeploymentAccess(user, depId);

    // Fetch the identification to compare against original ML prediction
    const [ident] = await db
      .select({
        id: identifications.id,
        species: identifications.species,
        verificationStatus: identifications.verificationStatus,
      })
      .from(identifications)
      .where(eq(identifications.id, identificationId));

    if (!ident) {
      return { success: false, error: "Identificación no encontrada" };
    }

    // If species matches original ML prediction → verify; otherwise → correct
    // Also allow re-assigning species to rejected detections (un-rejects them)
    const isMatch = newSpecies === ident.species;

    await db
      .update(identifications)
      .set({
        verificationStatus: isMatch ? "verified" : "corrected",
        correctedSpecies: isMatch ? null : newSpecies,
        verifiedBy: user.email,
        verifiedAt: new Date(),
      })
      .where(eq(identifications.id, identificationId));

    await maybeAutoCompleteDeployment(depId);
    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al asignar especie",
    };
  }
}

export async function createManualDetection(
  imageId: number,
  bbox: { x: number; y: number; width: number; height: number }
): Promise<ActionResult<{ detectionId: number; identificationId: number }>> {
  const user = await requirePermission("camera-trap", "editor");

  try {
    const [img] = await db
      .select({ deploymentId: images.deploymentId })
      .from(images)
      .where(eq(images.id, imageId));
    if (img) await requireDeploymentAccess(user, img.deploymentId);
    const { x, y, width, height } = bbox;
    if (
      typeof x !== "number" || typeof y !== "number" ||
      typeof width !== "number" || typeof height !== "number" ||
      x < 0 || y < 0 || width <= 0 || height <= 0 ||
      x + width > 1.01 || y + height > 1.01
    ) {
      return { success: false, error: "Coordenadas de bbox inválidas" };
    }

    const [image] = await db
      .select({ id: images.id, confirmedBlank: images.confirmedBlank })
      .from(images)
      .where(eq(images.id, imageId));

    if (!image) {
      return { success: false, error: "Imagen no encontrada" };
    }

    const [det] = await db
      .insert(detections)
      .values({
        imageId,
        jobId: null,
        bboxX: x,
        bboxY: y,
        bboxWidth: width,
        bboxHeight: height,
        detectionConfidence: 1.0,
        detectionClass: 0,
        modelVersion: "manual",
      })
      .returning();

    const [ident] = await db
      .insert(identifications)
      .values({
        detectionId: det.id,
        species: "unknown",
        confidence: 1.0,
        modelVersion: "manual",
        verificationStatus: "unverified",
      })
      .returning();

    // Auto-clear confirmed blank when adding a manual detection
    if (image.confirmedBlank) {
      await db
        .update(images)
        .set({ confirmedBlank: false })
        .where(eq(images.id, imageId));
    }

    // Revert verified deployment back to processed (new unverified identification added)
    if (img) {
      const [dep] = await db
        .select({ status: deployments.status })
        .from(deployments)
        .where(eq(deployments.id, img.deploymentId));
      if (dep?.status === "verified") {
        await db
          .update(deployments)
          .set({ status: "processed", updatedAt: new Date() })
          .where(eq(deployments.id, img.deploymentId));
      }
    }

    return {
      success: true,
      data: { detectionId: det.id, identificationId: ident.id },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al crear detección",
    };
  }
}

export async function verifyAndAdvance(
  identificationIds: number[],
  jobId: number,
  currentImageId: number,
  candidateImageIds?: number[]
): Promise<ActionResult<{ nextImageId: number | null; deploymentCompleted?: boolean }>> {
  const user = await requirePermission("camera-trap", "editor");

  try {
    const [job] = await db
      .select({ deploymentId: processingJobs.deploymentId })
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId));
    if (!job) return { success: false, error: "Trabajo no encontrado" };

    await requireDeploymentAccess(user, job.deploymentId);

    if (identificationIds.length > 0) {
      await db
        .update(identifications)
        .set({
          verificationStatus: "verified",
          verifiedBy: user.email,
          verifiedAt: new Date(),
        })
        .where(
          and(
            inArray(identifications.id, identificationIds),
            eq(identifications.verificationStatus, "unverified")
          )
        );
    }

    const filtered = candidateImageIds !== undefined && candidateImageIds.length > 0;

    let nextId: number | null;

    if (filtered) {
      // Filtered path: walk the caller's ordered list. Find next unverified image
      // strictly after currentImageId in list order; if none, wrap around from start.
      const startIdx = candidateImageIds!.indexOf(currentImageId);
      const ordered =
        startIdx >= 0
          ? [
              ...candidateImageIds!.slice(startIdx + 1),
              ...candidateImageIds!.slice(0, startIdx),
            ]
          : candidateImageIds!;

      const unverifiedRows = await db
        .select({ id: images.id })
        .from(images)
        .innerJoin(detections, eq(detections.imageId, images.id))
        .innerJoin(identifications, eq(identifications.detectionId, detections.id))
        .where(
          and(
            eq(images.jobId, jobId),
            eq(identifications.verificationStatus, "unverified"),
            inArray(images.id, candidateImageIds!)
          )
        );

      const unverifiedSet = new Set(unverifiedRows.map((r) => r.id));
      nextId = ordered.find((id) => unverifiedSet.has(id)) ?? null;
    } else {
      // Unfiltered path: original behavior — walk by images.id ascending.
      const forward = await db
        .select({ id: images.id })
        .from(images)
        .innerJoin(detections, eq(detections.imageId, images.id))
        .innerJoin(identifications, eq(identifications.detectionId, detections.id))
        .where(
          and(
            eq(images.jobId, jobId),
            eq(identifications.verificationStatus, "unverified"),
            sql`${images.id} > ${currentImageId}`
          )
        )
        .orderBy(images.id)
        .limit(1);

      if (forward.length > 0) {
        revalidatePath(CAMERA_TRAP_PATH);
        return { success: true, data: { nextImageId: forward[0].id } };
      }

      // Wrap around from beginning
      const wrapped = await db
        .select({ id: images.id })
        .from(images)
        .innerJoin(detections, eq(detections.imageId, images.id))
        .innerJoin(identifications, eq(identifications.detectionId, detections.id))
        .where(
          and(
            eq(images.jobId, jobId),
            eq(identifications.verificationStatus, "unverified")
          )
        )
        .orderBy(images.id)
        .limit(1);

      nextId =
        wrapped[0]?.id === currentImageId ? null : (wrapped[0]?.id ?? null);
    }

    // Only auto-complete the deployment when navigating the full job, not a
    // filtered subset — finishing a filter is not the same as finishing the
    // deployment.
    let deploymentCompleted = false;
    if (nextId === null && !filtered) {
      deploymentCompleted = await maybeAutoCompleteDeployment(job.deploymentId);
    }

    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: { nextImageId: nextId, deploymentCompleted } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al verificar",
    };
  }
}

// ---------------------------------------------------------------------------
// Per-image blank confirmation
// ---------------------------------------------------------------------------

export async function toggleConfirmedBlank(
  imageId: number
): Promise<ActionResult<{ confirmedBlank: boolean; rejectedCount: number }>> {
  const user = await requirePermission("camera-trap", "editor");

  try {
    const [image] = await db
      .select({
        id: images.id,
        deploymentId: images.deploymentId,
        status: images.status,
        confirmedBlank: images.confirmedBlank,
      })
      .from(images)
      .where(eq(images.id, imageId));

    if (!image) {
      return { success: false, error: "Imagen no encontrada" };
    }

    await requireDeploymentAccess(user, image.deploymentId);

    if (image.status === "pending") {
      return {
        success: false,
        error: "No se puede confirmar una imagen que aún no se ha procesado",
      };
    }

    const newValue = !image.confirmedBlank;
    let rejectedCount = 0;

    // better-sqlite3 transactions must be synchronous — async callbacks
    // throw "Transaction function cannot return a promise" at runtime.
    db.transaction((tx) => {
      tx
        .update(images)
        .set({ confirmedBlank: newValue })
        .where(eq(images.id, imageId))
        .run();

      // When toggling ON, batch-reject all identifications on this image
      if (newValue) {
        const imageDetections = tx
          .select({ id: detections.id })
          .from(detections)
          .where(eq(detections.imageId, imageId))
          .all();

        if (imageDetections.length > 0) {
          const detectionIds = imageDetections.map((d) => d.id);
          const result = tx
            .update(identifications)
            .set({ verificationStatus: "rejected" })
            .where(
              and(
                inArray(identifications.detectionId, detectionIds),
                ne(identifications.verificationStatus, "rejected")
              )
            )
            .run();
          rejectedCount = result.changes;
        }
      }
    });

    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: { confirmedBlank: newValue, rejectedCount } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al actualizar",
    };
  }
}

// ---------------------------------------------------------------------------
// Setup tagging (deployment / retrieval)
// ---------------------------------------------------------------------------

export async function toggleSetupTag(
  imageId: number,
  tag: "deployment" | "retrieval"
): Promise<
  ActionResult<{
    setupTag: string | null;
    suggestion: { field: "validStart" | "validEnd"; value: string; deploymentId: number } | null;
  }>
> {
  const user = await requirePermission("camera-trap", "editor");

  try {
    const [image] = await db
      .select({
        id: images.id,
        deploymentId: images.deploymentId,
        setupTag: images.setupTag,
        exifTimestamp: images.exifTimestamp,
        fileModified: images.fileModified,
      })
      .from(images)
      .where(eq(images.id, imageId));

    if (!image) {
      return { success: false, error: "Imagen no encontrada" };
    }

    await requireDeploymentAccess(user, image.deploymentId);

    // Toggle: if already set to this tag, clear it
    const newValue = image.setupTag === tag ? null : tag;

    await db
      .update(images)
      .set({ setupTag: newValue })
      .where(eq(images.id, imageId));

    // Build date suggestion when setting a tag
    let suggestion: { field: "validStart" | "validEnd"; value: string; deploymentId: number } | null = null;

    if (newValue) {
      const timestamp = image.exifTimestamp
        ? new Date(image.exifTimestamp)
        : image.fileModified
          ? new Date(image.fileModified)
          : null;

      if (timestamp && !isNaN(timestamp.getTime())) {
        // Format as YYYY-MM-DDTHH:mm (datetime-local input format)
        const pad = (n: number) => String(n).padStart(2, "0");
        const formatted = `${timestamp.getFullYear()}-${pad(timestamp.getMonth() + 1)}-${pad(timestamp.getDate())}T${pad(timestamp.getHours())}:${pad(timestamp.getMinutes())}`;

        suggestion = {
          field: tag === "deployment" ? "validStart" : "validEnd",
          deploymentId: image.deploymentId,
          value: formatted,
        };
      }
    }

    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: { setupTag: newValue, suggestion } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al actualizar",
    };
  }
}

export async function applySetupTagDate(
  deploymentId: number,
  field: "validStart" | "validEnd",
  value: string
): Promise<ActionResult<void>> {
  const user = await requirePermission("camera-trap", "editor");

  if (field !== "validStart" && field !== "validEnd") {
    return { success: false, error: "Campo no válido" };
  }

  try {
    await requireDeploymentAccess(user, deploymentId);

    await db
      .update(deployments)
      .set({
        [field]: value,
        updatedAt: new Date(),
      })
      .where(eq(deployments.id, deploymentId));

    await db.insert(activityLog).values({
      userEmail: user.email,
      action: "apply_setup_tag_date",
      projectId: "camera-trap",
      targetType: "deployment",
      targetId: String(deploymentId),
      details: JSON.stringify({ field, value }),
    });

    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al actualizar fecha",
    };
  }
}

// ---------------------------------------------------------------------------
// Image starring / favorites
// ---------------------------------------------------------------------------

export async function toggleStarred(
  imageId: number
): Promise<ActionResult<{ starred: boolean }>> {
  const user = await requirePermission("camera-trap", "editor");

  try {
    const [image] = await db
      .select({ id: images.id, deploymentId: images.deploymentId, starred: images.starred })
      .from(images)
      .where(eq(images.id, imageId));

    if (!image) {
      return { success: false, error: "Imagen no encontrada" };
    }

    await requireDeploymentAccess(user, image.deploymentId);

    const newValue = !image.starred;
    await db
      .update(images)
      .set({
        starred: newValue,
        starredBy: newValue ? user.email : null,
        starredAt: newValue ? new Date() : null,
      })
      .where(eq(images.id, imageId));

    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: { starred: newValue } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al actualizar",
    };
  }
}

// ---------------------------------------------------------------------------
// Preview (without processing)
// ---------------------------------------------------------------------------

export async function getDeploymentImages(deploymentId: number) {
  const user = await requirePermission("camera-trap", "viewer");
  await requireDeploymentAccess(user, deploymentId);

  return db
    .select()
    .from(images)
    .where(eq(images.deploymentId, deploymentId))
    .orderBy(IMAGE_TIMESTAMP_ORDER, images.filename);
}

export async function getDeploymentImageIds(
  deploymentId: number
): Promise<number[]> {
  const user = await requirePermission("camera-trap", "viewer");
  await requireDeploymentAccess(user, deploymentId);

  const rows = await db
    .select({ id: images.id })
    .from(images)
    .where(eq(images.deploymentId, deploymentId))
    .orderBy(IMAGE_TIMESTAMP_ORDER, images.filename);

  return rows.map((r) => r.id);
}

export interface StarredSpeciesEntry {
  scientificName: string;
  commonName: string | null;
  spanishName: string | null;
  count: number;
}

export interface StarredImageEntry {
  id: number;
  filename: string;
  path: string | null;
  status: "pending" | "processed" | "failed";
  thumbnailPath: string | null;
  starred: boolean;
  starredBy: string | null;
  starredAt: Date | null;
  jobId: number | null;
  deploymentId: number;
  deploymentName: string;
  siteName: string | null;
  species: string[];
}

export async function getStarredImages(): Promise<{
  images: StarredImageEntry[];
  speciesList: StarredSpeciesEntry[];
}> {
  const user = await requirePermission("camera-trap", "viewer");
  const ctProjects = await getUserCameraTrapProjects(user);

  const rows = await db
    .select({
      id: images.id,
      filename: images.filename,
      path: images.path,
      status: images.status,
      thumbnailPath: images.thumbnailPath,
      starred: images.starred,
      starredBy: images.starredBy,
      starredAt: images.starredAt,
      jobId: images.jobId,
      deploymentId: images.deploymentId,
      deploymentName: deployments.name,
      siteName: deployments.siteName,
    })
    .from(images)
    .innerJoin(deployments, eq(images.deploymentId, deployments.id))
    .where(and(eq(images.starred, true), ctProjectFilter(ctProjects)))
    .orderBy(desc(images.starredAt));

  const imageIds = rows.map((r) => r.id);

  // Fetch detections + identifications so we can attach species to each image.
  const allDetections = imageIds.length > 0
    ? await db
        .select({ id: detections.id, imageId: detections.imageId })
        .from(detections)
        .where(inArray(detections.imageId, imageIds))
    : [];

  const detectionIds = allDetections.map((d) => d.id);
  const allIdentifications = detectionIds.length > 0
    ? await db
        .select({
          detectionId: identifications.detectionId,
          species: identifications.species,
          correctedSpecies: identifications.correctedSpecies,
        })
        .from(identifications)
        .where(inArray(identifications.detectionId, detectionIds))
    : [];

  const speciesByDetection = new Map<number, string>();
  for (const ident of allIdentifications) {
    const sp = ident.correctedSpecies || ident.species;
    if (sp) speciesByDetection.set(ident.detectionId, sp);
  }

  const speciesByImage = new Map<number, Set<string>>();
  for (const det of allDetections) {
    const sp = speciesByDetection.get(det.id);
    if (!sp) continue;
    const set = speciesByImage.get(det.imageId) ?? new Set<string>();
    set.add(sp);
    speciesByImage.set(det.imageId, set);
  }

  // Species count (each image counted once per species).
  const speciesCount: Record<string, number> = {};
  for (const set of speciesByImage.values()) {
    for (const sp of set) {
      speciesCount[sp] = (speciesCount[sp] ?? 0) + 1;
    }
  }

  const speciesNames = Object.keys(speciesCount);
  const speciesRecords = speciesNames.length > 0
    ? await db
        .select()
        .from(species)
        .where(inArray(species.scientificName, speciesNames))
    : [];
  const speciesRecordMap = new Map(
    speciesRecords.map((r) => [r.scientificName, r])
  );

  const speciesList: StarredSpeciesEntry[] = Object.entries(speciesCount)
    .sort(([, a], [, b]) => b - a)
    .map(([name, cnt]) => {
      const r = speciesRecordMap.get(name);
      return {
        scientificName: name,
        commonName: r?.commonName ?? null,
        spanishName: r?.spanishName ?? null,
        count: cnt,
      };
    });

  const imagesOut: StarredImageEntry[] = rows.map((r) => ({
    ...r,
    species: Array.from(speciesByImage.get(r.id) ?? []),
  }));

  return { images: imagesOut, speciesList };
}

// ---------------------------------------------------------------------------
// Share Links (public share tokens for landowner access)
// ---------------------------------------------------------------------------

export async function createShareLink(
  deploymentId: number,
  label?: string
): Promise<ActionResult<{ token: string; url: string }>> {
  const user = await requirePermission("camera-trap", "editor");
  await requireDeploymentAccess(user, deploymentId);

  try {
    const token = crypto.randomUUID();

    const [result] = await db
      .insert(shareTokens)
      .values({
        token,
        deploymentId,
        createdBy: user.email,
        label: label?.trim() || null,
      })
      .returning();

    await db.insert(activityLog).values({
      userEmail: user.email,
      action: "create_share_link",
      projectId: "camera-trap",
      targetType: "deployment",
      targetId: String(deploymentId),
      details: JSON.stringify({ tokenId: result.id, label: result.label }),
    });

    const url = `${process.env.NEXT_PUBLIC_BASE_URL || "https://portal.fcat-ecuador.org"}/public/share/${token}`;

    revalidatePath(`/camera-trap/${deploymentId}`);
    return { success: true, data: { token, url } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al crear enlace",
    };
  }
}

export async function revokeShareLink(
  tokenId: number
): Promise<ActionResult<void>> {
  const user = await requirePermission("camera-trap", "editor");

  try {
    const [existing] = await db
      .select()
      .from(shareTokens)
      .where(eq(shareTokens.id, tokenId));

    if (!existing) {
      return { success: false, error: "Enlace no encontrado" };
    }

    await requireDeploymentAccess(user, existing.deploymentId);

    await db
      .update(shareTokens)
      .set({ revokedAt: new Date() })
      .where(eq(shareTokens.id, tokenId));

    await db.insert(activityLog).values({
      userEmail: user.email,
      action: "revoke_share_link",
      projectId: "camera-trap",
      targetType: "deployment",
      targetId: String(existing.deploymentId),
      details: JSON.stringify({ tokenId, label: existing.label }),
    });

    revalidatePath(`/camera-trap/${existing.deploymentId}`);
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al revocar enlace",
    };
  }
}

export async function getDeploymentShareLinks(
  deploymentId: number
): Promise<ShareToken[]> {
  const user = await requirePermission("camera-trap", "editor");
  await requireDeploymentAccess(user, deploymentId);

  return db
    .select()
    .from(shareTokens)
    .where(
      and(
        eq(shareTokens.deploymentId, deploymentId),
        sql`${shareTokens.revokedAt} IS NULL`
      )
    )
    .orderBy(desc(shareTokens.createdAt));
}

