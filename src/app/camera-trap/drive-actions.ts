"use server";

import { db } from "@/db";
import { deployments, images, videos, cameraTrapProjects, activityLog, processingJobs } from "@/db/schema";
import { eq, and, inArray, sql } from "drizzle-orm";
import {
  listDeploymentFolders,
  listMediaRecursive,
  isValidFolderId,
  checkDeploymentUploads,
  downloadFileToBuffer,
  updateFileContent,
} from "@/lib/drive-client";
import { matchOdkDeployments } from "./odk-actions";
import { requirePermission } from "@/lib/auth";
import { getUserCameraTrapProjects, requireDeploymentAccess } from "@/lib/camera-trap-auth";
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

    // INSERT OR IGNORE via onConflictDoNothing on (deploymentId, driveFileId)
    for (const img of media.images) {
      try {
        await db
          .insert(images)
          .values({
            deploymentId,
            filename: img.name,
            driveFileId: img.id,
            fileSize: img.size,
            fileModified: img.modifiedTime
              ? new Date(img.modifiedTime)
              : undefined,
            status: "pending",
          })
          .onConflictDoNothing();
      } catch {
        // Skip duplicates or other insert errors
      }
    }

    // Insert video rows
    for (const vid of media.videos) {
      try {
        await db
          .insert(videos)
          .values({
            deploymentId,
            filename: vid.name,
            driveFileId: vid.id,
            fileSize: vid.size,
            fileModified: vid.modifiedTime
              ? new Date(vid.modifiedTime)
              : undefined,
            status: "pending",
          })
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
        status: "scanned",
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

const COMPRESSION_QUALITY = 85;
const COMPRESSION_BATCH_SIZE = 5;
const CACHE_BASE = path.join(process.cwd(), "data", "cache", "ct-images");
const THUMBNAIL_DIR = path.join(process.cwd(), "data", "thumbnails");

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

async function compressJobInternal(
  jobId: number,
  deploymentId: number,
  userEmail: string,
): Promise<void> {
  const startTime = Date.now();

  try {
    // Mark as processing
    await db
      .update(processingJobs)
      .set({
        status: "processing",
        startedAt: new Date(),
        statusMessage: "Comprimiendo imágenes...",
      })
      .where(eq(processingJobs.id, jobId));

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
    let compressed = 0;
    let failed = 0;
    let savedBytes = 0;
    const totalBatches = Math.ceil(jpegImages.length / COMPRESSION_BATCH_SIZE);

    console.log(`[compress] Deployment ${deploymentId}: starting — ${jpegImages.length} images to compress`);

    for (let i = 0; i < jpegImages.length; i += COMPRESSION_BATCH_SIZE) {
      const batchNum = Math.floor(i / COMPRESSION_BATCH_SIZE) + 1;
      const batch = jpegImages.slice(i, i + COMPRESSION_BATCH_SIZE);

      // Check if job was cancelled
      const [currentJob] = await db
        .select({ status: processingJobs.status })
        .from(processingJobs)
        .where(eq(processingJobs.id, jobId));

      if (currentJob?.status === "cancelled") {
        console.log(`[compress] Deployment ${deploymentId}: cancelled by user`);
        return;
      }

      const results = await Promise.allSettled(
        batch.map(async (img) => {
          const sharp = (await import("sharp")).default;

          let originalBuffer: Buffer;
          const cachePath = img.path || path.join(CACHE_BASE, String(deploymentId), img.filename);

          try {
            originalBuffer = await fs.readFile(cachePath);
          } catch {
            originalBuffer = await downloadFileToBuffer(img.driveFileId!);
          }

          const originalSize = originalBuffer.length;

          const compressedBuffer = await sharp(originalBuffer)
            .jpeg({ quality: COMPRESSION_QUALITY })
            .toBuffer();

          const newSize = compressedBuffer.length;

          if (newSize >= originalSize) {
            await db
              .update(images)
              .set({ compressed: true })
              .where(eq(images.id, img.id));
            return { saved: 0 };
          }

          await updateFileContent(img.driveFileId!, compressedBuffer, "image/jpeg");

          try {
            await fs.mkdir(path.dirname(cachePath), { recursive: true });
            await fs.writeFile(cachePath, compressedBuffer);
          } catch {
            // Cache update is best-effort
          }

          const thumbPath = path.join(THUMBNAIL_DIR, String(deploymentId), `${img.id}.jpg`);
          try {
            await fs.unlink(thumbPath);
          } catch {
            // Thumbnail may not exist
          }

          await db
            .update(images)
            .set({ compressed: true, fileSize: newSize })
            .where(eq(images.id, img.id));

          return { saved: originalSize - newSize };
        }),
      );

      for (const result of results) {
        if (result.status === "fulfilled") {
          compressed++;
          savedBytes += result.value.saved;
        } else {
          console.error("[compress] Image failed:", result.reason);
          failed++;
        }
      }

      const processedSoFar = compressed + failed;
      const savedMB = (savedBytes / (1024 * 1024)).toFixed(1);

      // Update job progress
      await db
        .update(processingJobs)
        .set({
          processedImages: processedSoFar,
          failedImages: failed,
          statusMessage: `Comprimiendo... ${processedSoFar} de ${jpegImages.length}`,
        })
        .where(eq(processingJobs.id, jobId));

      console.log(
        `[compress] Deployment ${deploymentId}: batch ${batchNum}/${totalBatches} — ${processedSoFar}/${jpegImages.length} images, ${savedMB} MB saved so far`
      );
    }

    const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(0);
    const totalSavedMB = (savedBytes / (1024 * 1024)).toFixed(1);

    // Mark completed
    await db
      .update(processingJobs)
      .set({
        status: "completed",
        completedAt: new Date(),
        processedImages: compressed + failed,
        failedImages: failed,
        statusMessage: `Comprimidas: ${compressed}, Omitidas: ${skipped}, Errores: ${failed}, Ahorro: ${totalSavedMB} MB`,
      })
      .where(eq(processingJobs.id, jobId));

    // Activity log
    await db.insert(activityLog).values({
      userEmail,
      action: "compress_images",
      projectId: "camera-trap",
      targetType: "deployment",
      targetId: String(deploymentId),
      details: JSON.stringify({ compressed, skipped, failed, savedBytes }),
    });

    console.log(
      `[compress] Deployment ${deploymentId}: complete — ${compressed} compressed, ${skipped} skipped, ${failed} failed, ${totalSavedMB} MB saved (${elapsedSec}s)`
    );

    revalidatePath(CAMERA_TRAP_PATH);
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

    revalidatePath(CAMERA_TRAP_PATH);
  }
}
