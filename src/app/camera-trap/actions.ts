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
  species,
  cameraTrapProjects,
  activityLog,
} from "@/db/schema";
import { eq, desc, inArray, and, gte, ne, sql, count, sum, isNotNull } from "drizzle-orm";
import { runMLPredictions, checkPytorchWildlife, cancelModelServerJob } from "@/lib/ml-runner";
import {
  downloadDeploymentForProcessing,
  downloadVideosForProcessing,
  cleanupJobTempDir,
} from "@/lib/drive-downloader";
import { uploadFramesToDrive } from "@/lib/drive-client";
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
import type { Deployment, ProcessingJob, Species, NewSpecies } from "@/db/schema";
import { ML_DEFAULTS } from "@/lib/ml-defaults";

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
  }
): Promise<ActionResult<{ jobId: number }>> {
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

    // Check for images OR videos (deployments with only videos are valid)
    const deploymentImages = await db
      .select()
      .from(images)
      .where(eq(images.deploymentId, deploymentId));

    const deploymentVideos = await db
      .select()
      .from(videos)
      .where(eq(videos.deploymentId, deploymentId));

    if (deploymentImages.length === 0 && deploymentVideos.length === 0) {
      console.log(`[createProcessingJob] Empty deployment ${deploymentId} — 0 images, 0 videos`);
    }

    const [job] = await db
      .insert(processingJobs)
      .values({
        deploymentId,
        detectorModel: modelConfig?.detectorModel || ML_DEFAULTS.detectorModel,
        classifierModel: modelConfig?.classifierModel || ML_DEFAULTS.classifierModel,
        confidenceThreshold: modelConfig?.confidenceThreshold ?? ML_DEFAULTS.confidenceThreshold,
        frameExtractionRate: modelConfig?.frameExtractionRate ?? 1.0,
        status: "pending",
        totalImages: deploymentImages.length,
        totalVideos: deploymentVideos.length,
        processedImages: 0,
        failedImages: 0,
        createdBy: user.email,
      })
      .returning();

    // Link existing images to this job and reset status
    for (const img of deploymentImages) {
      await db
        .update(images)
        .set({ jobId: job.id, status: "pending", errorMessage: null })
        .where(eq(images.id, img.id));
    }

    await db
      .update(deployments)
      .set({ status: "processing", updatedAt: new Date() })
      .where(eq(deployments.id, deploymentId));

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
      // --- Download images ---
      await db
        .update(processingJobs)
        .set({ statusMessage: "Descargando imágenes de Drive..." })
        .where(eq(processingJobs.id, jobId));

      const downloadResult = await downloadDeploymentForProcessing(
        deployment.id,
        jobId,
        async (downloaded, total) => {
          await db
            .update(processingJobs)
            .set({
              statusMessage: `Descargando imágenes... (${downloaded} de ${total})`,
            })
            .where(eq(processingJobs.id, jobId));
        }
      );
      cacheDir = downloadResult.cacheDir;

      // --- Download videos ---
      const deploymentVideos = await db
        .select()
        .from(videos)
        .where(eq(videos.deploymentId, deployment.id));

      if (deploymentVideos.length > 0) {
        await db
          .update(processingJobs)
          .set({ statusMessage: "Descargando videos de Drive..." })
          .where(eq(processingJobs.id, jobId));

        await downloadVideosForProcessing(
          deployment.id,
          jobId,
          async (downloaded, total) => {
            await db
              .update(processingJobs)
              .set({
                statusMessage: `Descargando videos... (${downloaded} de ${total})`,
              })
              .where(eq(processingJobs.id, jobId));
          }
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
        let totalExtractedFrames = 0;
        const FFMPEG_CONCURRENCY = 4;

        const thumbDir = path.join(
          process.cwd(),
          "data",
          "thumbnails",
          String(deployment.id)
        );
        await fs.mkdir(thumbDir, { recursive: true });

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

            // Insert frame rows and collect IDs for thumbnail generation
            const frameRecords: { id: number; framePath: string; frameName: string }[] = [];
            for (const frame of result.frames) {
              const frameName = path.basename(frame.path);
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
                console.warn(
                  `[processJob] Thumbnail failed for frame ${frameName}:`,
                  err instanceof Error ? err.message : err
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

            console.log(
              `[processJob] Uploaded ${driveFileIds.size}/${framesToUpload.length} frames to Drive`
            );
          }

          // Delete local source videos from cache (originals are on Drive)
          for (const vid of videosToExtract) {
            if (vid.path) {
              try {
                await fs.unlink(vid.path);
                console.log(`[processJob] Deleted cached video: ${vid.path}`);
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
    console.log(`[processJob] Checking ML availability...`);
    await db
      .update(processingJobs)
      .set({ statusMessage: "Verificando disponibilidad ML..." })
      .where(eq(processingJobs.id, jobId));

    const mlCheck = await checkPytorchWildlife();
    console.log(`[processJob] ML check: available=${mlCheck.available}, message=${mlCheck.message}`);

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

      await db
        .update(deployments)
        .set({ status: "scanned", updatedAt: new Date() })
        .where(eq(deployments.id, job.deploymentId));

      safeRevalidate();

      return { success: false, error: mlCheck.message };
    }

    console.log(`[processJob] Starting ML predictions for ${jobImages.length} images (${jobImages.filter(i => i.path).length} with paths)`);
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

    console.log(`[processJob] ML result: success=${mlResult.success}, processed=${mlResult.totalProcessed}, detections=${mlResult.totalDetections}, error=${mlResult.error || "none"}`);

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

    await db
      .update(deployments)
      .set({
        status: finalStatus === "completed" ? "processed" : "scanned",
        updatedAt: new Date(),
      })
      .where(eq(deployments.id, job.deploymentId));

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
    console.error(`[processJob] Unhandled error:`, error);
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

    // Revert deployment status from "processing" to "scanned"
    const [failedJob] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId));
    if (failedJob) {
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

    await db
      .update(processingJobs)
      .set({ status: "cancelled", completedAt: new Date(), statusMessage: null })
      .where(eq(processingJobs.id, jobId));

    await db
      .update(deployments)
      .set({ status: "scanned", updatedAt: new Date() })
      .where(eq(deployments.id, job.deploymentId));

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

    // 3. If no completed jobs remain, revert deployment to "scanned"
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
  lastProcessedAt: Date | null;
  lastJobStatus: string | null;
  lastCompletedJobId: number | null;
  jobCount: number;
  totalDetections: number | null;
  distinctSpecies: number | null;
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

  // Batch: detection counts and species counts per latest completed job
  const completedJobIds = [...completedJobMap.values()];
  const detCountMap = new Map<number, number>();
  const specCountMap = new Map<number, number>();

  if (completedJobIds.length > 0) {
    const detectionCounts = await db
      .select({ jobId: images.jobId, cnt: count() })
      .from(detections)
      .innerJoin(images, eq(detections.imageId, images.id))
      .where(inArray(images.jobId, completedJobIds))
      .groupBy(images.jobId);
    for (const r of detectionCounts) {
      if (r.jobId != null) detCountMap.set(r.jobId, r.cnt);
    }

    const speciesCounts = await db
      .select({
        jobId: images.jobId,
        cnt: sql<number>`count(distinct coalesce(${identifications.correctedSpecies}, ${identifications.species}))`,
      })
      .from(identifications)
      .innerJoin(detections, eq(identifications.detectionId, detections.id))
      .innerJoin(images, eq(detections.imageId, images.id))
      .where(inArray(images.jobId, completedJobIds))
      .groupBy(images.jobId);
    for (const r of speciesCounts) {
      if (r.jobId != null) specCountMap.set(r.jobId, r.cnt);
    }
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
      lastProcessedAt: latestStatus?.completedAt ?? null,
      lastJobStatus: latestStatus?.status ?? null,
      lastCompletedJobId: completedJobId ?? null,
      jobCount: jobInfo?.cnt ?? 0,
      totalDetections: completedJobId != null ? (detCountMap.get(completedJobId) ?? 0) : null,
      distinctSpecies: completedJobId != null ? (specCountMap.get(completedJobId) ?? 0) : null,
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
  }
): Promise<ActionResult> {
  const user = await requirePermission("camera-trap", "editor");

  try {
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
    if (fields.dateStart !== undefined) updates.dateStart = fields.dateStart;
    if (fields.dateEnd !== undefined) updates.dateEnd = fields.dateEnd;

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

/** Get cascade stats for a set of deployments (for delete confirmation). */
export async function getDeploymentsCascadeStats(
  ids: number[]
): Promise<{ totalImages: number; totalDetections: number; totalVerified: number }> {
  const user = await requirePermission("camera-trap", "viewer");

  if (ids.length === 0) return { totalImages: 0, totalDetections: 0, totalVerified: 0 };

  // Verify access to all deployments
  for (const id of ids) {
    try {
      await requireDeploymentAccess(user, id);
    } catch {
      return { totalImages: 0, totalDetections: 0, totalVerified: 0 };
    }
  }

  const [imgStats] = await db
    .select({ cnt: count() })
    .from(images)
    .where(inArray(images.deploymentId, ids));

  const jobRows = await db
    .select({ id: processingJobs.id })
    .from(processingJobs)
    .where(inArray(processingJobs.deploymentId, ids));

  if (jobRows.length === 0) {
    return { totalImages: imgStats?.cnt ?? 0, totalDetections: 0, totalVerified: 0 };
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
  };
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
  deploymentIds: number[]
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
      const result = await createProcessingJob(depId);
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

/** Called at end of processJob to auto-advance the queue. */
async function processNextInQueue(): Promise<void> {
  const [nextJob] = await db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.status, "pending"))
    .orderBy(processingJobs.createdAt)
    .limit(1);

  if (nextJob) {
    console.log(`[Queue] Auto-advancing to job ${nextJob.id} for deployment ${nextJob.deploymentId}`);
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

  const jobs = await db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.deploymentId, id))
    .orderBy(desc(processingJobs.createdAt));

  return { deployment, images: deploymentImages, jobs };
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
    .orderBy(images.id);

  return rows.map((r) => r.id);
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
    if (depId) await requireDeploymentAccess(user, depId);

    const result = await db
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
    if (depId) await requireDeploymentAccess(user, depId);

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
    if (depId) await requireDeploymentAccess(user, depId);

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
    .select({ id: images.id })
    .from(images)
    .where(eq(images.jobId, jobId));

  if (jobImages.length === 0) return emptyStats;

  const imageIds = jobImages.map((img) => img.id);
  const jobDets = await db
    .select({ id: detections.id })
    .from(detections)
    .where(inArray(detections.imageId, imageIds));

  if (jobDets.length === 0) return emptyStats;

  const detectionIds = jobDets.map((d) => d.id);
  const idents = await db
    .select({ verificationStatus: identifications.verificationStatus })
    .from(identifications)
    .where(inArray(identifications.detectionId, detectionIds));

  const stats: VerificationStats = {
    total: idents.length,
    verified: 0,
    rejected: 0,
    corrected: 0,
    unverified: 0,
  };

  for (const i of idents) {
    if (i.verificationStatus === "verified") stats.verified++;
    else if (i.verificationStatus === "rejected") stats.rejected++;
    else if (i.verificationStatus === "corrected") stats.corrected++;
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
    .select({ id: images.id })
    .from(images)
    .where(inArray(images.jobId, jobIds));

  if (jobImages.length === 0) return emptyStats;

  const imageIds = jobImages.map((img) => img.id);
  const jobDets = await db
    .select({ id: detections.id })
    .from(detections)
    .where(inArray(detections.imageId, imageIds));

  if (jobDets.length === 0) return emptyStats;

  const detectionIds = jobDets.map((d) => d.id);
  const idents = await db
    .select({ verificationStatus: identifications.verificationStatus })
    .from(identifications)
    .where(inArray(identifications.detectionId, detectionIds));

  const stats: VerificationStats = {
    total: idents.length,
    verified: 0,
    rejected: 0,
    corrected: 0,
    unverified: 0,
  };

  for (const i of idents) {
    if (i.verificationStatus === "verified") stats.verified++;
    else if (i.verificationStatus === "rejected") stats.rejected++;
    else if (i.verificationStatus === "corrected") stats.corrected++;
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

export async function getRecentSpecies(
  deploymentId: number,
  limit = 8
): Promise<ActionResult<Species[]>> {
  await requirePermission("camera-trap", "viewer");

  const recent = await db
    .selectDistinct({ scientificName: identifications.correctedSpecies })
    .from(identifications)
    .innerJoin(detections, eq(detections.id, identifications.detectionId))
    .innerJoin(images, eq(images.id, detections.imageId))
    .where(
      and(
        eq(images.deploymentId, deploymentId),
        isNotNull(identifications.correctedSpecies)
      )
    )
    .orderBy(desc(identifications.verifiedAt))
    .limit(limit);

  const recentNames = recent.map((r) => r.scientificName).filter(Boolean) as string[];
  if (recentNames.length === 0) return { success: true, data: [] };

  const speciesList = await db
    .select()
    .from(species)
    .where(inArray(species.scientificName, recentNames));

  return { success: true, data: speciesList };
}

export async function deleteDetection(
  detectionId: number
): Promise<ActionResult> {
  const user = await requirePermission("camera-trap", "editor");

  try {
    const depId = await getDeploymentIdForDetection(detectionId);
    if (depId) await requireDeploymentAccess(user, depId);

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
    if (depId) await requireDeploymentAccess(user, depId);

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

    if (ident.verificationStatus === "rejected") {
      return { success: false, error: "No se puede asignar especie a una detección rechazada" };
    }

    // If species matches original ML prediction → verify; otherwise → correct
    const isMatch = newSpecies === ident.species;

    await db
      .update(identifications)
      .set({
        verificationStatus: isMatch ? "verified" : "corrected",
        correctedSpecies: isMatch ? null : newSpecies,
        verifiedBy: user.email,
        verifiedAt: new Date(),
      })
      .where(
        and(
          eq(identifications.id, identificationId),
          inArray(identifications.verificationStatus, [
            "unverified",
            "verified",
            "corrected",
          ])
        )
      );

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
  currentImageId: number
): Promise<ActionResult<{ nextImageId: number | null }>> {
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

    // Get next unverified image — FORWARD first
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

    const nextId =
      wrapped[0]?.id === currentImageId ? null : (wrapped[0]?.id ?? null);

    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: { nextImageId: nextId } };
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

    await db.transaction(async (tx) => {
      await tx
        .update(images)
        .set({ confirmedBlank: newValue })
        .where(eq(images.id, imageId));

      // When toggling ON, batch-reject all identifications
      if (newValue) {
        const imageDetections = await tx
          .select({ id: detections.id })
          .from(detections)
          .where(eq(detections.imageId, imageId));

        if (imageDetections.length > 0) {
          const detectionIds = imageDetections.map((d) => d.id);
          const result = await tx
            .update(identifications)
            .set({ verificationStatus: "rejected" })
            .where(
              and(
                inArray(identifications.detectionId, detectionIds),
                ne(identifications.verificationStatus, "rejected")
              )
            );
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

export async function getStarredImages() {
  const user = await requirePermission("camera-trap", "viewer");
  const ctProjects = await getUserCameraTrapProjects(user);

  return db
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
}

