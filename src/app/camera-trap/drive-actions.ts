"use server";

import { db } from "@/db";
import { deployments, images, videos, cameraTrapProjects } from "@/db/schema";
import { eq, and, inArray } from "drizzle-orm";
import {
  listDeploymentFolders,
  listMediaRecursive,
  isValidFolderId,
} from "@/lib/drive-client";
import { requirePermission } from "@/lib/auth";
import { getUserCameraTrapProjects, requireDeploymentAccess } from "@/lib/camera-trap-auth";
import { revalidatePath } from "next/cache";
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
