"use server";

import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import {
  deployments,
  audioFiles,
  audioDetections,
  audioIdentifications,
  acousticIndices,
  cameraTrapProjects,
  processingJobs,
} from "@/db/schema";
import { eq, sql, and, isNotNull, inArray, count as drizzleCount } from "drizzle-orm";
import {
  getUserCameraTrapProjects,
  ctProjectFilter,
  requireDeploymentAccess,
} from "@/lib/camera-trap-auth";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/types";
import os from "os";
import path from "path";
import { promises as fs } from "fs";
import { log } from "@/lib/log";
import { ensureAudioCached, releaseFiles } from "@/lib/audio-cache";
import { runBirdNETAnalysis } from "@/lib/birdnet-runner";
import {
  runAcousticIndicesAnalysis,
  type AcousticIndicesResult,
} from "@/lib/acoustic-indices-runner";
import { scanDeploymentAudioInternal } from "@/lib/audio-sync-internals";
import { JOB_TYPES } from "@/lib/job-types";
import { fetchEntities } from "@/lib/odk-client";
import {
  BIOCHOCO_PROJECT_ID,
  BIOCHOCO_DATASET_SITES,
} from "@/lib/odk-constants";
import type { OdkSiteEntity } from "@/lib/odk-types";
import { HABITAT_COLORS } from "@/app/biochoco/habitat/types";
import { getHabitatName } from "@/app/biochoco/overview/types";
import { DIEL_PERIODS, type DielPeriod } from "@/lib/acoustic-indices";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AudioDeploymentRow {
  id: number;
  name: string;
  siteName: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  ctProjectName: string | null;
  latitude: number | null;
  longitude: number | null;
  uploadAudioCount: number | null;
  uploadAudioFolderId: string | null;
  audioFileCount: number;
  lastScanned: Date | null;
  totalDetections: number;
  totalSpecies: number;
  verifiedCount: number;
  unverifiedCount: number;
  lastBirdnetAt: Date | null;
  isBirdnetProcessing: boolean;
  excluded: boolean;
  displayStatus: string;
}

export interface AudioProject {
  id: number;
  name: string;
}

export interface AudioFileRow {
  id: number;
  filename: string;
  driveFileId: string | null;
  fileSize: number | null;
  mimeType: string | null;
  modifiedAt: Date | null;
  format: string | null;
  playable: boolean;
  detectionCount: number;
}

export interface AudioStats {
  totalDeployments: number;
  totalFiles: number;
  totalSizeBytes: number;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function fetchAudioDeployments(): Promise<
  ActionResult<AudioDeploymentRow[]>
> {
  const user = await requirePermission("grabaciones", "viewer");
  const projects = await getUserCameraTrapProjects(user);
  const filter = ctProjectFilter(projects);

  const rows = await db
    .select({
      id: deployments.id,
      name: deployments.name,
      siteName: deployments.siteName,
      dateStart: deployments.dateStart,
      dateEnd: deployments.dateEnd,
      ctProjectName: cameraTrapProjects.name,
      latitude: deployments.latitude,
      longitude: deployments.longitude,
      uploadAudioCount: deployments.uploadAudioCount,
      uploadAudioFolderId: deployments.uploadAudioFolderId,
      excluded: deployments.excluded,
      audioFileCount: sql<number>`(
        SELECT COUNT(*) FROM audio_files
        WHERE audio_files.deployment_id = ${deployments.id}
      )`,
      lastScanned: sql<Date | null>`(
        SELECT MAX(created_at) FROM audio_files
        WHERE audio_files.deployment_id = ${deployments.id}
      )`,
      totalDetections: sql<number>`(
        SELECT COUNT(*) FROM audio_detections
        INNER JOIN audio_files ON audio_files.id = audio_detections.audio_file_id
        WHERE audio_files.deployment_id = ${deployments.id}
      )`,
      totalSpecies: sql<number>`(
        SELECT COUNT(DISTINCT audio_identifications.species) FROM audio_identifications
        INNER JOIN audio_detections ON audio_detections.id = audio_identifications.audio_detection_id
        INNER JOIN audio_files ON audio_files.id = audio_detections.audio_file_id
        WHERE audio_files.deployment_id = ${deployments.id}
      )`,
      verifiedCount: sql<number>`(
        SELECT COUNT(*) FROM audio_identifications
        INNER JOIN audio_detections ON audio_detections.id = audio_identifications.audio_detection_id
        INNER JOIN audio_files ON audio_files.id = audio_detections.audio_file_id
        WHERE audio_files.deployment_id = ${deployments.id}
        AND audio_identifications.verification_status = 'verified'
      )`,
      unverifiedCount: sql<number>`(
        SELECT COUNT(*) FROM audio_identifications
        INNER JOIN audio_detections ON audio_detections.id = audio_identifications.audio_detection_id
        INNER JOIN audio_files ON audio_files.id = audio_detections.audio_file_id
        WHERE audio_files.deployment_id = ${deployments.id}
        AND audio_identifications.verification_status = 'unverified'
      )`,
      lastBirdnetAt: sql<Date | null>`(
        SELECT MAX(completed_at) FROM biochoco_processing_jobs
        WHERE deployment_id = ${deployments.id}
        AND job_type IN ('birdnet', 'audio_analysis') AND status = 'completed'
      )`,
      isBirdnetProcessing: sql<number>`(
        SELECT COUNT(*) FROM biochoco_processing_jobs
        WHERE deployment_id = ${deployments.id}
        AND job_type IN ('birdnet', 'acoustic_indices', 'audio_analysis')
        AND status IN ('pending', 'processing')
      )`,
    })
    .from(deployments)
    .leftJoin(
      cameraTrapProjects,
      eq(deployments.cameraTrapProjectId, cameraTrapProjects.id)
    )
    .where(
      and(
        filter,
        isNotNull(deployments.uploadAudioFolderId)
      )
    )
    .orderBy(deployments.name);

  // Compute displayStatus for each row
  const enriched: AudioDeploymentRow[] = rows.map((row) => {
    let displayStatus: string;
    if (row.audioFileCount === 0) {
      displayStatus = "unscanned";
    } else if (row.isBirdnetProcessing > 0) {
      displayStatus = "birdnet_processing";
    } else if (row.totalDetections > 0) {
      displayStatus = row.unverifiedCount === 0 && row.verifiedCount > 0 ? "reviewed" : "analyzed";
    } else {
      displayStatus = "scanned";
    }

    return {
      ...row,
      isBirdnetProcessing: row.isBirdnetProcessing > 0,
      displayStatus,
    };
  });

  return { success: true, data: enriched };
}

export async function fetchDistinctAudioProjects(): Promise<AudioProject[]> {
  await requirePermission("grabaciones", "viewer");

  const rows = await db
    .selectDistinct({
      id: cameraTrapProjects.id,
      name: cameraTrapProjects.name,
    })
    .from(deployments)
    .innerJoin(
      cameraTrapProjects,
      eq(deployments.cameraTrapProjectId, cameraTrapProjects.id)
    )
    .where(isNotNull(deployments.uploadAudioFolderId))
    .orderBy(cameraTrapProjects.name);

  return rows;
}

export async function fetchAudioFiles(
  deploymentId: number
): Promise<ActionResult<AudioFileRow[]>> {
  const user = await requirePermission("grabaciones", "viewer");
  await requireDeploymentAccess(user, deploymentId);

  const rows = await db
    .select({
      id: audioFiles.id,
      filename: audioFiles.filename,
      driveFileId: audioFiles.driveFileId,
      fileSize: audioFiles.fileSize,
      mimeType: audioFiles.mimeType,
      modifiedAt: audioFiles.modifiedAt,
      format: audioFiles.format,
      playable: audioFiles.playable,
      detectionCount: sql<number>`(SELECT COUNT(*) FROM audio_detections WHERE audio_file_id = ${audioFiles.id})`,
    })
    .from(audioFiles)
    .where(eq(audioFiles.deploymentId, deploymentId))
    .orderBy(audioFiles.filename);

  return { success: true, data: rows };
}

export async function getAudioStats(): Promise<ActionResult<AudioStats>> {
  await requirePermission("grabaciones", "viewer");

  const [stats] = await db
    .select({
      totalFiles: drizzleCount(),
      totalSizeBytes: sql<number>`COALESCE(SUM(${audioFiles.fileSize}), 0)`,
    })
    .from(audioFiles);

  const [depCount] = await db
    .select({
      totalDeployments: sql<number>`COUNT(DISTINCT ${audioFiles.deploymentId})`,
    })
    .from(audioFiles);

  return {
    success: true,
    data: {
      totalDeployments: depCount?.totalDeployments ?? 0,
      totalFiles: stats?.totalFiles ?? 0,
      totalSizeBytes: stats?.totalSizeBytes ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Scan actions
// ---------------------------------------------------------------------------

export async function scanDeploymentAudio(
  deploymentId: number
): Promise<ActionResult<{ added: number; updated: number; total: number }>> {
  const user = await requirePermission("grabaciones", "editor");
  await requireDeploymentAccess(user, deploymentId);

  const [dep] = await db
    .select({
      uploadAudioFolderId: deployments.uploadAudioFolderId,
    })
    .from(deployments)
    .where(eq(deployments.id, deploymentId));

  if (!dep?.uploadAudioFolderId) {
    return {
      success: false,
      error: "Esta instalación no tiene carpeta de audio en Drive",
    };
  }

  const result = await scanDeploymentAudioInternal({
    id: deploymentId,
    uploadAudioFolderId: dep.uploadAudioFolderId,
  });

  revalidatePath("/audio");
  revalidatePath(`/audio/${deploymentId}`);

  return { success: true, data: result };
}

// ---------------------------------------------------------------------------
// BirdNET Analysis
// ---------------------------------------------------------------------------

export async function createBirdNETJob(
  deploymentId: number
): Promise<ActionResult<{ jobId: number }>> {
  const user = await requirePermission("grabaciones", "editor");
  await requireDeploymentAccess(user, deploymentId);

  // Check for audio files
  const fileCount = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(audioFiles)
    .where(eq(audioFiles.deploymentId, deploymentId));

  const totalFiles = fileCount[0]?.count ?? 0;
  if (totalFiles === 0) {
    return { success: false, error: "No hay archivos de audio en esta instalación" };
  }

  // Concurrency guard — only block on other BirdNET jobs, not camera trap
  const [activeJob] = await db
    .select({ id: processingJobs.id })
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.deploymentId, deploymentId),
        eq(processingJobs.jobType, "birdnet"),
        inArray(processingJobs.status, ["pending", "processing"])
      )
    )
    .limit(1);

  if (activeJob) {
    return { success: false, error: "Ya existe un análisis BirdNET activo para esta instalación" };
  }

  // Clean up prior BirdNET detections (preserve manual annotations)
  await db.run(sql`
    DELETE FROM audio_detections
    WHERE audio_file_id IN (
      SELECT id FROM audio_files WHERE deployment_id = ${deploymentId}
    )
    AND job_id IS NOT NULL
  `);

  // Create job
  const [job] = await db
    .insert(processingJobs)
    .values({
      deploymentId,
      jobType: "birdnet",
      totalImages: totalFiles,
      status: "pending",
      createdBy: user.email,
      statusMessage: "Preparando análisis BirdNET...",
    })
    .returning();

  // Fire-and-forget
  processBirdNETJob(job.id).catch((err) => {
    log.error({ err, jobId: job.id }, "[birdnet] Unhandled error in processBirdNETJob");
  });

  return { success: true, data: { jobId: job.id } };
}

async function processBirdNETJob(jobId: number): Promise<void> {
  try {
    // Set status to processing
    await db
      .update(processingJobs)
      .set({ status: "processing", startedAt: new Date() })
      .where(eq(processingJobs.id, jobId));

    // Look up job + deployment
    const [job] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId));

    if (!job) throw new Error(`Job ${jobId} not found`);
    // `processingJobs.deploymentId` became nullable for drive_sync jobs (main
    // commit 4b6cd23). BirdNET jobs always target a single deployment, so a
    // null here is a programmer error — fail loud rather than coerce.
    if (job.deploymentId === null) {
      throw new Error(`BirdNET job ${jobId} has null deploymentId`);
    }
    const deploymentId = job.deploymentId;

    const [deployment] = await db
      .select({
        id: deployments.id,
        latitude: deployments.latitude,
        longitude: deployments.longitude,
        dateStart: deployments.dateStart,
      })
      .from(deployments)
      .where(eq(deployments.id, deploymentId));

    if (!deployment) throw new Error(`Deployment ${deploymentId} not found`);

    // Lat/lon with fallback
    const lat = deployment.latitude ?? -0.3;
    const lon = deployment.longitude ?? -79.2;
    if (deployment.latitude === null || deployment.longitude === null) {
      log.warn(
        { jobId, deploymentId: deployment.id },
        "[birdnet] Using default lat/lon — deployment has no coordinates"
      );
    }

    // Compute week from deployment dateStart
    let week = -1;
    if (deployment.dateStart) {
      const d = new Date(deployment.dateStart);
      const start = new Date(d.getFullYear(), 0, 1);
      const dayOfYear = Math.ceil((d.getTime() - start.getTime()) / 86400000) + 1;
      week = Math.ceil(dayOfYear / 7);
    }

    // Get audio files for this deployment
    const files = await db
      .select({
        id: audioFiles.id,
        filename: audioFiles.filename,
        driveFileId: audioFiles.driveFileId,
      })
      .from(audioFiles)
      .where(eq(audioFiles.deploymentId, deploymentId));

    const filesWithDrive = files.filter((f) => f.driveFileId !== null);
    const downloadTotal = filesWithDrive.length;

    await db
      .update(processingJobs)
      .set({
        downloadTotal,
        statusMessage: `Descargando audio... (0 de ${downloadTotal})`,
      })
      .where(eq(processingJobs.id, jobId));

    // Phase 1: Download audio from Drive → cache
    let downloadedCount = 0;
    let audioDir: string | null = null;

    for (const file of filesWithDrive) {
      try {
        const cachePath = await ensureAudioCached(file.id);
        if (!audioDir) {
          audioDir = path.dirname(cachePath);
        }
        downloadedCount++;
        await db
          .update(processingJobs)
          .set({
            downloadedImages: downloadedCount,
            statusMessage: `Descargando audio... (${downloadedCount} de ${downloadTotal})`,
          })
          .where(eq(processingJobs.id, jobId));
      } catch (err) {
        log.warn({ err, fileId: file.id }, "[birdnet] Failed to cache audio file, skipping");
      }
    }

    if (!audioDir) {
      throw new Error("No audio files could be downloaded");
    }

    // Build filename → fileId map
    const filenameToFileId = new Map<string, number>();
    for (const file of files) {
      filenameToFileId.set(file.filename, file.id);
      // Also map without extension
      const base = file.filename.replace(/\.[^.]+$/, "");
      filenameToFileId.set(base, file.id);
    }

    // Phase 2: Run BirdNET analysis
    await db
      .update(processingJobs)
      .set({
        processedImages: 0,
        statusMessage: `Iniciando análisis BirdNET...`,
      })
      .where(eq(processingJobs.id, jobId));

    const result = await runBirdNETAnalysis(
      jobId,
      {
        audioDir,
        lat,
        lon,
        week,
        minConf: 0.1,
        threads: Math.max(1, (os.availableParallelism?.() ?? os.cpus().length) - 1),
        totalFiles: downloadTotal,
        sensitivity: 1.0,
        overlap: 1.0,
      },
      filenameToFileId,
    );

    // Phase 3: Finalize
    if (result.success) {
      // Count unique species
      const [speciesCount] = await db
        .select({ count: sql<number>`COUNT(DISTINCT ${audioIdentifications.species})` })
        .from(audioDetections)
        .innerJoin(audioIdentifications, eq(audioIdentifications.audioDetectionId, audioDetections.id))
        .where(eq(audioDetections.jobId, jobId));

      const species = speciesCount?.count ?? 0;

      await db
        .update(processingJobs)
        .set({
          status: "completed",
          completedAt: new Date(),
          processedImages: result.totalProcessed,
          statusMessage: `${result.totalDetections} detecciones, ${species} especies`,
        })
        .where(eq(processingJobs.id, jobId));

      log.info(
        { jobId, detections: result.totalDetections, species, processed: result.totalProcessed },
        "[birdnet] Job completed successfully"
      );
    } else {
      throw new Error(result.error);
    }

    revalidatePath(`/audio/${deploymentId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, jobId }, "[birdnet] Job failed");
    await db
      .update(processingJobs)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorMessage: message,
        statusMessage: "Fallido",
      })
      .where(eq(processingJobs.id, jobId));
  }
}

export async function cancelBirdNETJob(
  jobId: number
): Promise<ActionResult> {
  const user = await requirePermission("grabaciones", "editor");

  const [job] = await db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId));

  if (!job) {
    return { success: false, error: "Trabajo no encontrado" };
  }

  // BirdNET jobs always target a single deployment; null indicates a non-BirdNET
  // job was passed in or data corruption.
  if (job.deploymentId === null) {
    return { success: false, error: "Trabajo sin instalación asociada" };
  }
  const deploymentId = job.deploymentId;

  await requireDeploymentAccess(user, deploymentId);

  if (!["pending", "processing"].includes(job.status)) {
    return { success: false, error: "El trabajo ya finalizó" };
  }

  // Kill the subprocess
  if (job.pid) {
    try {
      process.kill(job.pid, "SIGTERM");
    } catch {
      // Process may have already exited
    }
  }

  // Delete partial detections from this job
  await db.delete(audioDetections).where(eq(audioDetections.jobId, jobId));

  await db
    .update(processingJobs)
    .set({
      status: "cancelled",
      completedAt: new Date(),
      statusMessage: null,
    })
    .where(eq(processingJobs.id, jobId));

  revalidatePath(`/audio/${deploymentId}`);
  return { success: true, data: undefined };
}

/** Unified cancel for floating-job-progress — routes to correct handler */
export async function cancelProcessingJob(
  jobId: number
): Promise<ActionResult> {
  const [job] = await db
    .select({ jobType: processingJobs.jobType })
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId));

  if (!job) {
    return { success: false, error: "Trabajo no encontrado" };
  }

  if (job.jobType === JOB_TYPES.BIRDNET) {
    return cancelBirdNETJob(jobId);
  }

  if (job.jobType === JOB_TYPES.ACOUSTIC_INDICES) {
    return cancelAcousticIndicesJob(jobId);
  }

  if (job.jobType === JOB_TYPES.AUDIO_ANALYSIS) {
    return cancelAudioAnalysisJob(jobId);
  }

  // For camera trap jobs, delegate to camera-trap cancel
  const { cancelJob } = await import("@/app/camera-trap/actions");
  return cancelJob(jobId);
}

// ---------------------------------------------------------------------------
// Acoustic Indices
// ---------------------------------------------------------------------------

interface CreateAcousticIndicesJobInput {
  deploymentId?: number;
  cameraTrapProjectId?: number;
  /** Bypass the single-flight guard. Used internally for batch flows. */
  force?: boolean;
}

/**
 * Enqueue an acoustic-indices computation. Scope is determined by which of
 * `deploymentId` / `cameraTrapProjectId` is set:
 *
 *   - `deploymentId`: editor on `grabaciones` + deployment access.
 *   - `cameraTrapProjectId`: admin on `grabaciones` (project-wide scan).
 *   - neither: error.
 *
 * Single-flight is enforced at the DB level — concurrent jobs for the same
 * scope are refused unless `force: true`.
 */
export async function createAcousticIndicesJob(
  input: CreateAcousticIndicesJobInput
): Promise<ActionResult<{ jobId: number }>> {
  const { deploymentId, cameraTrapProjectId, force } = input;

  if (deploymentId == null && cameraTrapProjectId == null) {
    return {
      success: false,
      error: "Especifica una instalación o un proyecto",
    };
  }

  // Scope-specific auth: admin gates project-wide, editor gates per-deployment.
  const user = cameraTrapProjectId != null
    ? await requirePermission("grabaciones", "admin")
    : await requirePermission("grabaciones", "editor");
  if (deploymentId != null) {
    await requireDeploymentAccess(user, deploymentId);
  }

  // Count target files. Project-wide skips deployments without audio.
  let totalFiles = 0;
  if (deploymentId != null) {
    const [row] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(audioFiles)
      .where(eq(audioFiles.deploymentId, deploymentId));
    totalFiles = row?.count ?? 0;
  } else if (cameraTrapProjectId != null) {
    const [row] = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(audioFiles)
      .innerJoin(deployments, eq(audioFiles.deploymentId, deployments.id))
      .where(eq(deployments.cameraTrapProjectId, cameraTrapProjectId));
    totalFiles = row?.count ?? 0;
  }

  if (totalFiles === 0) {
    return {
      success: false,
      error: "No hay archivos de audio en este alcance",
    };
  }

  // DB single-flight: refuse if a pending/processing job already exists for
  // this exact scope. The plan rejects the in-process Map — the row is the
  // authority across processes, restarts, and deploys.
  if (!force) {
    const scopeFilter = deploymentId != null
      ? eq(processingJobs.deploymentId, deploymentId)
      : eq(processingJobs.cameraTrapProjectId, cameraTrapProjectId!);
    const [activeJob] = await db
      .select({ id: processingJobs.id })
      .from(processingJobs)
      .where(
        and(
          scopeFilter,
          eq(processingJobs.jobType, JOB_TYPES.ACOUSTIC_INDICES),
          inArray(processingJobs.status, ["pending", "processing"])
        )
      )
      .limit(1);
    if (activeJob) {
      return {
        success: false,
        error: "Ya existe un cálculo de índices acústicos activo para este alcance",
      };
    }
  }

  const [job] = await db
    .insert(processingJobs)
    .values({
      deploymentId: deploymentId ?? null,
      cameraTrapProjectId: cameraTrapProjectId ?? null,
      jobType: JOB_TYPES.ACOUSTIC_INDICES,
      totalImages: totalFiles,
      status: "pending",
      createdBy: user.email,
      statusMessage: "Preparando cálculo de índices acústicos...",
    })
    .returning();

  processAcousticIndicesJob(job.id).catch((err) => {
    log.error(
      { err, jobId: job.id },
      "[acoustic-indices] Unhandled error in processAcousticIndicesJob"
    );
  });

  return { success: true, data: { jobId: job.id } };
}

async function processAcousticIndicesJob(jobId: number): Promise<void> {
  try {
    await db
      .update(processingJobs)
      .set({ status: "processing", startedAt: new Date() })
      .where(eq(processingJobs.id, jobId));

    const [job] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId));
    if (!job) throw new Error(`Job ${jobId} not found`);

    // Resolve the file set for this scope (deployment or project).
    const fileRows = job.deploymentId != null
      ? await db
          .select({
            id: audioFiles.id,
            filename: audioFiles.filename,
            driveFileId: audioFiles.driveFileId,
          })
          .from(audioFiles)
          .where(eq(audioFiles.deploymentId, job.deploymentId))
      : job.cameraTrapProjectId != null
        ? await db
            .select({
              id: audioFiles.id,
              filename: audioFiles.filename,
              driveFileId: audioFiles.driveFileId,
            })
            .from(audioFiles)
            .innerJoin(
              deployments,
              eq(audioFiles.deploymentId, deployments.id)
            )
            .where(
              eq(deployments.cameraTrapProjectId, job.cameraTrapProjectId)
            )
        : [];

    const filesWithDrive = fileRows.filter((f) => f.driveFileId !== null);
    const downloadTotal = filesWithDrive.length;

    await db
      .update(processingJobs)
      .set({
        downloadTotal,
        statusMessage: `Descargando audio... (0 de ${downloadTotal})`,
      })
      .where(eq(processingJobs.id, jobId));

    // Phase 1: Cache audio locally. Same shape as BirdNET worker; skip per
    // file on failure rather than aborting the run.
    let downloadedCount = 0;
    const cachedFiles: Array<{ id: number; path: string; filename: string }> = [];

    for (const file of filesWithDrive) {
      try {
        const cachePath = await ensureAudioCached(file.id);
        cachedFiles.push({
          id: file.id,
          path: cachePath,
          filename: file.filename,
        });
        downloadedCount++;
        await db
          .update(processingJobs)
          .set({
            downloadedImages: downloadedCount,
            statusMessage: `Descargando audio... (${downloadedCount} de ${downloadTotal})`,
          })
          .where(eq(processingJobs.id, jobId));
      } catch (err) {
        log.warn(
          { err, fileId: file.id },
          "[acoustic-indices] Failed to cache audio file, skipping"
        );
      }
    }

    if (cachedFiles.length === 0) {
      throw new Error("No audio files could be cached for indices computation");
    }

    await db
      .update(processingJobs)
      .set({
        processedImages: 0,
        statusMessage: "Iniciando cálculo de índices acústicos...",
      })
      .where(eq(processingJobs.id, jobId));

    // Phase 2: spawn the Python runner. Sequential per-file UPSERT keeps the
    // BUSY pressure low and dodges the "async transaction" trap documented at
    // docs/solutions/runtime-errors/async-transaction-better-sqlite3-CameraTrap-20260223.md
    const result = await runAcousticIndicesAnalysis({
      jobId,
      files: cachedFiles,
      onResult: async (r: AcousticIndicesResult) => {
        const now = new Date();
        await db
          .insert(acousticIndices)
          .values({
            audioFileId: r.audioFileId,
            soundscapeSaturation: r.soundscapeSaturation,
            acousticComplexityIndex: r.acousticComplexityIndex,
            frequencyEntropy: r.frequencyEntropy,
            temporalEntropy: r.temporalEntropy,
            eventsPerSecond: r.eventsPerSecond,
            recordedDate: r.recordedDate,
            dielPeriod: r.dielPeriod,
            configHash: r.configHash,
            computedAt: now,
          })
          .onConflictDoUpdate({
            target: acousticIndices.audioFileId,
            set: {
              soundscapeSaturation: sql`excluded.soundscape_saturation`,
              acousticComplexityIndex: sql`excluded.acoustic_complexity_index`,
              frequencyEntropy: sql`excluded.frequency_entropy`,
              temporalEntropy: sql`excluded.temporal_entropy`,
              eventsPerSecond: sql`excluded.events_per_second`,
              // COALESCE so a re-run with an unparseable filename doesn't
              // clobber a previously valid recorded_date.
              recordedDate: sql`COALESCE(excluded.recorded_date, ${acousticIndices.recordedDate})`,
              dielPeriod: sql`excluded.diel_period`,
              configHash: sql`excluded.config_hash`,
              computedAt: sql`excluded.computed_at`,
            },
          });
      },
    });

    if (result.success) {
      await db
        .update(processingJobs)
        .set({
          status: "completed",
          completedAt: new Date(),
          processedImages: result.totalProcessed,
          statusMessage:
            `${result.totalProcessed} archivos procesados` +
            (result.totalSkipped > 0
              ? `, ${result.totalSkipped} omitidos`
              : ""),
        })
        .where(eq(processingJobs.id, jobId));
      log.info(
        {
          jobId,
          processed: result.totalProcessed,
          skipped: result.totalSkipped,
        },
        "[acoustic-indices] Job completed successfully"
      );
    } else {
      throw new Error(result.error);
    }

    if (job.deploymentId != null) {
      revalidatePath(`/audio/${job.deploymentId}`);
    }
    revalidatePath("/biochoco/resultados");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, jobId }, "[acoustic-indices] Job failed");
    await db
      .update(processingJobs)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorMessage: message,
        statusMessage: "Fallido",
      })
      .where(eq(processingJobs.id, jobId));
  }
}

async function cancelAcousticIndicesJob(
  jobId: number
): Promise<ActionResult> {
  const user = await requirePermission("grabaciones", "editor");

  const [job] = await db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId));
  if (!job) return { success: false, error: "Trabajo no encontrado" };
  if (!["pending", "processing"].includes(job.status)) {
    return { success: false, error: "El trabajo ya finalizó" };
  }
  if (job.deploymentId != null) {
    await requireDeploymentAccess(user, job.deploymentId);
  } else if (job.cameraTrapProjectId != null) {
    await requirePermission("grabaciones", "admin");
  }

  if (job.pid) {
    try {
      process.kill(job.pid, "SIGTERM");
    } catch {
      // process may have exited already
    }
  }
  // Per-file results are valid as-is — no rollback. Next run upserts.
  await db
    .update(processingJobs)
    .set({
      status: "cancelled",
      completedAt: new Date(),
      statusMessage: null,
    })
    .where(eq(processingJobs.id, jobId));

  if (job.deploymentId != null) {
    revalidatePath(`/audio/${job.deploymentId}`);
  }
  revalidatePath("/biochoco/resultados");
  return { success: true, data: undefined };
}

// ---------------------------------------------------------------------------
// Combined audio analysis (BirdNET + acoustic indices, chunked)
// ---------------------------------------------------------------------------

interface CreateAudioAnalysisJobInput {
  deploymentId: number;
  includeBirdnet?: boolean;
  includeIndices?: boolean;
}

/**
 * Enqueue a combined audio analysis. Processes the deployment in chunks of
 * `AUDIO_ANALYSIS_CHUNK_SIZE` files (default 1000). Each chunk downloads,
 * runs BirdNET and/or indices, then actively releases the chunk's cache so
 * peak disk usage stays bounded — important for deployments larger than the
 * cache cap.
 */
export async function createAudioAnalysisJob(
  input: CreateAudioAnalysisJobInput
): Promise<ActionResult<{ jobId: number }>> {
  const { deploymentId, includeBirdnet = true, includeIndices = true } = input;

  if (!includeBirdnet && !includeIndices) {
    return { success: false, error: "Selecciona al menos un análisis" };
  }

  const user = await requirePermission("grabaciones", "editor");
  await requireDeploymentAccess(user, deploymentId);

  const [fileRow] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(audioFiles)
    .where(eq(audioFiles.deploymentId, deploymentId));
  const totalFiles = fileRow?.count ?? 0;
  if (totalFiles === 0) {
    return { success: false, error: "No hay archivos de audio en esta instalación" };
  }

  // Single-flight across all three audio analysis job types — a deployment
  // can only have one of {birdnet, acoustic_indices, audio_analysis} in flight.
  const [activeJob] = await db
    .select({ id: processingJobs.id })
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.deploymentId, deploymentId),
        inArray(processingJobs.jobType, [
          JOB_TYPES.BIRDNET,
          JOB_TYPES.ACOUSTIC_INDICES,
          JOB_TYPES.AUDIO_ANALYSIS,
        ]),
        inArray(processingJobs.status, ["pending", "processing"])
      )
    )
    .limit(1);
  if (activeJob) {
    return { success: false, error: "Ya existe un análisis activo para esta instalación" };
  }

  if (includeBirdnet) {
    await db.run(sql`
      DELETE FROM audio_detections
      WHERE audio_file_id IN (
        SELECT id FROM audio_files WHERE deployment_id = ${deploymentId}
      )
      AND job_id IS NOT NULL
    `);
  }

  const phaseLabel =
    includeBirdnet && includeIndices
      ? "Preparando análisis (BirdNET + índices)..."
      : includeBirdnet
        ? "Preparando análisis BirdNET..."
        : "Preparando cálculo de índices acústicos...";

  const [job] = await db
    .insert(processingJobs)
    .values({
      deploymentId,
      jobType: JOB_TYPES.AUDIO_ANALYSIS,
      totalImages: totalFiles,
      status: "pending",
      createdBy: user.email,
      statusMessage: phaseLabel,
    })
    .returning();

  processAudioAnalysisJob(job.id, { includeBirdnet, includeIndices }).catch((err) => {
    log.error(
      { err, jobId: job.id },
      "[audio-analysis] Unhandled error in processAudioAnalysisJob"
    );
  });

  return { success: true, data: { jobId: job.id } };
}

async function processAudioAnalysisJob(
  jobId: number,
  opts: { includeBirdnet: boolean; includeIndices: boolean }
): Promise<void> {
  try {
    await db
      .update(processingJobs)
      .set({ status: "processing", startedAt: new Date() })
      .where(eq(processingJobs.id, jobId));

    const [job] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId));
    if (!job) throw new Error(`Job ${jobId} not found`);
    if (job.deploymentId === null) {
      throw new Error(`Audio analysis job ${jobId} has null deploymentId`);
    }
    const deploymentId = job.deploymentId;

    const [deployment] = await db
      .select({
        id: deployments.id,
        latitude: deployments.latitude,
        longitude: deployments.longitude,
        dateStart: deployments.dateStart,
      })
      .from(deployments)
      .where(eq(deployments.id, deploymentId));
    if (!deployment) throw new Error(`Deployment ${deploymentId} not found`);

    // BirdNET location/time defaults — same fallbacks as processBirdNETJob.
    const lat = deployment.latitude ?? -0.3;
    const lon = deployment.longitude ?? -79.2;
    if (deployment.latitude === null || deployment.longitude === null) {
      log.warn(
        { jobId, deploymentId },
        "[audio-analysis] Using default lat/lon — deployment has no coordinates"
      );
    }
    let week = -1;
    if (deployment.dateStart) {
      const d = new Date(deployment.dateStart);
      const start = new Date(d.getFullYear(), 0, 1);
      const dayOfYear = Math.ceil((d.getTime() - start.getTime()) / 86400000) + 1;
      week = Math.ceil(dayOfYear / 7);
    }

    const files = await db
      .select({
        id: audioFiles.id,
        filename: audioFiles.filename,
        driveFileId: audioFiles.driveFileId,
      })
      .from(audioFiles)
      .where(eq(audioFiles.deploymentId, deploymentId));

    const filesWithDrive = files.filter((f) => f.driveFileId !== null);
    const downloadTotal = filesWithDrive.length;

    const chunkSize = Math.max(
      1,
      parseInt(process.env.AUDIO_ANALYSIS_CHUNK_SIZE ?? "1000", 10) || 1000
    );
    const chunks: typeof filesWithDrive[] = [];
    for (let i = 0; i < filesWithDrive.length; i += chunkSize) {
      chunks.push(filesWithDrive.slice(i, i + chunkSize));
    }
    const totalChunks = chunks.length;

    await db
      .update(processingJobs)
      .set({
        downloadTotal,
        statusMessage:
          totalChunks > 1
            ? `Procesando ${downloadTotal} archivos en ${totalChunks} lotes...`
            : `Procesando ${downloadTotal} archivos...`,
      })
      .where(eq(processingJobs.id, jobId));

    const threads = Math.max(
      1,
      (os.availableParallelism?.() ?? os.cpus().length) - 1
    );

    let globalDownloaded = 0;
    let globalProcessed = 0;
    let totalDetections = 0;
    let totalIndices = 0;

    for (let chunkIdx = 0; chunkIdx < chunks.length; chunkIdx++) {
      const chunk = chunks[chunkIdx];
      const chunkLabel = totalChunks > 1 ? `Lote ${chunkIdx + 1}/${totalChunks} · ` : "";

      // Phase 1 — download chunk to cache.
      const cachedFiles: Array<{ id: number; path: string; filename: string }> = [];
      for (const file of chunk) {
        try {
          const cachePath = await ensureAudioCached(file.id);
          cachedFiles.push({ id: file.id, path: cachePath, filename: file.filename });
          globalDownloaded++;
          await db
            .update(processingJobs)
            .set({
              downloadedImages: globalDownloaded,
              statusMessage: `${chunkLabel}descargando (${globalDownloaded}/${downloadTotal})...`,
            })
            .where(eq(processingJobs.id, jobId));
        } catch (err) {
          log.warn(
            { err, fileId: file.id },
            "[audio-analysis] Failed to cache audio file, skipping"
          );
        }
      }

      if (cachedFiles.length === 0) {
        log.warn(
          { jobId, chunkIdx },
          "[audio-analysis] Chunk has no cached files after download phase — skipping"
        );
        continue;
      }

      // Phase 2 — stage symlinks for BirdNET's CLI (which wants a directory).
      let chunkDir: string | null = null;
      if (opts.includeBirdnet) {
        chunkDir = path.join(
          process.cwd(),
          "data",
          "cache",
          "audio",
          String(deploymentId),
          `_chunk_${chunkIdx}`
        );
        await fs.mkdir(chunkDir, { recursive: true });
        for (const f of cachedFiles) {
          const linkPath = path.join(chunkDir, f.filename);
          try {
            await fs.unlink(linkPath);
          } catch {
            // No prior link — expected.
          }
          await fs.symlink(f.path, linkPath);
        }
      }

      // Phase 3 — BirdNET on the chunk.
      if (opts.includeBirdnet && chunkDir) {
        await db
          .update(processingJobs)
          .set({
            statusMessage: `${chunkLabel}BirdNET (0/${cachedFiles.length})...`,
            processedImages: globalProcessed,
          })
          .where(eq(processingJobs.id, jobId));

        const filenameToFileId = new Map<string, number>();
        for (const f of cachedFiles) {
          filenameToFileId.set(f.filename, f.id);
          const base = f.filename.replace(/\.[^.]+$/, "");
          filenameToFileId.set(base, f.id);
        }

        const result = await runBirdNETAnalysis(
          jobId,
          {
            audioDir: chunkDir,
            lat,
            lon,
            week,
            minConf: 0.1,
            threads,
            totalFiles: cachedFiles.length,
            sensitivity: 1.0,
            overlap: 1.0,
          },
          filenameToFileId
        );

        if (!result.success) {
          throw new Error(
            `BirdNET (lote ${chunkIdx + 1}/${totalChunks}): ${result.error}`
          );
        }
        totalDetections += result.totalDetections;
      }

      // Phase 4 — indices on the chunk.
      if (opts.includeIndices) {
        await db
          .update(processingJobs)
          .set({
            statusMessage: `${chunkLabel}índices (0/${cachedFiles.length})...`,
            processedImages: globalProcessed,
          })
          .where(eq(processingJobs.id, jobId));

        const result = await runAcousticIndicesAnalysis({
          jobId,
          files: cachedFiles,
          onResult: async (r: AcousticIndicesResult) => {
            const now = new Date();
            await db
              .insert(acousticIndices)
              .values({
                audioFileId: r.audioFileId,
                soundscapeSaturation: r.soundscapeSaturation,
                acousticComplexityIndex: r.acousticComplexityIndex,
                frequencyEntropy: r.frequencyEntropy,
                temporalEntropy: r.temporalEntropy,
                eventsPerSecond: r.eventsPerSecond,
                recordedDate: r.recordedDate,
                dielPeriod: r.dielPeriod,
                configHash: r.configHash,
                computedAt: now,
              })
              .onConflictDoUpdate({
                target: acousticIndices.audioFileId,
                set: {
                  soundscapeSaturation: sql`excluded.soundscape_saturation`,
                  acousticComplexityIndex: sql`excluded.acoustic_complexity_index`,
                  frequencyEntropy: sql`excluded.frequency_entropy`,
                  temporalEntropy: sql`excluded.temporal_entropy`,
                  eventsPerSecond: sql`excluded.events_per_second`,
                  recordedDate: sql`COALESCE(excluded.recorded_date, ${acousticIndices.recordedDate})`,
                  dielPeriod: sql`excluded.diel_period`,
                  configHash: sql`excluded.config_hash`,
                  computedAt: sql`excluded.computed_at`,
                },
              });
          },
        });

        if (!result.success) {
          throw new Error(
            `Índices (lote ${chunkIdx + 1}/${totalChunks}): ${result.error}`
          );
        }
        totalIndices += result.totalProcessed;
      }

      // Phase 5 — release the chunk's cache so the next chunk has room.
      globalProcessed += cachedFiles.length;
      await db
        .update(processingJobs)
        .set({
          processedImages: globalProcessed,
          statusMessage: `${chunkLabel}lote completo (${globalProcessed}/${downloadTotal})`,
        })
        .where(eq(processingJobs.id, jobId));

      const chunkIds = cachedFiles.map((f) => f.id);
      try {
        await releaseFiles(chunkIds);
      } catch (err) {
        log.warn(
          { err, jobId, chunkIdx },
          "[audio-analysis] Failed to release chunk cache (continuing)"
        );
      }
      if (chunkDir) {
        try {
          await fs.rm(chunkDir, { recursive: true, force: true });
        } catch (err) {
          log.warn(
            { err, chunkDir },
            "[audio-analysis] Failed to remove chunk symlink dir"
          );
        }
      }
    }

    // Summary: re-count species for the run if BirdNET ran. Detections are
    // attributed to this job's id by runBirdNETAnalysis.
    let totalSpecies = 0;
    if (opts.includeBirdnet) {
      const [speciesCount] = await db
        .select({
          count: sql<number>`COUNT(DISTINCT ${audioIdentifications.species})`,
        })
        .from(audioDetections)
        .innerJoin(
          audioIdentifications,
          eq(audioIdentifications.audioDetectionId, audioDetections.id)
        )
        .where(eq(audioDetections.jobId, jobId));
      totalSpecies = speciesCount?.count ?? 0;
    }

    const parts: string[] = [`${globalProcessed} archivos`];
    if (opts.includeBirdnet) {
      parts.push(`${totalDetections} detecciones`, `${totalSpecies} especies`);
    }
    if (opts.includeIndices) {
      parts.push(`${totalIndices} índices`);
    }

    await db
      .update(processingJobs)
      .set({
        status: "completed",
        completedAt: new Date(),
        processedImages: globalProcessed,
        statusMessage: parts.join(", "),
      })
      .where(eq(processingJobs.id, jobId));

    log.info(
      {
        jobId,
        deploymentId,
        processed: globalProcessed,
        detections: totalDetections,
        species: totalSpecies,
        indices: totalIndices,
        chunks: totalChunks,
      },
      "[audio-analysis] Job completed successfully"
    );

    revalidatePath(`/audio/${deploymentId}`);
    revalidatePath("/biochoco/resultados");
    revalidatePath("/audio");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ err, jobId }, "[audio-analysis] Job failed");
    await db
      .update(processingJobs)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorMessage: message,
        statusMessage: "Fallido",
      })
      .where(eq(processingJobs.id, jobId));
  }
}

async function cancelAudioAnalysisJob(
  jobId: number
): Promise<ActionResult> {
  const user = await requirePermission("grabaciones", "editor");

  const [job] = await db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId));
  if (!job) return { success: false, error: "Trabajo no encontrado" };
  if (job.deploymentId === null) {
    return { success: false, error: "Trabajo sin instalación asociada" };
  }
  await requireDeploymentAccess(user, job.deploymentId);
  if (!["pending", "processing"].includes(job.status)) {
    return { success: false, error: "El trabajo ya finalizó" };
  }

  if (job.pid) {
    try {
      process.kill(job.pid, "SIGTERM");
    } catch {
      // Already exited.
    }
  }

  // Partial results (detections from completed chunks, indices rows) are
  // valid — leave them in place.
  await db
    .update(processingJobs)
    .set({
      status: "cancelled",
      completedAt: new Date(),
      statusMessage: null,
    })
    .where(eq(processingJobs.id, jobId));

  revalidatePath(`/audio/${job.deploymentId}`);
  revalidatePath("/biochoco/resultados");
  revalidatePath("/audio");
  return { success: true, data: undefined };
}

export interface AcousticIndicesPoint {
  deploymentId: number;
  deploymentName: string;
  siteName: string | null;
  nFiles: number;
  soundscapeSaturation: number;
  acousticComplexityIndex: number;
  frequencyEntropy: number;
  temporalEntropy: number;
  eventsPerSecond: number;
}

export interface AcousticIndicesGroup {
  habitatKey: string;
  habitatLabel: string;
  color: string;
  dielPeriod: DielPeriod;
  points: AcousticIndicesPoint[];
}

export interface AcousticIndicesData {
  groups: AcousticIndicesGroup[];
  totalDeployments: number;
}

const UNKNOWN_HABITAT_COLOR = "#94a3b8"; // slate-400 — matches BoxPlotChart NEUTRAL_COLOR

/** Median of a non-empty number array. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/** Extract site_id from `SEC-006_V1` → `SEC-006`. */
function extractSiteId(deploymentName: string): string | null {
  const m = deploymentName.match(/^(.+?)_V\d+$/i);
  return m ? m[1] : null;
}

/** Build site → habitat map from ODK. Returns an empty Map on error. */
async function loadSiteHabitatMapSafe(): Promise<Map<string, string>> {
  try {
    const sites = await fetchEntities<OdkSiteEntity>(
      BIOCHOCO_PROJECT_ID,
      BIOCHOCO_DATASET_SITES
    );
    const map = new Map<string, string>();
    for (const site of sites) {
      if (!site.habitat_type) continue;
      if (site.site_id) map.set(site.site_id, site.habitat_type);
      if (site.site_name) map.set(site.site_name, site.habitat_type);
      if (site.label && site.label !== site.site_name) {
        map.set(site.label, site.habitat_type);
      }
    }
    return map;
  } catch (err) {
    log.warn({ err }, "[acoustic-indices] ODK habitat map unavailable");
    return new Map();
  }
}

/**
 * Returns per-deployment medians of each index, grouped by (habitat, diel_period).
 * Consumed by the BioChoco habitat dashboard at /biochoco/resultados?view=habitat.
 */
export async function getAcousticIndicesForProject(
  cameraTrapProjectId: number
): Promise<ActionResult<AcousticIndicesData>> {
  await requirePermission("grabaciones", "viewer");

  const rows = await db
    .select({
      deploymentId: deployments.id,
      deploymentName: deployments.name,
      siteName: deployments.siteName,
      soundscapeSaturation: acousticIndices.soundscapeSaturation,
      acousticComplexityIndex: acousticIndices.acousticComplexityIndex,
      frequencyEntropy: acousticIndices.frequencyEntropy,
      temporalEntropy: acousticIndices.temporalEntropy,
      eventsPerSecond: acousticIndices.eventsPerSecond,
      dielPeriod: acousticIndices.dielPeriod,
    })
    .from(acousticIndices)
    .innerJoin(audioFiles, eq(audioFiles.id, acousticIndices.audioFileId))
    .innerJoin(deployments, eq(deployments.id, audioFiles.deploymentId))
    .where(eq(deployments.cameraTrapProjectId, cameraTrapProjectId));

  if (rows.length === 0) {
    return { success: true, data: { groups: [], totalDeployments: 0 } };
  }

  const habitatMap = await loadSiteHabitatMapSafe();

  // First bucket: (habitat, diel_period, deploymentId) → all rows.
  type Bucket = {
    habitatKey: string;
    dielPeriod: DielPeriod;
    deploymentId: number;
    deploymentName: string;
    siteName: string | null;
    ss: number[];
    aci: number[];
    hf: number[];
    ht: number[];
    eps: number[];
  };
  const buckets = new Map<string, Bucket>();

  for (const row of rows) {
    const dielPeriod = (DIEL_PERIODS as readonly string[]).includes(row.dielPeriod)
      ? (row.dielPeriod as DielPeriod)
      : "other";
    const habitatKey =
      (row.siteName ? habitatMap.get(row.siteName) : null) ??
      habitatMap.get(extractSiteId(row.deploymentName) ?? "") ??
      "unknown";

    const key = `${habitatKey}|${dielPeriod}|${row.deploymentId}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        habitatKey,
        dielPeriod,
        deploymentId: row.deploymentId,
        deploymentName: row.deploymentName,
        siteName: row.siteName,
        ss: [],
        aci: [],
        hf: [],
        ht: [],
        eps: [],
      };
      buckets.set(key, b);
    }
    if (row.soundscapeSaturation != null) b.ss.push(row.soundscapeSaturation);
    if (row.acousticComplexityIndex != null) b.aci.push(row.acousticComplexityIndex);
    if (row.frequencyEntropy != null) b.hf.push(row.frequencyEntropy);
    if (row.temporalEntropy != null) b.ht.push(row.temporalEntropy);
    if (row.eventsPerSecond != null) b.eps.push(row.eventsPerSecond);
  }

  // Now flatten to per-deployment points and re-group by (habitat, diel_period).
  const groupMap = new Map<string, AcousticIndicesGroup>();
  for (const b of buckets.values()) {
    // Skip empty deployments — they'd produce NaN medians.
    const nFiles = Math.max(b.ss.length, b.aci.length, b.hf.length, b.ht.length, b.eps.length);
    if (nFiles === 0) continue;
    const point: AcousticIndicesPoint = {
      deploymentId: b.deploymentId,
      deploymentName: b.deploymentName,
      siteName: b.siteName,
      nFiles,
      soundscapeSaturation: b.ss.length ? median(b.ss) : 0,
      acousticComplexityIndex: b.aci.length ? median(b.aci) : 0,
      frequencyEntropy: b.hf.length ? median(b.hf) : 0,
      temporalEntropy: b.ht.length ? median(b.ht) : 0,
      eventsPerSecond: b.eps.length ? median(b.eps) : 0,
    };
    const groupKey = `${b.habitatKey}|${b.dielPeriod}`;
    let g = groupMap.get(groupKey);
    if (!g) {
      g = {
        habitatKey: b.habitatKey,
        habitatLabel:
          b.habitatKey === "unknown"
            ? "Sin clasificar"
            : getHabitatName(b.habitatKey),
        color: HABITAT_COLORS[b.habitatKey] ?? UNKNOWN_HABITAT_COLOR,
        dielPeriod: b.dielPeriod,
        points: [],
      };
      groupMap.set(groupKey, g);
    }
    g.points.push(point);
  }

  // Stable ordering: habitats first by label, then deployments by name within group.
  const groups = Array.from(groupMap.values())
    .sort((a, b) => a.habitatLabel.localeCompare(b.habitatLabel))
    .map((g) => ({
      ...g,
      points: g.points.sort((a, b) => a.deploymentName.localeCompare(b.deploymentName)),
    }));

  // Total distinct deployments across all groups (used for the page summary).
  const deploymentIds = new Set<number>();
  for (const g of groups) for (const p of g.points) deploymentIds.add(p.deploymentId);

  return { success: true, data: { groups, totalDeployments: deploymentIds.size } };
}

// ---------------------------------------------------------------------------
// Audio Deployment QA
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Batch actions (selection toolbar)
// ---------------------------------------------------------------------------

/**
 * Bulk-update metadata on the selected audio deployments. Mirrors
 * `bulkUpdateMetadata` in camera-trap but checks the `grabaciones` permission.
 *
 * `fields` is a partial — only keys whose value is not `undefined` are written.
 * The shared `BatchEditDialog` passes only the apply-checked fields.
 */
export async function bulkUpdateAudioMetadata(
  ids: number[],
  fields: {
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
  const user = await requirePermission("grabaciones", "editor");

  try {
    if (ids.length === 0) {
      return { success: true, data: { count: 0 } };
    }

    for (const id of ids) {
      await requireDeploymentAccess(user, id);
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (fields.cameraTrapProjectId !== undefined) {
      updates.cameraTrapProjectId = fields.cameraTrapProjectId;
      if (fields.cameraTrapProjectId) {
        const [proj] = await db
          .select({ name: cameraTrapProjects.name })
          .from(cameraTrapProjects)
          .where(eq(cameraTrapProjects.id, fields.cameraTrapProjectId));
        if (proj) updates.projectLabel = proj.name;
      }
    }
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

    revalidatePath("/audio");
    return { success: true, data: { count: ids.length } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al actualizar en lote",
    };
  }
}

/**
 * Re-scan audio for a batch of deployments. Iterates `scanDeploymentAudio`
 * per deployment — simpler than threading deploymentIds through the worker,
 * which is built for whole-project syncs. Failures don't abort the batch:
 * each error is collected and returned.
 */
export async function batchRescanAudio(
  ids: number[]
): Promise<ActionResult<{ scanned: number; errors: number; errorMessages: string[] }>> {
  const user = await requirePermission("grabaciones", "editor");

  if (ids.length === 0) {
    return { success: true, data: { scanned: 0, errors: 0, errorMessages: [] } };
  }

  for (const id of ids) {
    await requireDeploymentAccess(user, id);
  }

  let scanned = 0;
  const errorMessages: string[] = [];

  for (const id of ids) {
    try {
      const result = await scanDeploymentAudio(id);
      if (result.success) {
        scanned++;
      } else {
        errorMessages.push(`#${id}: ${result.error}`);
      }
    } catch (err) {
      log.error({ err, deploymentId: id }, "[audio] Batch rescan failed for deployment");
      errorMessages.push(
        `#${id}: ${err instanceof Error ? err.message : "Error desconocido"}`
      );
    }
  }

  revalidatePath("/audio");
  return {
    success: true,
    data: { scanned, errors: errorMessages.length, errorMessages },
  };
}

/**
 * Enqueue a BirdNET job for each selected deployment that has audio files
 * and isn't already being analysed. The existing per-deployment guard in
 * `createBirdNETJob` skips deployments with an in-flight BirdNET job, so
 * this is safe to call repeatedly. Returns counts so the UI can report
 * "started N, skipped M (already analysing), no files for K".
 */
export async function batchCreateBirdNETJobs(
  ids: number[]
): Promise<
  ActionResult<{ enqueued: number; skipped: number; noFiles: number; errorMessages: string[] }>
> {
  const user = await requirePermission("grabaciones", "editor");

  if (ids.length === 0) {
    return {
      success: true,
      data: { enqueued: 0, skipped: 0, noFiles: 0, errorMessages: [] },
    };
  }

  for (const id of ids) {
    await requireDeploymentAccess(user, id);
  }

  let enqueued = 0;
  let skipped = 0;
  let noFiles = 0;
  const errorMessages: string[] = [];

  for (const id of ids) {
    try {
      const result = await createBirdNETJob(id);
      if (result.success) {
        enqueued++;
      } else {
        // Classify the soft-failure cases so the UI can summarise rather
        // than dump N identical "Already analysing" lines.
        if (result.error.includes("activo")) skipped++;
        else if (result.error.includes("No hay archivos")) noFiles++;
        else errorMessages.push(`#${id}: ${result.error}`);
      }
    } catch (err) {
      log.error({ err, deploymentId: id }, "[audio] Batch BirdNET enqueue failed");
      errorMessages.push(
        `#${id}: ${err instanceof Error ? err.message : "Error desconocido"}`
      );
    }
  }

  revalidatePath("/audio");
  return {
    success: true,
    data: { enqueued, skipped, noFiles, errorMessages },
  };
}

/**
 * Enqueue a combined audio_analysis job per deployment. Shares the same
 * single-flight + soft-failure classification shape as `batchCreateBirdNETJobs`
 * so the batch dialog can summarise results consistently.
 */
export async function batchCreateAudioAnalysisJobs(
  ids: number[],
  opts: { includeBirdnet?: boolean; includeIndices?: boolean } = {}
): Promise<
  ActionResult<{ enqueued: number; skipped: number; noFiles: number; errorMessages: string[] }>
> {
  const user = await requirePermission("grabaciones", "editor");

  if (ids.length === 0) {
    return {
      success: true,
      data: { enqueued: 0, skipped: 0, noFiles: 0, errorMessages: [] },
    };
  }

  for (const id of ids) {
    await requireDeploymentAccess(user, id);
  }

  let enqueued = 0;
  let skipped = 0;
  let noFiles = 0;
  const errorMessages: string[] = [];

  for (const id of ids) {
    try {
      const result = await createAudioAnalysisJob({
        deploymentId: id,
        includeBirdnet: opts.includeBirdnet,
        includeIndices: opts.includeIndices,
      });
      if (result.success) {
        enqueued++;
      } else {
        if (result.error.includes("activo")) skipped++;
        else if (result.error.includes("No hay archivos")) noFiles++;
        else errorMessages.push(`#${id}: ${result.error}`);
      }
    } catch (err) {
      log.error(
        { err, deploymentId: id },
        "[audio-analysis] Batch enqueue failed"
      );
      errorMessages.push(
        `#${id}: ${err instanceof Error ? err.message : "Error desconocido"}`
      );
    }
  }

  revalidatePath("/audio");
  return {
    success: true,
    data: { enqueued, skipped, noFiles, errorMessages },
  };
}

/**
 * Hard-delete the audio file index for the selected deployments. Does NOT
 * touch Drive — just clears the local `audio_files` rows so the next sync
 * re-indexes from scratch. Files with annotations are soft-deleted instead
 * (drive_file_id nulled, row preserved) so detection rows remain valid.
 *
 * Admin-only. Use case: the index got out of sync with Drive (renames,
 * folder moves, schema migration), and a fresh re-scan is faster than
 * trying to reconcile.
 */
export async function clearAudioIndex(
  ids: number[]
): Promise<ActionResult<{ hardDeleted: number; softDeleted: number }>> {
  const user = await requirePermission("grabaciones", "admin");

  if (ids.length === 0) {
    return { success: true, data: { hardDeleted: 0, softDeleted: 0 } };
  }

  for (const id of ids) {
    await requireDeploymentAccess(user, id);
  }

  let hardDeleted = 0;
  let softDeleted = 0;

  // Synchronous transaction — better-sqlite3 requirement (no async callbacks).
  db.transaction((tx) => {
    for (const depId of ids) {
      const files = tx
        .select({ id: audioFiles.id })
        .from(audioFiles)
        .where(eq(audioFiles.deploymentId, depId))
        .all();

      for (const f of files) {
        const [det] = tx
          .select({ id: audioDetections.id })
          .from(audioDetections)
          .where(eq(audioDetections.audioFileId, f.id))
          .limit(1)
          .all();

        if (det) {
          // Preserve row + detections; null the Drive reference so a fresh
          // sync re-attaches it if the file still exists.
          tx.update(audioFiles)
            .set({ driveFileId: null })
            .where(eq(audioFiles.id, f.id))
            .run();
          softDeleted++;
        } else {
          tx.delete(audioFiles).where(eq(audioFiles.id, f.id)).run();
          hardDeleted++;
        }
      }
    }
  });

  revalidatePath("/audio");
  return { success: true, data: { hardDeleted, softDeleted } };
}

// ---------------------------------------------------------------------------
// Audio Deployment QA
// ---------------------------------------------------------------------------

export async function updateAudioDeploymentQa(
  deploymentId: number,
  fields: {
    excluded: boolean;
    qaNotes: string | null;
  }
): Promise<ActionResult> {
  const user = await requirePermission("grabaciones", "editor");
  await requireDeploymentAccess(user, deploymentId);

  try {
    if (fields.qaNotes && fields.qaNotes.length > 2000) {
      return { success: false, error: "Las notas de calidad no pueden superar los 2000 caracteres" };
    }

    const [existing] = await db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.id, deploymentId));

    if (!existing) {
      return { success: false, error: "Instalación no encontrada" };
    }

    await db
      .update(deployments)
      .set({
        excluded: fields.excluded,
        qaNotes: fields.qaNotes,
        updatedAt: new Date(),
      })
      .where(eq(deployments.id, deploymentId));

    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al actualizar",
    };
  }
}
