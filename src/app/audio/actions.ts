"use server";

import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import {
  deployments,
  audioFiles,
  audioDetections,
  audioIdentifications,
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
import { log } from "@/lib/log";
import { ensureAudioCached } from "@/lib/audio-cache";
import { runBirdNETAnalysis } from "@/lib/birdnet-runner";
import { scanDeploymentAudioInternal } from "@/lib/audio-sync-internals";

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
        AND job_type = 'birdnet' AND status = 'completed'
      )`,
      isBirdnetProcessing: sql<number>`(
        SELECT COUNT(*) FROM biochoco_processing_jobs
        WHERE deployment_id = ${deployments.id}
        AND job_type = 'birdnet' AND status IN ('pending', 'processing')
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

  if (job.jobType === "birdnet") {
    return cancelBirdNETJob(jobId);
  }

  // For camera trap jobs, delegate to camera-trap cancel
  const { cancelJob } = await import("@/app/camera-trap/actions");
  return cancelJob(jobId);
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
