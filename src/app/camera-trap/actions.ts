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
import { eq, desc, inArray, and, gte, sql } from "drizzle-orm";
import { runMLPredictions, checkPytorchWildlife } from "@/lib/ml-runner";
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
 * Process a job. No mock fallback — ML works via ML_PYTHON_PATH or fails.
 *
 * For Drive-based deployments: downloads images to temp dir first,
 * writes temp paths to images.path, runs ML, then cleans up.
 */
export async function processJob(
  jobId: number
): Promise<ActionResult<{ job: ProcessingJob }>> {
  await requirePermission("camera-trap", "editor");

  let tempDir: string | undefined;

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
      .set({ status: "processing", startedAt: new Date() })
      .where(eq(processingJobs.id, jobId));

    // Check if this is a Drive-based deployment
    const [deployment] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, job.deploymentId));

    if (!deployment) {
      return { success: false, error: "Instalación no encontrada" };
    }

    // For Drive deployments: download images to temp dir first
    if (deployment.driveFolderId) {
      const downloadResult = await downloadDeploymentForProcessing(
        deployment.id,
        jobId
      );
      tempDir = downloadResult.tempDir;

      if (downloadResult.downloaded === 0) {
        await cleanupJobTempDir(jobId, tempDir);
        await db
          .update(processingJobs)
          .set({
            status: "failed",
            errorMessage: "No se pudieron descargar imágenes de Drive",
            completedAt: new Date(),
          })
          .where(eq(processingJobs.id, jobId));

        await db
          .update(deployments)
          .set({ status: "scanned", updatedAt: new Date() })
          .where(eq(deployments.id, job.deploymentId));

        revalidatePath(CAMERA_TRAP_PATH);
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
    const mlCheck = await checkPytorchWildlife();

    if (!mlCheck.available) {
      if (tempDir) await cleanupJobTempDir(jobId, tempDir);

      await db
        .update(processingJobs)
        .set({
          status: "failed",
          errorMessage: mlCheck.message,
          completedAt: new Date(),
        })
        .where(eq(processingJobs.id, jobId));

      await db
        .update(deployments)
        .set({ status: "scanned", updatedAt: new Date() })
        .where(eq(deployments.id, job.deploymentId));

      revalidatePath(CAMERA_TRAP_PATH);

      return { success: false, error: mlCheck.message };
    }

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

    // Clean up temp directory after ML completes
    if (tempDir) await cleanupJobTempDir(jobId, tempDir);

    const finalStatus = mlResult.success ? "completed" : "failed";

    await db
      .update(processingJobs)
      .set({
        status: finalStatus,
        completedAt: new Date(),
        errorMessage: mlResult.error || null,
      })
      .where(eq(processingJobs.id, jobId));

    await db
      .update(deployments)
      .set({
        status: finalStatus === "completed" ? "processed" : "scanned",
        updatedAt: new Date(),
      })
      .where(eq(deployments.id, job.deploymentId));

    revalidatePath(CAMERA_TRAP_PATH);

    const [updatedJob] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId));

    return mlResult.success
      ? { success: true, data: { job: updatedJob } }
      : { success: false, error: mlResult.error || "Procesamiento falló" };
  } catch (error) {
    // Clean up temp directory on error
    if (tempDir) {
      try {
        await cleanupJobTempDir(jobId, tempDir);
      } catch {
        // Best effort cleanup
      }
    }

    await db
      .update(processingJobs)
      .set({ status: "failed" })
      .where(eq(processingJobs.id, jobId));

    return {
      success: false,
      error: error instanceof Error ? error.message : "Procesamiento falló",
    };
  }
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

    // Actually kill the subprocess if PID is stored
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
      .set({ status: "cancelled", completedAt: new Date() })
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
// Query Functions
// ---------------------------------------------------------------------------

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

export async function getRecentJobs(limit: number = 10) {
  await requirePermission("camera-trap", "viewer");

  const jobs = await db
    .select()
    .from(processingJobs)
    .orderBy(desc(processingJobs.createdAt))
    .limit(limit);

  if (jobs.length === 0) return [];

  const deploymentIds = [...new Set(jobs.map((j) => j.deploymentId))];
  const deploymentRows = await db
    .select()
    .from(deployments)
    .where(inArray(deployments.id, deploymentIds));

  const deploymentMap = new Map(deploymentRows.map((d) => [d.id, d]));

  return jobs.map((job) => ({
    ...job,
    deployment: deploymentMap.get(job.deploymentId),
  }));
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

