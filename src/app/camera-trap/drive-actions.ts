"use server";

import { db } from "@/db";
import { deployments, images } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  listDeploymentFolders,
  listImagesRecursive,
  isValidFolderId,
} from "@/lib/drive-client";
import { requirePermission } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/types";
import type { Deployment } from "@/db/schema";

const CAMERA_TRAP_PATH = "/camera-trap";

// ---------------------------------------------------------------------------
// Sync with Google Drive — auto-create deployment rows for new folders
// ---------------------------------------------------------------------------

export async function syncWithDrive(): Promise<
  ActionResult<{ created: Deployment[]; existing: Deployment[]; errors: string[] }>
> {
  const user = await requirePermission("camera-trap", "editor");

  const rootFolderId = process.env.CAMERA_TRAP_ROOT_FOLDER_ID;
  if (!rootFolderId) {
    return {
      success: false,
      error:
        "CAMERA_TRAP_ROOT_FOLDER_ID no está configurado. Contacte al administrador.",
    };
  }

  try {
    const driveFolders = await listDeploymentFolders(rootFolderId);

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
    const newFolders = driveFolders.filter((f) => !knownFolderIds.has(f.id));

    // Auto-create deployment rows for new folders
    const created: Deployment[] = [];
    const errors: string[] = [];

    for (const folder of newFolders) {
      if (!isValidFolderId(folder.id)) {
        errors.push(`ID de carpeta inválido: ${folder.name}`);
        continue;
      }

      try {
        const [deployment] = await db
          .insert(deployments)
          .values({
            projectId: "camera-trap",
            name: folder.name.trim(),
            driveFolderId: folder.id,
            totalImages: 0,
            status: "unscanned",
            metadataSource: "drive",
            createdBy: user.email,
          })
          .returning();

        created.push(deployment);
      } catch (err) {
        // Unique constraint = already exists (race condition with another sync)
        if (
          err instanceof Error &&
          err.message.includes("UNIQUE constraint failed")
        ) {
          continue;
        }
        errors.push(
          `Error al crear ${folder.name}: ${err instanceof Error ? err.message : "Error desconocido"}`
        );
      }
    }

    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: { created, existing, errors } };
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
  await requirePermission("camera-trap", "editor");

  try {
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

    const driveImages = await listImagesRecursive(deployment.driveFolderId);

    // INSERT OR IGNORE via onConflictDoNothing on (deploymentId, driveFileId)
    for (const img of driveImages) {
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

    // Update deployment totals and status
    const totalImages = await db
      .select({ id: images.id })
      .from(images)
      .where(eq(images.deploymentId, deploymentId));

    await db
      .update(deployments)
      .set({
        totalImages: totalImages.length,
        status: "scanned",
        updatedAt: new Date(),
      })
      .where(eq(deployments.id, deploymentId));

    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: { imageCount: totalImages.length } };
  } catch (err) {
    console.error("[Drive] Scan failed:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : "Error al escanear imágenes",
    };
  }
}
