"use server";

import { requirePermission } from "@/lib/auth";
import { loadSchedule } from "@/lib/sheets-client";
import { checkDeploymentUploads, extractFolderId, type UploadStatus } from "@/lib/drive-client";
import type { ScheduleRow } from "@/lib/schedule-types";
import type { ActionResult } from "@/lib/types";

export interface DriveStatusResult {
  deploymentId: string;
  uploads: UploadStatus | null;
  error?: string;
}

/**
 * Load all BioChoco deployments from Google Sheets (no Drive checks).
 */
export async function fetchSchedule(): Promise<ActionResult<ScheduleRow[]>> {
  try {
    await requirePermission("biochoco", "viewer");
    const schedule = await loadSchedule();
    return { success: true, data: schedule };
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
