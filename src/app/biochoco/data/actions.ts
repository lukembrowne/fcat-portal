"use server";

import { requirePermission } from "@/lib/auth";
import { loadSchedule } from "@/lib/sheets-client";
import { checkDeploymentUploads, extractFolderId, type UploadStatus } from "@/lib/drive-client";
import type { ScheduleRow } from "@/lib/schedule-types";
import type { ActionResult } from "@/lib/types";

export interface DataStatusRow {
  deployment: ScheduleRow;
  uploads: UploadStatus | null; // null = no Drive link
  error?: string;
}

/**
 * Fetch data upload status for all retrieved BioChoco deployments.
 *
 * Loads the schedule from Google Sheets, filters to retrieved deployments,
 * then checks Google Drive for upload status per data type.
 */
export async function fetchDataStatus(): Promise<ActionResult<DataStatusRow[]>> {
  try {
    await requirePermission("biochoco", "viewer");

    const schedule = await loadSchedule();

    // Only check retrieved deployments — scheduled/deployed won't have data yet
    const retrieved = schedule.filter((row) => row.status === "retrieved");

    // Check Drive uploads with concurrency limit
    const CONCURRENCY = 10;
    const results: DataStatusRow[] = [];

    for (let i = 0; i < retrieved.length; i += CONCURRENCY) {
      const batch = retrieved.slice(i, i + CONCURRENCY);

      const batchResults = await Promise.allSettled(
        batch.map(async (deployment): Promise<DataStatusRow> => {
          const folderId = extractFolderId(deployment.driveFolderLink);

          if (!folderId) {
            return { deployment, uploads: null };
          }

          const result = await checkDeploymentUploads(folderId);

          if (!result.success) {
            return { deployment, uploads: null, error: result.error };
          }

          return { deployment, uploads: result.data };
        })
      );

      for (let j = 0; j < batchResults.length; j++) {
        const result = batchResults[j];
        if (result.status === "fulfilled") {
          results.push(result.value);
        } else {
          // Shouldn't happen since errors are caught inside, but handle gracefully
          results.push({
            deployment: batch[j],
            uploads: null,
            error: "Error inesperado al verificar carpeta",
          });
        }
      }
    }

    return { success: true, data: results };
  } catch (err) {
    console.error("Failed to fetch data status:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : "Error desconocido",
    };
  }
}
