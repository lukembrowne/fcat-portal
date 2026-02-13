"use server";

import { requirePermission } from "@/lib/auth";
import { loadSchedule } from "@/lib/sheets-client";
import { checkDeploymentUploads, extractFolderId, type UploadStatus } from "@/lib/drive-client";
import type { ScheduleRow } from "@/lib/schedule-types";
import type { ActionResult } from "@/lib/types";
import { db } from "@/db";
import { deployments } from "@/db/schema";
import { isNotNull } from "drizzle-orm";

export interface DriveStatusResult {
  deploymentId: string;
  uploads: UploadStatus | null;
  error?: string;
}

/**
 * Check Drive upload status for a single deployment.
 * Called sequentially from the client so progress can be shown per-item.
 */
export async function checkSingleDeployment(
  deploymentId: string,
  driveFolderLink: string
): Promise<DriveStatusResult> {
  await requirePermission("biochoco", "viewer");
  const folderId = extractFolderId(driveFolderLink);
  if (!folderId) return { deploymentId, uploads: null };
  const result = await checkDeploymentUploads(folderId);
  if (!result.success) return { deploymentId, uploads: null, error: result.error };
  return { deploymentId, uploads: result.data };
}

/**
 * Load BioChoco deployments from Google Sheets, filtered to only those
 * that have a Drive folder created (DB driveFolderId is source of truth).
 */
export async function fetchSchedule(): Promise<ActionResult<ScheduleRow[]>> {
  try {
    await requirePermission("biochoco", "viewer");
    const schedule = await loadSchedule();

    // Only show deployments that have actual Drive folders (DB is source of truth)
    const dbWithFolders = await db
      .select({ name: deployments.name, driveFolderId: deployments.driveFolderId })
      .from(deployments)
      .where(isNotNull(deployments.driveFolderId));

    const folderMap = new Map(
      dbWithFolders.map((d) => [d.name, d.driveFolderId!])
    );

    const filtered = schedule
      .filter((r) => folderMap.has(r.deploymentId))
      .map((r) => ({
        ...r,
        driveFolderLink: `https://drive.google.com/drive/folders/${folderMap.get(r.deploymentId)}`,
      }));

    return { success: true, data: filtered };
  } catch (err) {
    console.error("Failed to load schedule:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : "Error desconocido",
    };
  }
}

/**
 * Check Drive upload status for a batch of deployments.
 * Called on-demand for the currently visible page only.
 */
export async function checkDriveForDeployments(
  deployments: { deploymentId: string; driveFolderLink: string }[]
): Promise<ActionResult<DriveStatusResult[]>> {
  try {
    await requirePermission("biochoco", "viewer");

    const CONCURRENCY = 10;
    const results: DriveStatusResult[] = [];

    for (let i = 0; i < deployments.length; i += CONCURRENCY) {
      const batch = deployments.slice(i, i + CONCURRENCY);

      const batchResults = await Promise.allSettled(
        batch.map(async ({ deploymentId, driveFolderLink }): Promise<DriveStatusResult> => {
          const folderId = extractFolderId(driveFolderLink);

          if (!folderId) {
            return { deploymentId, uploads: null };
          }

          const result = await checkDeploymentUploads(folderId);

          if (!result.success) {
            return { deploymentId, uploads: null, error: result.error };
          }

          return { deploymentId, uploads: result.data };
        })
      );

      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j];
        if (result.status === "fulfilled") {
          results.push(result.value);
        } else {
          results.push({
            deploymentId: batch[j].deploymentId,
            uploads: null,
            error: "Error inesperado al verificar carpeta",
          });
        }
      }
    }

    return { success: true, data: results };
  } catch (err) {
    console.error("Failed to check Drive status:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : "Error desconocido",
    };
  }
}
