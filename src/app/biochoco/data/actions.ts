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
import {
  deployments,
  uploadCountSnapshots,
  images,
  audioFiles,
  ibuttonUploads,
} from "@/db/schema";
import { eq, isNotNull, inArray, sql } from "drizzle-orm";
import { loadOdkDateTimes } from "@/lib/odk-deployment-window";
import {
  computeWindowQc,
  type WindowQcResult,
} from "@/lib/deployment-window-qc";
import {
  computeCoverage,
  type CoverageResult,
} from "@/app/biochoco/ibutton/coverage";

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
        fieldNotes: deployments.fieldNotes,
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
          fieldNotes: dbRow.fieldNotes,
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

// ---------------------------------------------------------------------------
// ODK deployment-window QC for camera-trap & audio uploads
// ---------------------------------------------------------------------------

export interface DeploymentWindowQc {
  /** Camera-trap image timestamp range vs ODK install/retrieve window. */
  camera: WindowQcResult;
  /** Audio recording timestamp range vs ODK install/retrieve window. */
  audio: WindowQcResult;
  /** iButton coverage % computed from sample rate vs ODK window.
   *  Null when there is no iButton upload for this deployment yet. */
  ibutton: CoverageResult | null;
}

export type WindowQcByDeployment = Record<string, DeploymentWindowQc>;

/**
 * For every BioChoco deployment with a Drive folder, compare the actual
 * camera-trap image timestamps and audio file timestamps against the
 * ODK-reported install/retrieve window. Used by the upload status table to
 * flag deployments where files fall outside the deployment window — a sign
 * the camera was running before install / after retrieval, or has a
 * misconfigured clock.
 *
 * The result is keyed by deployment **name** (e.g. "SEC-006_V1") so the
 * upload status table can join it against `ScheduleRow.deploymentId`.
 */
export async function fetchUploadWindowQc(): Promise<
  ActionResult<WindowQcByDeployment>
> {
  try {
    await requirePermission("biochoco", "viewer");

    // Pull every biochoco deployment that has a Drive folder. We need both
    // the integer DB id (to join file tables) and the deployment name (to
    // key the result map and look up ODK windows).
    const deps = await db
      .select({ id: deployments.id, name: deployments.name })
      .from(deployments)
      .where(isNotNull(deployments.driveFolderId));

    if (deps.length === 0) return { success: true, data: {} };

    const deploymentIds = deps.map((d) => d.id);

    // Image timestamp range per deployment. EXIF is already a local-time
    // string ("YYYY-MM-DD HH:mm:ss"); file_modified is epoch seconds and
    // gets converted to Ecuador local (UTC-5) so both branches share a
    // single comparable string format.
    const imageTsExpr = sql<
      string | null
    >`COALESCE(${images.exifTimestamp}, strftime('%Y-%m-%d %H:%M:%S', ${images.fileModified}, 'unixepoch', '-5 hours'))`;
    const imageRanges = await db
      .select({
        deploymentId: images.deploymentId,
        firstAt: sql<string | null>`MIN(${imageTsExpr})`,
        lastAt: sql<string | null>`MAX(${imageTsExpr})`,
        cnt: sql<number>`COUNT(*)`,
      })
      .from(images)
      .where(inArray(images.deploymentId, deploymentIds))
      .groupBy(images.deploymentId);
    const imageRangeMap = new Map<
      number,
      { firstAt: string | null; lastAt: string | null; cnt: number }
    >();
    for (const r of imageRanges) {
      imageRangeMap.set(r.deploymentId, r);
    }

    // Audio file timestamp range per deployment. modifiedAt is epoch seconds.
    const audioTsExpr = sql<
      string | null
    >`strftime('%Y-%m-%d %H:%M:%S', ${audioFiles.modifiedAt}, 'unixepoch', '-5 hours')`;
    const audioRanges = await db
      .select({
        deploymentId: audioFiles.deploymentId,
        firstAt: sql<string | null>`MIN(${audioTsExpr})`,
        lastAt: sql<string | null>`MAX(${audioTsExpr})`,
        cnt: sql<number>`COUNT(*)`,
      })
      .from(audioFiles)
      .where(inArray(audioFiles.deploymentId, deploymentIds))
      .groupBy(audioFiles.deploymentId);
    const audioRangeMap = new Map<
      number,
      { firstAt: string | null; lastAt: string | null; cnt: number }
    >();
    for (const r of audioRanges) {
      audioRangeMap.set(r.deploymentId, r);
    }

    // iButton uploads — one row per processed deployment, with the sample
    // rate and row count needed to compute the same coverage % shown on
    // /biochoco/ibutton. Readings are pre-truncated to the ODK window at
    // ingest, so a simple in/out check is uninformative; we report coverage
    // % instead.
    const ibuttonRows = await db
      .select({
        deploymentId: ibuttonUploads.deploymentId,
        sampleRate: ibuttonUploads.sampleRate,
        rowsImported: ibuttonUploads.rowsImported,
        dateRangeStart: ibuttonUploads.dateRangeStart,
        dateRangeEnd: ibuttonUploads.dateRangeEnd,
      })
      .from(ibuttonUploads)
      .where(inArray(ibuttonUploads.deploymentId, deploymentIds));
    const ibuttonUploadMap = new Map<number, (typeof ibuttonRows)[number]>();
    for (const r of ibuttonRows) {
      ibuttonUploadMap.set(r.deploymentId, r);
    }

    // ODK install/retrieve windows. Fail-soft: an ODK outage must not break
    // the data page — fall back to empty maps and the QC will simply report
    // hasWindow=false everywhere.
    let deployDtMap = new Map<string, { dt: string; timeKnown: boolean }>();
    let retrieveDtMap = new Map<string, { dt: string; timeKnown: boolean }>();
    try {
      const maps = await loadOdkDateTimes();
      deployDtMap = maps.deployDateTimeMap;
      retrieveDtMap = maps.retrieveDateTimeMap;
    } catch (err) {
      console.warn("[biochoco/data] loadOdkDateTimes failed:", err);
    }

    const byName: WindowQcByDeployment = {};
    for (const dep of deps) {
      const odkDeployAt = deployDtMap.get(dep.name)?.dt ?? null;
      const odkRetrieveAt = retrieveDtMap.get(dep.name)?.dt ?? null;
      const imgRange = imageRangeMap.get(dep.id);
      const audRange = audioRangeMap.get(dep.id);
      const ibUpload = ibuttonUploadMap.get(dep.id);

      byName[dep.name] = {
        camera: computeWindowQc({
          odkDeployAt,
          odkRetrieveAt,
          firstFileAt: imgRange?.firstAt ?? null,
          lastFileAt: imgRange?.lastAt ?? null,
          totalFiles: imgRange?.cnt ?? 0,
          outsideCount: null,
        }),
        audio: computeWindowQc({
          odkDeployAt,
          odkRetrieveAt,
          firstFileAt: audRange?.firstAt ?? null,
          lastFileAt: audRange?.lastAt ?? null,
          totalFiles: audRange?.cnt ?? 0,
          outsideCount: null,
        }),
        ibutton: ibUpload
          ? computeCoverage({
              odkDeployAt,
              odkRetrieveAt,
              sampleRate: ibUpload.sampleRate,
              rowsImported: ibUpload.rowsImported,
              dateRangeStart: ibUpload.dateRangeStart,
              dateRangeEnd: ibUpload.dateRangeEnd,
            })
          : null,
      };
    }

    return { success: true, data: byName };
  } catch (err) {
    console.error("Failed to compute window QC:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : "Error desconocido",
    };
  }
}
