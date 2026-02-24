"use server";

import { requirePermission } from "@/lib/auth";
import { loadSchedule } from "@/lib/sheets-client";
import { fetchSubmissions } from "@/lib/odk-client";
import { BIOCHOCO_PROJECT_ID, BIOCHOCO_FORM_DEPLOY, BIOCHOCO_FORM_RETRIEVE } from "@/lib/odk-constants";
import { getDeploymentStatus } from "@/app/biochoco/overview/types";
import { checkDeploymentUploads, extractFolderId, type UploadStatus } from "@/lib/drive-client";
import type { ScheduleRow } from "@/lib/schedule-types";
import type { ActionResult } from "@/lib/types";
import { db } from "@/db";
import { deployments } from "@/db/schema";
import { eq, isNotNull, sql } from "drizzle-orm";

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
    const [schedule, rawDeploys, rawRetrieves] = await Promise.all([
      loadSchedule(),
      fetchSubmissions<Record<string, unknown>>(BIOCHOCO_PROJECT_ID, BIOCHOCO_FORM_DEPLOY),
      fetchSubmissions<Record<string, unknown>>(BIOCHOCO_PROJECT_ID, BIOCHOCO_FORM_RETRIEVE),
    ]);

    // Extract deployment_ids and actual dates from ODK submissions
    const deployedSet = new Set<string>();
    const deployedDateMap = new Map<string, string>();
    for (const sub of rawDeploys) {
      const sel = sub.site_selection as Record<string, unknown> | undefined;
      const depInfo = sub.deployment_info as Record<string, unknown> | undefined;
      const depId = (sel?.deployment_id as string) ?? (sub.deployment_id as string) ?? "";
      if (!depId) continue;
      deployedSet.add(depId);
      const date = (depInfo?.deploy_date as string) ?? (sel?.fecha_instalacion as string) ?? (sub.fecha_instalacion as string) ?? "";
      if (date) deployedDateMap.set(depId, date.slice(0, 10));
    }

    const retrievedSet = new Set<string>();
    const retrievedDateMap = new Map<string, string>();
    for (const sub of rawRetrieves) {
      const sel = sub.site_selection as Record<string, unknown> | undefined;
      const retInfo = sub.retrieval_info as Record<string, unknown> | undefined;
      const depId = (sel?.deployment_id as string) ?? (sub.deployment_id as string) ?? "";
      if (!depId) continue;
      retrievedSet.add(depId);
      const date = (retInfo?.retrieval_date as string) ?? (sel?.fecha_recuperacion as string) ?? (sub.fecha_recuperacion as string) ?? "";
      if (date) retrievedDateMap.set(depId, date.slice(0, 10));
    }

    // Only show deployments that have actual Drive folders (DB is source of truth)
    const dbWithFolders = await db
      .select({
        name: deployments.name,
        driveFolderId: deployments.driveFolderId,
        uploadCameraCount: deployments.uploadCameraCount,
        uploadAudioCount: deployments.uploadAudioCount,
        uploadIbuttonCount: deployments.uploadIbuttonCount,
        uploadCameraFolderId: deployments.uploadCameraFolderId,
        uploadAudioFolderId: deployments.uploadAudioFolderId,
        uploadIbuttonFolderId: deployments.uploadIbuttonFolderId,
        uploadCountsCheckedAt: deployments.uploadCountsCheckedAt,
      })
      .from(deployments)
      .where(isNotNull(deployments.driveFolderId));

    const folderMap = new Map(
      dbWithFolders.map((d) => [d.name, d])
    );

    const filtered = schedule
      .filter((r) => folderMap.has(r.deploymentId))
      .map((r) => {
        const dbRow = folderMap.get(r.deploymentId)!;
        return {
          ...r,
          actualDeployDate: deployedDateMap.get(r.deploymentId) ?? r.actualDeployDate,
          actualRetrieveDate: retrievedDateMap.get(r.deploymentId) ?? r.actualRetrieveDate,
          status: getDeploymentStatus(r.deploymentId, deployedSet, retrievedSet),
          driveFolderLink: `https://drive.google.com/drive/folders/${dbRow.driveFolderId}`,
          uploadCameraCount: dbRow.uploadCameraCount,
          uploadAudioCount: dbRow.uploadAudioCount,
          uploadIbuttonCount: dbRow.uploadIbuttonCount,
          uploadCameraFolderId: dbRow.uploadCameraFolderId,
          uploadAudioFolderId: dbRow.uploadAudioFolderId,
          uploadIbuttonFolderId: dbRow.uploadIbuttonFolderId,
          uploadCountsCheckedAt: dbRow.uploadCountsCheckedAt
            ? Math.floor(dbRow.uploadCountsCheckedAt.getTime() / 1000)
            : null,
        };
      });

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

/**
 * Refresh Drive upload counts for a single deployment and persist to DB.
 * Called sequentially from the client for ALL deployments during a full refresh.
 */
export async function refreshSingleUploadCount(
  deploymentName: string,
  driveFolderLink: string
): Promise<DriveStatusResult> {
  await requirePermission("biochoco", "viewer");

  const folderId = extractFolderId(driveFolderLink);
  if (!folderId) return { deploymentId: deploymentName, uploads: null };

  const result = await checkDeploymentUploads(folderId);
  if (!result.success) {
    return { deploymentId: deploymentName, uploads: null, error: result.error };
  }

  const uploads = result.data;

  // Persist counts + subfolder IDs to DB
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
    .where(eq(deployments.name, deploymentName));

  return { deploymentId: deploymentName, uploads };
}
