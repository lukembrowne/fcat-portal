"use server";

import { db } from "@/db";
import { deployments, images } from "@/db/schema";
import { eq } from "drizzle-orm";
import {
  listDeploymentFolders,
  listImagesRecursive,
  isValidFolderId,
  type DriveFolder,
} from "@/lib/drive-client";
import { requirePermission } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/types";
import type { Deployment } from "@/db/schema";

const CAMERA_TRAP_PATH = "/camera-trap";

// ---------------------------------------------------------------------------
// Discover deployment folders from Google Drive
// ---------------------------------------------------------------------------

export async function discoverDeployments(): Promise<
  ActionResult<{ known: Deployment[]; discovered: DriveFolder[] }>
> {
  await requirePermission("camera-trap", "viewer");

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

    const known = existingDeployments.filter(
      (d) => d.driveFolderId && knownFolderIds.has(d.driveFolderId)
    );
    const discovered = driveFolders.filter((f) => !knownFolderIds.has(f.id));

    return { success: true, data: { known, discovered } };
  } catch (err) {
    console.error("[Drive] Discovery failed:", err);
    const message =
      err instanceof Error ? err.message : "Error al buscar carpetas en Drive";
    return { success: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Activate a Drive folder as a deployment
// ---------------------------------------------------------------------------

export async function activateDeployment(
  folderId: string,
  folderName: string,
  metadata?: {
    latitude?: number;
    longitude?: number;
    dateStart?: string;
    dateEnd?: string;
  }
): Promise<ActionResult<{ deploymentId: number }>> {
  const user = await requirePermission("camera-trap", "editor");

  if (!isValidFolderId(folderId)) {
    return { success: false, error: "ID de carpeta inválido" };
  }

  if (!folderName.trim()) {
    return { success: false, error: "El nombre es requerido" };
  }

  try {
    const [deployment] = await db
      .insert(deployments)
      .values({
        projectId: "camera-trap",
        name: folderName.trim(),
        driveFolderId: folderId,
        latitude: metadata?.latitude,
        longitude: metadata?.longitude,
        dateStart: metadata?.dateStart,
        dateEnd: metadata?.dateEnd,
        totalImages: 0,
        status: "unscanned",
        createdBy: user.email,
      })
      .returning();

    revalidatePath(CAMERA_TRAP_PATH);
    return { success: true, data: { deploymentId: deployment.id } };
  } catch (err) {
    // Catch unique constraint violation
    if (
      err instanceof Error &&
      err.message.includes("UNIQUE constraint failed")
    ) {
      return {
        success: false,
        error: "Esta carpeta ya está registrada como instalación",
      };
    }

    console.error("[Drive] Activation failed:", err);
    return {
      success: false,
      error:
        err instanceof Error ? err.message : "Error al activar instalación",
    };
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
