"use server";

import { db } from "@/db";
import { deployments, images, cameraTrapProjects, processingJobs } from "@/db/schema";
import { recordEvent, buildJobCompletionEvent } from "@/lib/system-events";
import { eq, and, inArray, sql, count } from "drizzle-orm";
import {
  listDeploymentFolders,
  listDeploymentFoldersAcrossDrives,
  isValidFolderId,
  checkDeploymentUploads,
  downloadFileToBuffer,
  updateFileContent,
  getFileRevisions,
  downloadFileRevision,
} from "@/lib/drive-client";
import { getDiscoveryRootsForProject } from "@/lib/shared-drives";
import { matchOdkDeployments } from "./odk-actions";
import {
  scanDeploymentImagesInternal,
} from "@/lib/camera-trap-sync-internals";
import { runDriveSyncWorker } from "@/lib/camera-trap-sync-worker";
import { processNextQueueable, claimAndEmitStart } from "@/lib/job-queue";
import { requirePermission } from "@/lib/auth";
import { getUserCameraTrapProjects, requireDeploymentAccess } from "@/lib/camera-trap-auth";
import { touchAppState } from "@/lib/app-state";
import { CAMERA_TRAP_DRIVE_LAST_SYNC_KEY } from "@/lib/app-state-keys";
import { revalidatePath } from "next/cache";
import path from "path";
import { promises as fs } from "fs";
import { after } from "next/server";
import type { ActionResult } from "@/lib/types";
import type { Deployment } from "@/db/schema";
import { log } from "@/lib/log";

const CAMERA_TRAP_PATH = "/camera-trap";

// ---------------------------------------------------------------------------
// Enqueue a background Drive sync job (manual button + cron use this)
// ---------------------------------------------------------------------------

/**
 * Enqueue a `drive_sync` background job. Runs the full sync workflow
 * (folder discovery + image scan + count refresh + ODK match) in a
 * worker process via `after()`. Single-flight: at most one drive_sync
 * job pending or processing at a time, regardless of scope.
 */
export async function enqueueDriveSyncJob(
  cameraTrapProjectId?: number
): Promise<ActionResult<{ jobId: number }>> {
  const user = await requirePermission("camera-trap", "editor");
  const ctProjects = await getUserCameraTrapProjects(user);

  // Verify access to the requested CT project (if any)
  if (cameraTrapProjectId != null) {
    if (ctProjects !== "all" && !ctProjects.includes(cameraTrapProjectId)) {
      return { success: false, error: "No tienes acceso a este proyecto" };
    }
    const [proj] = await db
      .select({ id: cameraTrapProjects.id, driveFolderId: cameraTrapProjects.driveFolderId })
      .from(cameraTrapProjects)
      .where(eq(cameraTrapProjects.id, cameraTrapProjectId));
    if (!proj?.driveFolderId) {
      return {
        success: false,
        error:
          "Este proyecto no tiene una carpeta de Drive configurada. Contacta al administrador.",
      };
    }
  }

  // Single-flight: reject if any drive_sync job is in flight
  const [inflight] = await db
    .select({ id: processingJobs.id })
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.jobType, "drive_sync"),
        inArray(processingJobs.status, ["pending", "processing"]),
      ),
    );

  if (inflight) {
    return { success: false, error: "Ya hay una sincronización en curso" };
  }

  const [job] = await db
    .insert(processingJobs)
    .values({
      jobType: "drive_sync",
      deploymentId: null,
      cameraTrapProjectId: cameraTrapProjectId ?? null,
      status: "pending",
      totalImages: 0,
      processedImages: 0,
      failedImages: 0,
      statusMessage: "En cola...",
      createdBy: user.email,
    })
    .returning();

  // Schedule the worker to run after the response is sent. `after()` is
  // Next.js 16's officially supported primitive for fire-and-forget on
  // self-hosted Node and survives the response lifecycle.
  after(() =>
    runDriveSyncWorker(job.id).catch((err) =>
      log.error({ err, jobId: job.id }, "[drive-sync] worker rejected"),
    ),
  );

  return { success: true, data: { jobId: job.id } };
}

// ---------------------------------------------------------------------------
// Sync with Google Drive — auto-create deployment rows for new folders
// ---------------------------------------------------------------------------

export async function syncWithDrive(
  cameraTrapProjectId?: number
): Promise<
  ActionResult<{ created: Deployment[]; existing: Deployment[]; errors: string[] }>
> {
  const user = await requirePermission("camera-trap", "editor");
  const ctProjects = await getUserCameraTrapProjects(user);

  try {
    // Determine which CT projects to sync
    type SyncProject = { id: number; name: string; driveFolderId: string };
    let projectsToSync: SyncProject[];

    if (cameraTrapProjectId) {
      // Specific project requested
      if (ctProjects !== "all" && !ctProjects.includes(cameraTrapProjectId)) {
        return { success: false, error: "No tienes acceso a este proyecto" };
      }
      const [proj] = await db
        .select()
        .from(cameraTrapProjects)
        .where(eq(cameraTrapProjects.id, cameraTrapProjectId));
      if (!proj?.driveFolderId) {
        return { success: false, error: "Este proyecto no tiene una carpeta de Drive configurada. Contacta al administrador." };
      }
      projectsToSync = [{ id: proj.id, name: proj.name, driveFolderId: proj.driveFolderId }];
    } else {
      // Sync all accessible projects with Drive folders
      let allProjects;
      if (ctProjects === "all") {
        allProjects = await db.select().from(cameraTrapProjects);
      } else {
        if (ctProjects.length === 0) return { success: true, data: { created: [], existing: [], errors: [] } };
        allProjects = await db.select().from(cameraTrapProjects).where(inArray(cameraTrapProjects.id, ctProjects));
      }
      projectsToSync = allProjects
        .filter((p): p is typeof p & { driveFolderId: string } => !!p.driveFolderId)
        .map((p) => ({ id: p.id, name: p.name, driveFolderId: p.driveFolderId }));
    }

    if (projectsToSync.length === 0) {
      return { success: false, error: "No hay proyectos con carpeta de Drive configurada." };
    }

    // Get all existing deployments with drive folder IDs
    const existingDeployments = await db
      .select()
      .from(deployments)
      .where(eq(deployments.projectId, "camera-trap"));

    const knownFolderIds = new Set(
      existingDeployments
        .filter((d) => d.driveFolderId)
        .map((d) => d.driveFolderId!)
    );

    const existing = existingDeployments.filter(
      (d) => d.driveFolderId && knownFolderIds.has(d.driveFolderId)
    );

    const allCreated: Deployment[] = [];
    const allErrors: string[] = [];

    for (const proj of projectsToSync) {
      const roots = getDiscoveryRootsForProject(proj.id, proj.driveFolderId);
      const driveFolders =
        roots.length === 1
          ? await listDeploymentFolders(roots[0])
          : await listDeploymentFoldersAcrossDrives(roots);
      const newFolders = driveFolders.filter((f) => !knownFolderIds.has(f.id));

      for (const folder of newFolders) {
        if (!isValidFolderId(folder.id)) {
          allErrors.push(`ID de carpeta inválido: ${folder.name}`);
          continue;
        }

        try {
          const [deployment] = await db
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
              createdBy: user.email,
            })
            .returning();

          allCreated.push(deployment);
          knownFolderIds.add(folder.id);
        } catch (err) {
          if (
            err instanceof Error &&
            err.message.includes("UNIQUE constraint failed")
          ) {
            continue;
          }
          allErrors.push(
            `Error al crear ${folder.name}: ${err instanceof Error ? err.message : "Error desconocido"}`
          );
        }
      }
    }

    // Auto-scan new deployments
    for (const dep of allCreated) {
      try {
        await scanDeploymentImages(dep.id);
      } catch (err) {
        log.error({ err, name: dep.name }, "[Drive] Auto-scan failed");
        allErrors.push(`Error al escanear ${dep.name}: ${err instanceof Error ? err.message : "Error desconocido"}`);
      }
    }

    // Auto-match with ODK to recover site, lat/lng, dates
    if (allCreated.length > 0) {
      try {
        await matchOdkDeployments(allCreated.map((d) => d.id));
      } catch (err) {
        log.error({ err }, "[Drive] Auto ODK match failed");
      }

      // Auto-refresh biochoco upload counts from Drive subfolders
      for (const dep of allCreated) {
        if (!dep.driveFolderId) continue;
        try {
          const result = await checkDeploymentUploads(dep.driveFolderId);
          if (result.success) {
            const uploads = result.data;
            await db
              .update(deployments)
              .set({
                uploadCameraCount: uploads.camarasTrampas,
                uploadAudioCount: uploads.grabadoresDeAudio,
                uploadIbuttonCount: uploads.ibutton,
                uploadCameraFolderId: uploads.subfolderIds.camarasTrampas,
                uploadAudioFolderId: uploads.subfolderIds.grabadoresDeAudio,
                uploadIbuttonFolderId: uploads.subfolderIds.ibutton,
                uploadCountsCheckedAt: sql`(unixepoch())`,
              })
              .where(eq(deployments.id, dep.id));
          }
        } catch (err) {
          log.error({ err, name: dep.name }, "[Drive] Upload count refresh failed");
        }
      }
    }

    await touchAppState(CAMERA_TRAP_DRIVE_LAST_SYNC_KEY);
    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: { created: allCreated, existing, errors: allErrors } };
  } catch (err) {
    log.error({ err }, "[Drive] Sync failed");
    const message =
      err instanceof Error ? err.message : "Error al sincronizar con Drive";
    return { success: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Scan images in a deployment's Drive folder
// ---------------------------------------------------------------------------

export async function scanDeploymentImages(
  deploymentId: number
): Promise<ActionResult<{ imageCount: number }>> {
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

    if (!deployment.driveFolderId) {
      return {
        success: false,
        error: "Esta instalación no tiene una carpeta de Drive asociada",
      };
    }

    const { imageCount } = await scanDeploymentImagesInternal(deployment);
    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: { imageCount } };
  } catch (err) {
    log.error({ err }, "[Drive] Scan failed");
    return {
      success: false,
      error: err instanceof Error ? err.message : "Error al escanear imágenes",
    };
  }
}

// ---------------------------------------------------------------------------
// Compress deployment images — re-encode JPEGs at quality 85
// ---------------------------------------------------------------------------

import { thumbnailPath as thumbPath } from "@/lib/thumbnail";

const COMPRESSION_QUALITY = 85;
const COMPRESSION_BATCH_SIZE = 10;
const CACHE_BASE = path.join(process.cwd(), "data", "cache", "ct-images");

const JPEG_EXTENSIONS = new Set([".jpg", ".jpeg"]);

export async function compressDeploymentImages(
  deploymentId: number,
): Promise<ActionResult<{ jobId: number }>> {
  const user = await requirePermission("camera-trap", "admin");

  try {
    await requireDeploymentAccess(user, deploymentId);

    const [deployment] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deploymentId));

    if (!deployment) {
      return { success: false, error: "Instalación no encontrada" };
    }

    // Guard: don't compress during active ML processing
    if (deployment.status === "processing") {
      return { success: false, error: "No se puede comprimir mientras se está procesando" };
    }

    // Check for an already-active compression job on this deployment
    const [existingJob] = await db
      .select()
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.deploymentId, deploymentId),
          eq(processingJobs.jobType, "compression"),
          inArray(processingJobs.status, ["pending", "processing"]),
        ),
      );

    if (existingJob) {
      return { success: false, error: "Ya hay una compresión en curso para esta instalación" };
    }

    // Count uncompressed JPEG images
    const uncompressedImages = await db
      .select()
      .from(images)
      .where(
        and(
          eq(images.deploymentId, deploymentId),
          eq(images.compressed, false),
          sql`${images.driveFileId} IS NOT NULL`,
        ),
      );

    const jpegCount = uncompressedImages.filter((img) => {
      const ext = path.extname(img.filename).toLowerCase();
      return JPEG_EXTENSIONS.has(ext);
    }).length;

    if (jpegCount === 0) {
      return { success: false, error: "No hay imágenes para comprimir" };
    }

    // Create compression job
    const [job] = await db
      .insert(processingJobs)
      .values({
        deploymentId,
        jobType: "compression",
        status: "pending",
        totalImages: jpegCount,
        processedImages: 0,
        failedImages: 0,
        createdBy: user.email,
        statusMessage: "Preparando compresión...",
      })
      .returning();

    // Hand off to the unified queue picker.
    processNextQueueable();

    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: { jobId: job.id } };
  } catch (err) {
    log.error({ err }, "[compress] Enqueue failed");
    return {
      success: false,
      error: err instanceof Error ? err.message : "Error al iniciar compresión",
    };
  }
}

/**
 * Compress a batch of JPEG images. Reusable by both standalone compression
 * jobs and the optional compress-before-ML flow.
 *
 * @param uploadToDrive - true: upload compressed to Drive + delete thumbnail (standalone).
 *                        false: write to cache only, skip Drive upload (inline during ML processing).
 */
export async function compressImageBatch(
  imgs: Array<{ id: number; filename: string; path: string | null; driveFileId: string | null; deploymentId: number }>,
  options: { uploadToDrive: boolean; jobId: number; deploymentId: number },
  onProgress?: (compressed: number, failed: number, savedBytes: number) => Promise<void>,
): Promise<{ compressed: number; failed: number; savedBytes: number }> {
  let compressed = 0;
  let failed = 0;
  let savedBytes = 0;
  const totalBatches = Math.ceil(imgs.length / COMPRESSION_BATCH_SIZE);
  const startTime = Date.now();

  for (let i = 0; i < imgs.length; i += COMPRESSION_BATCH_SIZE) {
    const batchNum = Math.floor(i / COMPRESSION_BATCH_SIZE) + 1;
    const batch = imgs.slice(i, i + COMPRESSION_BATCH_SIZE);

    // Check if job was cancelled
    const [currentJob] = await db
      .select({ status: processingJobs.status })
      .from(processingJobs)
      .where(eq(processingJobs.id, options.jobId));

    if (currentJob?.status === "cancelled") {
      log.info({ deploymentId: options.deploymentId }, "[compress] Deployment cancelled by user");
      break;
    }

    const batchStart = Date.now();

    const results = await Promise.allSettled(
      batch.map(async (img) => {
        const sharp = (await import("sharp")).default;

        let originalBuffer: Buffer;
        const cachePath = img.path || path.join(CACHE_BASE, String(options.deploymentId), img.filename);

        try {
          originalBuffer = await fs.readFile(cachePath);
        } catch {
          if (!img.driveFileId) throw new Error(`No cache and no driveFileId for ${img.filename}`);
          originalBuffer = await downloadFileToBuffer(img.driveFileId);
        }

        const originalSize = originalBuffer.length;

        const compressedBuffer = await sharp(originalBuffer)
          .jpeg({ quality: COMPRESSION_QUALITY })
          .toBuffer();

        // Validate compressed output
        const [origMeta, compMeta] = await Promise.all([
          sharp(originalBuffer).metadata(),
          sharp(compressedBuffer).metadata(),
        ]);
        if (
          origMeta.width !== compMeta.width ||
          origMeta.height !== compMeta.height ||
          compMeta.format !== "jpeg"
        ) {
          throw new Error(
            `Validation failed: ${origMeta.width}x${origMeta.height} → ${compMeta.width}x${compMeta.height} ${compMeta.format}`,
          );
        }

        const newSize = compressedBuffer.length;

        if (newSize >= originalSize) {
          await db
            .update(images)
            .set({ compressed: true, originalFileSize: originalSize })
            .where(eq(images.id, img.id));
          return { saved: 0 };
        }

        // Upload to Drive only for standalone compression
        if (options.uploadToDrive && img.driveFileId) {
          await updateFileContent(img.driveFileId, compressedBuffer, "image/jpeg");
        }

        // Always write to cache
        try {
          await fs.mkdir(path.dirname(cachePath), { recursive: true });
          await fs.writeFile(cachePath, compressedBuffer);
        } catch {
          // Cache update is best-effort
        }

        // Delete thumbnail only for standalone (Drive originals changed)
        if (options.uploadToDrive) {
          const tp = thumbPath(options.deploymentId, img.id);
          try { await fs.unlink(tp); } catch { /* may not exist */ }
        }

        await db
          .update(images)
          .set({ compressed: true, fileSize: newSize, originalFileSize: originalSize })
          .where(eq(images.id, img.id));

        return { saved: originalSize - newSize };
      }),
    );

    for (const result of results) {
      if (result.status === "fulfilled") {
        compressed++;
        savedBytes += result.value.saved;
      } else {
        log.error({ err: result.reason }, "[compress] FAILED");
        failed++;
      }
    }

    const batchMs = Date.now() - batchStart;
    const batchSec = (batchMs / 1000).toFixed(1);
    const processedSoFar = compressed + failed;
    const savedMB = (savedBytes / (1024 * 1024)).toFixed(1);
    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const rate = processedSoFar / ((Date.now() - startTime) / 1000);
    const etaSec = rate > 0 ? ((imgs.length - processedSoFar) / rate).toFixed(0) : "?";
    const rssMB = (process.memoryUsage.rss() / (1024 * 1024)).toFixed(0);
    log.info(
      {
        deploymentId: options.deploymentId,
        batchNum,
        totalBatches,
        processed: processedSoFar,
        total: imgs.length,
        batchSec,
        totalElapsed,
        etaSec,
        savedMB,
        rssMB,
      },
      "[compress] Deployment batch progress"
    );

    if (onProgress) {
      await onProgress(compressed, failed, savedBytes);
    }
  }

  return { compressed, failed, savedBytes };
}

export async function compressJobInternal(
  jobId: number,
  deploymentId: number,
  userEmail: string,
): Promise<void> {
  const startTime = Date.now();

  try {
    // Get uncompressed JPEG images
    const uncompressedImages = await db
      .select()
      .from(images)
      .where(
        and(
          eq(images.deploymentId, deploymentId),
          eq(images.compressed, false),
          sql`${images.driveFileId} IS NOT NULL`,
        ),
      );

    const jpegImages = uncompressedImages.filter((img) => {
      const ext = path.extname(img.filename).toLowerCase();
      return JPEG_EXTENSIONS.has(ext);
    });

    const skipped = uncompressedImages.length - jpegImages.length;

    // Atomic claim + start event. Refresh the status message in either case
    // (own-claim or picker-already-claimed).
    await claimAndEmitStart(jobId);
    await db
      .update(processingJobs)
      .set({ statusMessage: `Comprimiendo... 0 de ${jpegImages.length}` })
      .where(
        and(
          eq(processingJobs.id, jobId),
          eq(processingJobs.status, "processing"),
        ),
      );

    log.info({ deploymentId, count: jpegImages.length }, "[compress] Deployment starting");

    const result = await compressImageBatch(
      jpegImages.map((img) => ({ ...img, deploymentId })),
      { uploadToDrive: true, jobId, deploymentId },
      async (compressed, failed, savedBytes) => {
        const processedSoFar = compressed + failed;
        const savedMB = (savedBytes / (1024 * 1024)).toFixed(1);
        await db
          .update(processingJobs)
          .set({
            processedImages: processedSoFar,
            failedImages: failed,
            statusMessage: `Comprimiendo... ${processedSoFar} de ${jpegImages.length} · ${savedMB} MB ahorrado`,
          })
          .where(eq(processingJobs.id, jobId));
      },
    );

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(0);
    const totalSavedMB = (result.savedBytes / (1024 * 1024)).toFixed(1);

    // Mark completed
    await db
      .update(processingJobs)
      .set({
        status: "completed",
        completedAt: new Date(),
        processedImages: result.compressed + result.failed,
        failedImages: result.failed,
        statusMessage: `Comprimidas: ${result.compressed}, Omitidas: ${skipped}, Errores: ${result.failed}, Ahorro: ${totalSavedMB} MB`,
      })
      .where(eq(processingJobs.id, jobId));

    const [completedJob] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId));
    if (completedJob) {
      await recordEvent(
        buildJobCompletionEvent(completedJob, {
          compressed: result.compressed,
          skipped,
          failed: result.failed,
          savedBytes: result.savedBytes,
        }),
      );
    }

    log.info(
      {
        deploymentId,
        compressed: result.compressed,
        skipped,
        failed: result.failed,
        totalSavedMB,
        elapsedSec,
      },
      "[compress] Deployment complete"
    );
  } catch (err) {
    log.error({ err, deploymentId }, "[compress] Deployment FAILED");

    await db
      .update(processingJobs)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorMessage: err instanceof Error ? err.message : "Error desconocido",
        statusMessage: "Error en compresión",
      })
      .where(eq(processingJobs.id, jobId));

    const [failedJob] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId));
    if (failedJob) {
      await recordEvent(buildJobCompletionEvent(failedJob));
    }
  }
}

// Note: getCompressionPreview, getCompressionPreviewBatch, and getRevertPreview
// were moved to ./preview-actions.ts so callers don't pull in googleapis.

// ---------------------------------------------------------------------------
// Revert Compression — restore originals from Drive revision history
// ---------------------------------------------------------------------------

const REVERT_BATCH_SIZE = 10;

export async function revertCompression(
  deploymentId: number,
): Promise<ActionResult<{ jobId: number }>> {
  const user = await requirePermission("camera-trap", "admin");

  try {
    await requireDeploymentAccess(user, deploymentId);

    const [deployment] = await db
      .select()
      .from(deployments)
      .where(eq(deployments.id, deploymentId));

    if (!deployment) {
      return { success: false, error: "Instalación no encontrada" };
    }

    if (deployment.status === "processing") {
      return { success: false, error: "No se puede revertir mientras se está procesando" };
    }

    // Check for already-active revert or compression job
    const [existingJob] = await db
      .select()
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.deploymentId, deploymentId),
          inArray(processingJobs.jobType, ["compression", "revert_compression"]),
          inArray(processingJobs.status, ["pending", "processing"]),
        ),
      );

    if (existingJob) {
      return { success: false, error: "Ya hay una compresión o reversión en curso" };
    }

    // Count revertible images
    const revertible = await db
      .select({ cnt: count() })
      .from(images)
      .where(
        and(
          eq(images.deploymentId, deploymentId),
          eq(images.compressed, true),
          sql`${images.originalFileSize} IS NOT NULL`,
          sql`${images.driveFileId} IS NOT NULL`,
        ),
      );

    const revertCount = revertible[0]?.cnt ?? 0;
    if (revertCount === 0) {
      return { success: false, error: "No hay imágenes para revertir" };
    }

    const [job] = await db
      .insert(processingJobs)
      .values({
        deploymentId,
        jobType: "revert_compression",
        status: "pending",
        totalImages: revertCount,
        processedImages: 0,
        failedImages: 0,
        createdBy: user.email,
        statusMessage: "Preparando reversión...",
      })
      .returning();

    // Hand off to the unified queue picker.
    processNextQueueable();

    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: { jobId: job.id } };
  } catch (err) {
    log.error({ err }, "[revert] Enqueue failed");
    return {
      success: false,
      error: err instanceof Error ? err.message : "Error al iniciar reversión",
    };
  }
}

export async function revertJobInternal(
  jobId: number,
  deploymentId: number,
  userEmail: string,
): Promise<void> {
  const startTime = Date.now();

  try {
    // Atomic claim + start event; refresh the status message either way.
    await claimAndEmitStart(jobId);
    await db
      .update(processingJobs)
      .set({ statusMessage: "Revirtiendo compresión..." })
      .where(
        and(
          eq(processingJobs.id, jobId),
          eq(processingJobs.status, "processing"),
        ),
      );

    const revertibleImages = await db
      .select()
      .from(images)
      .where(
        and(
          eq(images.deploymentId, deploymentId),
          eq(images.compressed, true),
          sql`${images.originalFileSize} IS NOT NULL`,
          sql`${images.driveFileId} IS NOT NULL`,
        ),
      );

    let reverted = 0;
    let failed = 0;
    const totalBatches = Math.ceil(revertibleImages.length / REVERT_BATCH_SIZE);

    log.info({ deploymentId, count: revertibleImages.length }, "[revert] Deployment starting");

    for (let i = 0; i < revertibleImages.length; i += REVERT_BATCH_SIZE) {
      const batchNum = Math.floor(i / REVERT_BATCH_SIZE) + 1;
      const batch = revertibleImages.slice(i, i + REVERT_BATCH_SIZE);

      // Check if job was cancelled
      const [currentJob] = await db
        .select({ status: processingJobs.status })
        .from(processingJobs)
        .where(eq(processingJobs.id, jobId));

      if (currentJob?.status === "cancelled") {
        log.info({ deploymentId }, "[revert] Deployment cancelled by user");
        return;
      }

      const results = await Promise.allSettled(
        batch.map(async (img) => {
          const sharp = (await import("sharp")).default;

          // Get revisions — we need at least 2 (original + compressed)
          const revisions = await getFileRevisions(img.driveFileId!);
          if (revisions.length < 2) {
            throw new Error(`Only ${revisions.length} revision(s) — no pre-compression original`);
          }

          // Take second-to-last revision (the pre-compression original)
          const originalRevision = revisions[revisions.length - 2];
          const originalBuffer = await downloadFileRevision(img.driveFileId!, originalRevision.id);

          // Validate the restored file is a valid image
          const meta = await sharp(originalBuffer).metadata();
          if (!meta.width || !meta.height) {
            throw new Error("Restored revision is not a valid image");
          }

          // Upload restored original back to Drive
          await updateFileContent(img.driveFileId!, originalBuffer, "image/jpeg");

          // Delete cached/thumbnail files
          const cachePath = img.path || path.join(CACHE_BASE, String(deploymentId), img.filename);
          try { await fs.unlink(cachePath); } catch { /* may not exist */ }
          const tp = thumbPath(deploymentId, img.id);
          try { await fs.unlink(tp); } catch { /* may not exist */ }

          // Update DB: reset compressed state
          await db
            .update(images)
            .set({
              compressed: false,
              fileSize: originalBuffer.length,
              originalFileSize: null,
            })
            .where(eq(images.id, img.id));

          log.info({ filename: img.filename, sizeMb: +(originalBuffer.length / (1024 * 1024)).toFixed(1) }, "[revert] restored");
        }),
      );

      for (const result of results) {
        if (result.status === "fulfilled") {
          reverted++;
        } else {
          log.error({ err: result.reason }, "[revert] FAILED");
          failed++;
        }
      }

      const processedSoFar = reverted + failed;
      await db
        .update(processingJobs)
        .set({
          processedImages: processedSoFar,
          failedImages: failed,
          statusMessage: `Revirtiendo... ${processedSoFar} de ${revertibleImages.length}`,
        })
        .where(eq(processingJobs.id, jobId));

      const batchElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const revertRate = processedSoFar / ((Date.now() - startTime) / 1000);
      const revertEtaSec = revertRate > 0 ? ((revertibleImages.length - processedSoFar) / revertRate).toFixed(0) : "?";
      const revertRssMB = (process.memoryUsage.rss() / (1024 * 1024)).toFixed(0);
      log.info(
        {
          deploymentId,
          batchNum,
          totalBatches,
          processed: processedSoFar,
          total: revertibleImages.length,
          batchElapsed,
          etaSec: revertEtaSec,
          rssMB: revertRssMB,
        },
        "[revert] Deployment batch progress"
      );
    }

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(0);

    await db
      .update(processingJobs)
      .set({
        status: "completed",
        completedAt: new Date(),
        processedImages: reverted + failed,
        failedImages: failed,
        statusMessage: `Revertidas: ${reverted}, Errores: ${failed}`,
      })
      .where(eq(processingJobs.id, jobId));

    const [completedJob] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId));
    if (completedJob) {
      await recordEvent(
        buildJobCompletionEvent(completedJob, { reverted, failed }),
      );
    }

    log.info(
      { deploymentId, reverted, failed, elapsedSec },
      "[revert] Deployment complete"
    );
  } catch (err) {
    log.error({ err, deploymentId }, "[revert] Deployment FAILED");

    await db
      .update(processingJobs)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorMessage: err instanceof Error ? err.message : "Error desconocido",
        statusMessage: "Error en reversión",
      })
      .where(eq(processingJobs.id, jobId));

    const [failedJob] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId));
    if (failedJob) {
      await recordEvent(buildJobCompletionEvent(failedJob));
    }
  }
}
