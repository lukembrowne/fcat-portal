"use server";

import { db } from "@/db";
import {
  deployments,
  processingJobs,
  images,
  detections,
  identifications,
  species,
} from "@/db/schema";
import { eq, desc, inArray, and, gte, ne, sql, count, countDistinct, sum } from "drizzle-orm";
import { runMLPredictions, checkPytorchWildlife, cancelModelServerJob } from "@/lib/ml-runner";
import {
  downloadDeploymentForProcessing,
  cleanupJobTempDir,
} from "@/lib/drive-downloader";
import { requirePermission } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import type { ActionResult, VerificationStats } from "@/lib/types";
import type { Deployment, ProcessingJob } from "@/db/schema";
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

    const deploymentImages = await db
      .select()
      .from(images)
      .where(eq(images.deploymentId, deploymentId));

    if (deploymentImages.length === 0) {
      return {
        success: false,
        error: "No hay imágenes para procesar. Escanee o vuelva a escanear la carpeta.",
      };
    }

    const [job] = await db
      .insert(processingJobs)
      .values({
        deploymentId,
        detectorModel: modelConfig?.detectorModel || ML_DEFAULTS.detectorModel,
        classifierModel: modelConfig?.classifierModel || ML_DEFAULTS.classifierModel,
        confidenceThreshold: modelConfig?.confidenceThreshold ?? ML_DEFAULTS.confidenceThreshold,
        status: "pending",
        totalImages: deploymentImages.length,
        processedImages: 0,
        failedImages: 0,
        createdBy: user.email,
      })
      .returning();

    // Link images to this job and reset status
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

    // For Drive deployments: download to persistent cache (skips already-cached images)
    if (deployment.driveFolderId) {
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

      // Fail only if nothing was downloaded AND nothing was cached
      if (downloadResult.downloaded === 0 && downloadResult.skipped === 0) {
        await db
          .update(processingJobs)
          .set({
            status: "failed",
            errorMessage: "No se pudieron descargar imágenes de Drive",
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
          error: "No se pudieron descargar imágenes de Drive",
        };
      }
    }

    // Re-fetch job images (paths may have been updated by download)
    const jobImages = await db
      .select()
      .from(images)
      .where(eq(images.jobId, jobId));

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
      batchSize: 16,
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
  await requirePermission("camera-trap", "editor");
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
  await requirePermission("camera-trap", "editor");

  try {
    const [job] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId));

    if (!job) {
      return { success: false, error: "Trabajo no encontrado" };
    }

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
  await requirePermission("camera-trap", "editor");

  try {
    const [job] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId));

    if (!job) {
      return { success: false, error: "Trabajo no encontrado" };
    }

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

    // 1. Reset images that belonged to this job (before cascade nulls jobId)
    await db
      .update(images)
      .set({ status: "pending", jobId: null })
      .where(eq(images.jobId, jobId));

    // 2. Delete the job (cascades: detections → identifications)
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
  await requirePermission("camera-trap", "viewer");

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
  await requirePermission("camera-trap", "viewer");

  if (jobIds.length === 0) return { totalDetections: 0, totalVerified: 0 };

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
  await requirePermission("camera-trap", "editor");

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

      // Delete job (cascades: detections → identifications)
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
  siteName: string | null;
  latitude: number | null;
  longitude: number | null;
  dateStart: string | null;
  dateEnd: string | null;
  totalImages: number | null;
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
  await requirePermission("camera-trap", "viewer");

  const allDeployments = await db
    .select()
    .from(deployments)
    .where(eq(deployments.projectId, "camera-trap"))
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
      .select({ jobId: detections.jobId, cnt: count() })
      .from(detections)
      .where(inArray(detections.jobId, completedJobIds))
      .groupBy(detections.jobId);
    for (const r of detectionCounts) {
      detCountMap.set(r.jobId, r.cnt);
    }

    const speciesCounts = await db
      .select({
        jobId: detections.jobId,
        cnt: countDistinct(identifications.species),
      })
      .from(identifications)
      .innerJoin(detections, eq(identifications.detectionId, detections.id))
      .where(inArray(detections.jobId, completedJobIds))
      .groupBy(detections.jobId);
    for (const r of speciesCounts) {
      specCountMap.set(r.jobId, r.cnt);
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
      siteName: d.siteName,
      latitude: d.latitude,
      longitude: d.longitude,
      dateStart: d.dateStart,
      dateEnd: d.dateEnd,
      totalImages: d.totalImages,
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
  await requirePermission("camera-trap", "viewer");
  return db
    .select()
    .from(deployments)
    .where(eq(deployments.projectId, "camera-trap"))
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
    siteName?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    dateStart?: string | null;
    dateEnd?: string | null;
  }
): Promise<ActionResult> {
  await requirePermission("camera-trap", "editor");

  try {
    const [existing] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, id));

    if (!existing) {
      return { success: false, error: "Instalación no encontrada" };
    }

    await db
      .update(deployments)
      .set({
        ...fields,
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
    siteName?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    dateStart?: string | null;
    dateEnd?: string | null;
  }
): Promise<ActionResult<{ count: number }>> {
  await requirePermission("camera-trap", "editor");

  try {
    if (ids.length === 0) {
      return { success: true, data: { count: 0 } };
    }

    // Only include non-undefined fields (undefined = "do not change")
    const updates: Record<string, unknown> = { updatedAt: new Date(), metadataSource: "manual" };
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
  await requirePermission("camera-trap", "editor");

  try {
    if (ids.length === 0) {
      return { success: true, data: { count: 0 } };
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

    // Cascade delete: deployments → images, jobs → detections → identifications
    await db
      .delete(deployments)
      .where(inArray(deployments.id, ids));

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
  await requirePermission("camera-trap", "viewer");

  if (ids.length === 0) return { totalImages: 0, totalDetections: 0, totalVerified: 0 };

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
// Processing Queue
// ---------------------------------------------------------------------------

export async function queueProcessing(
  deploymentIds: number[]
): Promise<ActionResult<{ jobIds: number[] }>> {
  await requirePermission("camera-trap", "editor");

  try {
    if (deploymentIds.length === 0) {
      return { success: true, data: { jobIds: [] } };
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

/** Get distinct project label values for filter dropdown. */
export async function getDistinctProjects(): Promise<string[]> {
  await requirePermission("camera-trap", "viewer");
  const rows = await db
    .select({ projectLabel: deployments.projectLabel })
    .from(deployments)
    .where(eq(deployments.projectId, "camera-trap"))
    .groupBy(deployments.projectLabel);
  return rows
    .map((r) => r.projectLabel)
    .filter((p): p is string => p !== null)
    .sort();
}

export async function getDeployment(id: number) {
  await requirePermission("camera-trap", "viewer");

  const [deployment] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, id));

  if (!deployment) return null;

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
  await requirePermission("camera-trap", "viewer");

  const jobs = await db
    .select()
    .from(processingJobs)
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

  // Batch: detection counts per job
  const detectionCounts = await db
    .select({ jobId: detections.jobId, cnt: count() })
    .from(detections)
    .where(inArray(detections.jobId, jobIds))
    .groupBy(detections.jobId);
  const detCountMap = new Map(detectionCounts.map((r) => [r.jobId, r.cnt]));

  // Batch: distinct species counts per job
  const speciesCounts = await db
    .select({
      jobId: detections.jobId,
      cnt: countDistinct(identifications.species),
    })
    .from(identifications)
    .innerJoin(detections, eq(identifications.detectionId, detections.id))
    .where(inArray(detections.jobId, jobIds))
    .groupBy(detections.jobId);
  const specCountMap = new Map(speciesCounts.map((r) => [r.jobId, r.cnt]));

  // Batch: verified/corrected/rejected identification counts per job
  const verifiedCounts = await db
    .select({ jobId: detections.jobId, cnt: count() })
    .from(identifications)
    .innerJoin(detections, eq(identifications.detectionId, detections.id))
    .where(
      and(
        inArray(detections.jobId, jobIds),
        ne(identifications.verificationStatus, "unverified")
      )
    )
    .groupBy(detections.jobId);
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
  await requirePermission("camera-trap", "viewer");

  const [jobStats] = await db
    .select({
      totalJobs: count(),
      totalProcessed: sum(processingJobs.processedImages),
    })
    .from(processingJobs);

  const [detStats] = await db
    .select({ totalDetections: count() })
    .from(detections);

  const [specStats] = await db
    .select({ totalSpecies: countDistinct(identifications.species) })
    .from(identifications);

  return {
    totalJobs: jobStats?.totalJobs || 0,
    totalImagesProcessed: Number(jobStats?.totalProcessed) || 0,
    totalDetections: detStats?.totalDetections || 0,
    uniqueSpecies: specStats?.totalSpecies || 0,
  };
}

export async function getJobWithDetails(jobId: number) {
  await requirePermission("camera-trap", "viewer");

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
    .where(eq(images.jobId, jobId));

  return { job, deployment, images: jobImages };
}

export async function getImageWithDetections(imageId: number) {
  await requirePermission("camera-trap", "viewer");

  const [image] = await db
    .select()
    .from(images)
    .where(eq(images.id, imageId));

  if (!image) return null;

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
    detections: imageDetections.map((det) => ({
      ...det,
      identification: identByDetection.get(det.id) || null,
    })),
  };
}

export async function getJobImageIds(jobId: number): Promise<number[]> {
  await requirePermission("camera-trap", "viewer");

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
    await db
      .update(identifications)
      .set({
        verificationStatus: "verified",
        verifiedBy: user.email,
        verifiedAt: new Date(),
      })
      .where(eq(identifications.id, identificationId));

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
    await db
      .update(identifications)
      .set({
        verificationStatus: "rejected",
        verifiedBy: user.email,
        verifiedAt: new Date(),
      })
      .where(eq(identifications.id, identificationId));

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
    await db
      .update(identifications)
      .set({
        verificationStatus: "corrected",
        correctedSpecies: newSpecies,
        verifiedBy: user.email,
        verifiedAt: new Date(),
      })
      .where(eq(identifications.id, identificationId));

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

    await db
      .update(identifications)
      .set({
        verificationStatus: "verified",
        verifiedBy: user.email,
        verifiedAt: new Date(),
      })
      .where(inArray(identifications.id, identificationIds));

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
    const jobDetections = await db
      .select({ id: detections.id })
      .from(detections)
      .where(eq(detections.jobId, jobId));

    if (jobDetections.length === 0) {
      return { success: true, data: { count: 0 } };
    }

    const detectionIds = jobDetections.map((d) => d.id);

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
  await requirePermission("camera-trap", "viewer");

  const jobDetections = await db
    .select({ id: detections.id })
    .from(detections)
    .where(eq(detections.jobId, jobId));

  if (jobDetections.length === 0) return [];

  const detectionIds = jobDetections.map((d) => d.id);
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
  await requirePermission("camera-trap", "viewer");

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
  await requirePermission("camera-trap", "viewer");

  const jobDetections = await db
    .select({ id: detections.id })
    .from(detections)
    .where(eq(detections.jobId, jobId));

  if (jobDetections.length === 0) {
    return { total: 0, verified: 0, rejected: 0, corrected: 0, unverified: 0 };
  }

  const detectionIds = jobDetections.map((d) => d.id);
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
  await requirePermission("camera-trap", "viewer");

  const deploymentJobs = await db
    .select({ id: processingJobs.id })
    .from(processingJobs)
    .where(eq(processingJobs.deploymentId, deploymentId));

  if (deploymentJobs.length === 0) {
    return { total: 0, verified: 0, rejected: 0, corrected: 0, unverified: 0 };
  }

  const jobIds = deploymentJobs.map((j) => j.id);
  const jobDetections = await db
    .select({ id: detections.id })
    .from(detections)
    .where(inArray(detections.jobId, jobIds));

  if (jobDetections.length === 0) {
    return { total: 0, verified: 0, rejected: 0, corrected: 0, unverified: 0 };
  }

  const detectionIds = jobDetections.map((d) => d.id);
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

