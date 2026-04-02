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
import { deployments, uploadCountSnapshots } from "@/db/schema";
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
        uploadNewestCameraDate: deployments.uploadNewestCameraDate,
        uploadNewestAudioDate: deployments.uploadNewestAudioDate,
        uploadNewestIbuttonDate: deployments.uploadNewestIbuttonDate,
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
          uploadNewestDate: [
            dbRow.uploadNewestCameraDate,
            dbRow.uploadNewestAudioDate,
            dbRow.uploadNewestIbuttonDate,
          ]
            .filter(Boolean)
            .sort()
            .pop() ?? null,
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

  // Persist counts, sizes, newest dates, and subfolder IDs to DB
  await db
    .update(deployments)
    .set({
      uploadCameraCount: uploads.camarasTrampas,
      uploadAudioCount: uploads.grabadoresDeAudio,
      uploadIbuttonCount: uploads.ibutton,
      uploadCameraSizeBytes: uploads.camarasTrampasSizeBytes,
      uploadAudioSizeBytes: uploads.grabadoresDeAudioSizeBytes,
      uploadIbuttonSizeBytes: uploads.ibuttonSizeBytes,
      uploadNewestCameraDate: uploads.camarasTrampasNewestDate,
      uploadNewestAudioDate: uploads.grabadoresDeAudioNewestDate,
      uploadNewestIbuttonDate: uploads.ibuttonNewestDate,
      uploadCameraFolderId: uploads.subfolderIds.camarasTrampas,
      uploadAudioFolderId: uploads.subfolderIds.grabadoresDeAudio,
      uploadIbuttonFolderId: uploads.subfolderIds.ibutton,
      uploadCountsCheckedAt: sql`(unixepoch())`,
    })
    .where(eq(deployments.name, deploymentName));

  return { deploymentId: deploymentName, uploads };
}

/**
 * Save a daily snapshot of aggregate upload counts.
 * Called after "Actualizar Conteo" finishes refreshing all deployments.
 */
export async function saveUploadSnapshot(): Promise<void> {
  await requirePermission("biochoco", "viewer");

  const today = new Date().toISOString().slice(0, 10);

  const rows = await db
    .select({
      uploadCameraCount: deployments.uploadCameraCount,
      uploadAudioCount: deployments.uploadAudioCount,
      uploadIbuttonCount: deployments.uploadIbuttonCount,
      uploadCameraSizeBytes: deployments.uploadCameraSizeBytes,
      uploadAudioSizeBytes: deployments.uploadAudioSizeBytes,
      uploadIbuttonSizeBytes: deployments.uploadIbuttonSizeBytes,
    })
    .from(deployments)
    .where(isNotNull(deployments.driveFolderId));

  let totalCameras = 0;
  let totalAudio = 0;
  let totalIbutton = 0;
  let totalCameraSizeBytes = 0;
  let totalAudioSizeBytes = 0;
  let totalIbuttonSizeBytes = 0;
  let deploymentsWithUploads = 0;

  for (const r of rows) {
    const cam = r.uploadCameraCount ?? 0;
    const aud = r.uploadAudioCount ?? 0;
    const ibt = r.uploadIbuttonCount ?? 0;
    totalCameras += cam;
    totalAudio += aud;
    totalIbutton += ibt;
    totalCameraSizeBytes += r.uploadCameraSizeBytes ?? 0;
    totalAudioSizeBytes += r.uploadAudioSizeBytes ?? 0;
    totalIbuttonSizeBytes += r.uploadIbuttonSizeBytes ?? 0;
    if (cam > 0 || aud > 0 || ibt > 0) deploymentsWithUploads++;
  }

  await db
    .insert(uploadCountSnapshots)
    .values({
      date: today,
      totalCameras,
      totalAudio,
      totalIbutton,
      totalCameraSizeBytes,
      totalAudioSizeBytes,
      totalIbuttonSizeBytes,
      deploymentsWithUploads,
      totalDeployments: rows.length,
    })
    .onConflictDoUpdate({
      target: uploadCountSnapshots.date,
      set: {
        totalCameras,
        totalAudio,
        totalIbutton,
        totalCameraSizeBytes,
        totalAudioSizeBytes,
        totalIbuttonSizeBytes,
        deploymentsWithUploads,
        totalDeployments: rows.length,
        createdAt: sql`(unixepoch())`,
      },
    });
}

export interface UploadSummary {
  cameras: number;
  audio: number;
  ibutton: number;
  cameraSizeBytes: number;
  audioSizeBytes: number;
  ibuttonSizeBytes: number;
  deltaCameras: number | null;
  deltaAudio: number | null;
  deltaIbutton: number | null;
  deltaCameraSizeBytes: number | null;
  deltaAudioSizeBytes: number | null;
  deltaIbuttonSizeBytes: number | null;
  previousSnapshotDate: string | null;
}

/**
 * Fetch live upload totals and previous snapshot for delta display.
 */
export async function fetchUploadSummary(): Promise<UploadSummary> {
  await requirePermission("biochoco", "viewer");

  const rows = await db
    .select({
      uploadCameraCount: deployments.uploadCameraCount,
      uploadAudioCount: deployments.uploadAudioCount,
      uploadIbuttonCount: deployments.uploadIbuttonCount,
      uploadCameraSizeBytes: deployments.uploadCameraSizeBytes,
      uploadAudioSizeBytes: deployments.uploadAudioSizeBytes,
      uploadIbuttonSizeBytes: deployments.uploadIbuttonSizeBytes,
    })
    .from(deployments)
    .where(isNotNull(deployments.driveFolderId));

  let cameras = 0;
  let audio = 0;
  let ibutton = 0;
  let cameraSizeBytes = 0;
  let audioSizeBytes = 0;
  let ibuttonSizeBytes = 0;

  for (const r of rows) {
    cameras += r.uploadCameraCount ?? 0;
    audio += r.uploadAudioCount ?? 0;
    ibutton += r.uploadIbuttonCount ?? 0;
    cameraSizeBytes += r.uploadCameraSizeBytes ?? 0;
    audioSizeBytes += r.uploadAudioSizeBytes ?? 0;
    ibuttonSizeBytes += r.uploadIbuttonSizeBytes ?? 0;
  }

  // Get previous snapshot for delta comparison
  const today = new Date().toISOString().slice(0, 10);
  const previousSnapshots = await db
    .select()
    .from(uploadCountSnapshots)
    .where(sql`${uploadCountSnapshots.date} < ${today}`)
    .orderBy(sql`${uploadCountSnapshots.date} DESC`)
    .limit(1);

  const prev = previousSnapshots[0] ?? null;

  return {
    cameras,
    audio,
    ibutton,
    cameraSizeBytes,
    audioSizeBytes,
    ibuttonSizeBytes,
    deltaCameras: prev ? cameras - prev.totalCameras : null,
    deltaAudio: prev ? audio - prev.totalAudio : null,
    deltaIbutton: prev ? ibutton - prev.totalIbutton : null,
    deltaCameraSizeBytes: prev ? cameraSizeBytes - prev.totalCameraSizeBytes : null,
    deltaAudioSizeBytes: prev ? audioSizeBytes - prev.totalAudioSizeBytes : null,
    deltaIbuttonSizeBytes: prev ? ibuttonSizeBytes - prev.totalIbuttonSizeBytes : null,
    previousSnapshotDate: prev ? prev.date : null,
  };
}
