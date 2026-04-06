"use server";

import { db } from "@/db";
import { deployments, images, videos, cameraTrapProjects, activityLog, processingJobs } from "@/db/schema";
import { eq, and, inArray, sql, count, sum } from "drizzle-orm";
import {
  listDeploymentFolders,
  listMediaRecursive,
  isValidFolderId,
  checkDeploymentUploads,
  downloadFileToBuffer,
  updateFileContent,
  getFileRevisions,
  downloadFileRevision,
} from "@/lib/drive-client";
import { matchOdkDeployments } from "./odk-actions";
import { requirePermission } from "@/lib/auth";
import { getUserCameraTrapProjects, requireDeploymentAccess } from "@/lib/camera-trap-auth";
import { touchAppState } from "@/lib/app-state";
import { CAMERA_TRAP_DRIVE_LAST_SYNC_KEY } from "@/lib/app-state-keys";
import { revalidatePath } from "next/cache";
import path from "path";
import { promises as fs } from "fs";
import type { ActionResult } from "@/lib/types";
import type { Deployment } from "@/db/schema";

const CAMERA_TRAP_PATH = "/camera-trap";

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
      const driveFolders = await listDeploymentFolders(proj.driveFolderId);
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
        console.error(`[Drive] Auto-scan failed for ${dep.name}:`, err);
        allErrors.push(`Error al escanear ${dep.name}: ${err instanceof Error ? err.message : "Error desconocido"}`);
      }
    }

    // Auto-match with ODK to recover site, lat/lng, dates
    if (allCreated.length > 0) {
      try {
        await matchOdkDeployments(allCreated.map((d) => d.id));
      } catch (err) {
        console.error("[Drive] Auto ODK match failed:", err);
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
          console.error(`[Drive] Upload count refresh failed for ${dep.name}:`, err);
        }
      }
    }

    await touchAppState(CAMERA_TRAP_DRIVE_LAST_SYNC_KEY);
    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: { created: allCreated, existing, errors: allErrors } };
  } catch (err) {
    console.error("[Drive] Sync failed:", err);
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

    const media = await listMediaRecursive(deployment.driveFolderId);

    // Batch insert images (groups of 100) with onConflictDoNothing
    const IMG_INSERT_BATCH = 100;
    for (let i = 0; i < media.images.length; i += IMG_INSERT_BATCH) {
      const batch = media.images.slice(i, i + IMG_INSERT_BATCH);
      try {
        await db
          .insert(images)
          .values(
            batch.map((img) => ({
              deploymentId,
              filename: img.name,
              driveFileId: img.id,
              fileSize: img.size,
              fileModified: img.modifiedTime
                ? new Date(img.modifiedTime)
                : undefined,
              status: "pending" as const,
            }))
          )
          .onConflictDoNothing();
      } catch {
        // Skip duplicates or other insert errors
      }
    }

    // Batch insert videos (groups of 100) with onConflictDoNothing
    const VID_INSERT_BATCH = 100;
    for (let i = 0; i < media.videos.length; i += VID_INSERT_BATCH) {
      const batch = media.videos.slice(i, i + VID_INSERT_BATCH);
      try {
        await db
          .insert(videos)
          .values(
            batch.map((vid) => ({
              deploymentId,
              filename: vid.name,
              driveFileId: vid.id,
              fileSize: vid.size,
              fileModified: vid.modifiedTime
                ? new Date(vid.modifiedTime)
                : undefined,
              status: "pending" as const,
            }))
          )
          .onConflictDoNothing();
      } catch {
        // Skip duplicates or other insert errors
      }
    }

    // Update deployment totals and status
    const totalImageRows = await db
      .select({ id: images.id })
      .from(images)
      .where(eq(images.deploymentId, deploymentId));

    const totalVideoRows = await db
      .select({ id: videos.id })
      .from(videos)
      .where(eq(videos.deploymentId, deploymentId));

    await db
      .update(deployments)
      .set({
        totalImages: totalImageRows.length,
        totalVideos: totalVideoRows.length,
        ...(deployment.status === "unscanned" ? { status: "scanned" as const } : {}),
        updatedAt: new Date(),
      })
      .where(eq(deployments.id, deploymentId));

    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: { imageCount: totalImageRows.length } };
  } catch (err) {
    console.error("[Drive] Scan failed:", err);
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

    // Fire and forget
    compressJobInternal(job.id, deploymentId, user.email);

    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: { jobId: job.id } };
  } catch (err) {
    console.error("[compress] Enqueue failed:", err);
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
      console.log(`[compress] Deployment ${options.deploymentId}: cancelled by user`);
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
        console.error("[compress]   FAILED:", result.reason);
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
    console.log(
      `[compress] Deployment ${options.deploymentId}: batch ${batchNum}/${totalBatches} — ${processedSoFar}/${imgs.length} (${batchSec}s batch, ${totalElapsed}s total, ~${etaSec}s remaining, ${savedMB} MB saved, RSS: ${rssMB}MB)`
    );

    if (onProgress) {
      await onProgress(compressed, failed, savedBytes);
    }
  }

  return { compressed, failed, savedBytes };
}

async function compressJobInternal(
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

    // Mark as processing with count
    await db
      .update(processingJobs)
      .set({
        status: "processing",
        startedAt: new Date(),
        statusMessage: `Comprimiendo... 0 de ${jpegImages.length}`,
      })
      .where(eq(processingJobs.id, jobId));

    console.log(`[compress] Deployment ${deploymentId}: starting — ${jpegImages.length} images to compress`);

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

    // Activity log
    await db.insert(activityLog).values({
      userEmail,
      action: "compress_images",
      projectId: "camera-trap",
      targetType: "deployment",
      targetId: String(deploymentId),
      details: JSON.stringify({ compressed: result.compressed, skipped, failed: result.failed, savedBytes: result.savedBytes }),
    });

    console.log(
      `[compress] Deployment ${deploymentId}: complete — ${result.compressed} compressed, ${skipped} skipped, ${result.failed} failed, ${totalSavedMB} MB saved (${elapsedSec}s)`
    );
  } catch (err) {
    console.error(`[compress] Deployment ${deploymentId}: FAILED —`, err);

    await db
      .update(processingJobs)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorMessage: err instanceof Error ? err.message : "Error desconocido",
        statusMessage: "Error en compresión",
      })
      .where(eq(processingJobs.id, jobId));
  }
}

// ---------------------------------------------------------------------------
// Compression Preview (read-only stats for confirmation dialog)
// ---------------------------------------------------------------------------

export async function getCompressionPreview(
  deploymentId: number,
): Promise<ActionResult<{ count: number; totalSizeMB: number }>> {
  await requirePermission("camera-trap", "admin");

  const result = await db
    .select({
      cnt: count(),
      totalSize: sum(images.fileSize),
    })
    .from(images)
    .where(
      and(
        eq(images.deploymentId, deploymentId),
        eq(images.compressed, false),
        sql`${images.driveFileId} IS NOT NULL`,
        sql`lower(${images.filename}) LIKE '%.jpg' OR lower(${images.filename}) LIKE '%.jpeg'`,
      ),
    );

  const row = result[0];
  return {
    success: true,
    data: {
      count: row?.cnt ?? 0,
      totalSizeMB: Math.round(((row?.totalSize as number | null) ?? 0) / (1024 * 1024) * 10) / 10,
    },
  };
}

// ---------------------------------------------------------------------------
// Compression Preview — batch (aggregate stats across multiple deployments)
// ---------------------------------------------------------------------------

export async function getCompressionPreviewBatch(
  deploymentIds: number[],
): Promise<ActionResult<{ count: number; totalSizeMB: number }>> {
  await requirePermission("camera-trap", "admin");

  if (deploymentIds.length === 0) {
    return { success: true, data: { count: 0, totalSizeMB: 0 } };
  }

  const result = await db
    .select({
      cnt: count(),
      totalSize: sum(images.fileSize),
    })
    .from(images)
    .where(
      and(
        inArray(images.deploymentId, deploymentIds),
        eq(images.compressed, false),
        sql`${images.driveFileId} IS NOT NULL`,
        sql`lower(${images.filename}) LIKE '%.jpg' OR lower(${images.filename}) LIKE '%.jpeg'`,
      ),
    );

  const row = result[0];
  return {
    success: true,
    data: {
      count: row?.cnt ?? 0,
      totalSizeMB: Math.round(((row?.totalSize as number | null) ?? 0) / (1024 * 1024) * 10) / 10,
    },
  };
}

// ---------------------------------------------------------------------------
// Revert Preview (read-only stats for confirmation dialog)
// ---------------------------------------------------------------------------

export async function getRevertPreview(
  deploymentId: number,
): Promise<ActionResult<{ count: number; savedMB: number }>> {
  await requirePermission("camera-trap", "admin");

  const result = await db
    .select({
      cnt: count(),
      totalOriginal: sum(images.originalFileSize),
      totalCurrent: sum(images.fileSize),
    })
    .from(images)
    .where(
      and(
        eq(images.deploymentId, deploymentId),
        eq(images.compressed, true),
        sql`${images.originalFileSize} IS NOT NULL`,
        sql`${images.driveFileId} IS NOT NULL`,
      ),
    );

  const row = result[0];
  const origTotal = (row?.totalOriginal as number | null) ?? 0;
  const curTotal = (row?.totalCurrent as number | null) ?? 0;
  return {
    success: true,
    data: {
      count: row?.cnt ?? 0,
      savedMB: Math.round((origTotal - curTotal) / (1024 * 1024) * 10) / 10,
    },
  };
}

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

    // Fire and forget
    revertJobInternal(job.id, deploymentId, user.email);

    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: { jobId: job.id } };
  } catch (err) {
    console.error("[revert] Enqueue failed:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : "Error al iniciar reversión",
    };
  }
}

async function revertJobInternal(
  jobId: number,
  deploymentId: number,
  userEmail: string,
): Promise<void> {
  const startTime = Date.now();

  try {
    await db
      .update(processingJobs)
      .set({
        status: "processing",
        startedAt: new Date(),
        statusMessage: "Revirtiendo compresión...",
      })
      .where(eq(processingJobs.id, jobId));

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

    console.log(`[revert] Deployment ${deploymentId}: starting — ${revertibleImages.length} images to revert`);

    for (let i = 0; i < revertibleImages.length; i += REVERT_BATCH_SIZE) {
      const batchNum = Math.floor(i / REVERT_BATCH_SIZE) + 1;
      const batch = revertibleImages.slice(i, i + REVERT_BATCH_SIZE);

      // Check if job was cancelled
      const [currentJob] = await db
        .select({ status: processingJobs.status })
        .from(processingJobs)
        .where(eq(processingJobs.id, jobId));

      if (currentJob?.status === "cancelled") {
        console.log(`[revert] Deployment ${deploymentId}: cancelled by user`);
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

          console.log(`[revert]   ${img.filename}: restored (${(originalBuffer.length / (1024 * 1024)).toFixed(1)}MB)`);
        }),
      );

      for (const result of results) {
        if (result.status === "fulfilled") {
          reverted++;
        } else {
          console.error("[revert]   FAILED:", result.reason);
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
      console.log(
        `[revert] Deployment ${deploymentId}: batch ${batchNum}/${totalBatches} — ${processedSoFar}/${revertibleImages.length} (${batchElapsed}s total, ~${revertEtaSec}s remaining, RSS: ${revertRssMB}MB)`
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

    await db.insert(activityLog).values({
      userEmail,
      action: "revert_compression",
      projectId: "camera-trap",
      targetType: "deployment",
      targetId: String(deploymentId),
      details: JSON.stringify({ reverted, failed }),
    });

    console.log(
      `[revert] Deployment ${deploymentId}: complete — ${reverted} reverted, ${failed} failed (${elapsedSec}s)`
    );
  } catch (err) {
    console.error(`[revert] Deployment ${deploymentId}: FAILED —`, err);

    await db
      .update(processingJobs)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorMessage: err instanceof Error ? err.message : "Error desconocido",
        statusMessage: "Error en reversión",
      })
      .where(eq(processingJobs.id, jobId));
  }
}
