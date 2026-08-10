import "server-only";

import { db } from "@/db";
import { deployments, images, videos } from "@/db/schema";
import { eq, inArray, sql } from "drizzle-orm";
import { checkDeploymentUploads, listMediaRecursive } from "@/lib/drive-client";
import { fetchEntities, fetchSubmissions } from "@/lib/odk-client";
import {
  BIOCHOCO_PROJECT_ID,
  BIOCHOCO_DATASET_SITES,
  BIOCHOCO_FORM_DEPLOY,
  BIOCHOCO_FORM_RETRIEVE,
} from "@/lib/odk-constants";
import type { OdkSiteEntity } from "@/lib/odk-types";
import type { Deployment } from "@/db/schema";
import { recordEvent } from "@/lib/system-events";
import { log } from "@/lib/log";

interface OdkMatch {
  deploymentId: number;
  deploymentName: string;
  odkSubmissionId: string;
  odkDeploymentId: string;
  siteName: string | null;
  latitude: number | null;
  longitude: number | null;
  dateStart: string | null;
}

export interface MatchResult {
  matched: OdkMatch[];
  unmatched: string[];
}

/** Normalize a string for fuzzy matching: lowercase, strip whitespace and common separators. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s_\-\.]+/g, "")
    .trim();
}

/**
 * Scan a deployment's Drive folder for images + videos and insert any
 * new rows into the DB. Caller is responsible for authorization.
 *
 * Idempotent — uses onConflictDoNothing on (deploymentId, driveFileId).
 */
export async function scanDeploymentImagesInternal(
  deployment: Deployment
): Promise<{ imageCount: number; videoCount: number }> {
  if (!deployment.driveFolderId) {
    return { imageCount: 0, videoCount: 0 };
  }

  const media = await listMediaRecursive(deployment.driveFolderId);

  const IMG_INSERT_BATCH = 100;
  for (let i = 0; i < media.images.length; i += IMG_INSERT_BATCH) {
    const batch = media.images.slice(i, i + IMG_INSERT_BATCH);
    try {
      await db
        .insert(images)
        .values(
          batch.map((img) => ({
            deploymentId: deployment.id,
            filename: img.name,
            driveFileId: img.id,
            fileSize: img.size,
            fileModified: img.modifiedTime ? new Date(img.modifiedTime) : undefined,
            status: "pending" as const,
          }))
        )
        .onConflictDoNothing();
    } catch (err) {
      log.warn({ err, deploymentId: deployment.id }, "[sync] Image batch insert skipped");
    }
  }

  const VID_INSERT_BATCH = 100;
  for (let i = 0; i < media.videos.length; i += VID_INSERT_BATCH) {
    const batch = media.videos.slice(i, i + VID_INSERT_BATCH);
    try {
      await db
        .insert(videos)
        .values(
          batch.map((vid) => ({
            deploymentId: deployment.id,
            filename: vid.name,
            driveFileId: vid.id,
            fileSize: vid.size,
            fileModified: vid.modifiedTime ? new Date(vid.modifiedTime) : undefined,
            status: "pending" as const,
          }))
        )
        .onConflictDoNothing();
    } catch (err) {
      log.warn({ err, deploymentId: deployment.id }, "[sync] Video batch insert skipped");
    }
  }

  const totalImageRows = await db
    .select({ id: images.id })
    .from(images)
    .where(eq(images.deploymentId, deployment.id));

  const totalVideoRows = await db
    .select({ id: videos.id })
    .from(videos)
    .where(eq(videos.deploymentId, deployment.id));

  // A terminal "sin datos" deployment is revived if a scan finds files —
  // that safety net is what makes the manual mark low-risk.
  const revivedFromNoData =
    deployment.status === "no_data" &&
    totalImageRows.length + totalVideoRows.length > 0;

  await db
    .update(deployments)
    .set({
      totalImages: totalImageRows.length,
      totalVideos: totalVideoRows.length,
      ...(deployment.status === "unscanned" || revivedFromNoData
        ? { status: "scanned" as const }
        : {}),
      updatedAt: new Date(),
    })
    .where(eq(deployments.id, deployment.id));

  if (revivedFromNoData) {
    await recordEvent({
      source: "camera-trap",
      eventType: "unmark_deployment_no_data",
      severity: "warn",
      summary: `Instalación ${deployment.name} reabierta para procesar (archivos encontrados en Drive)`,
      actorEmail: null,
      projectId: "camera-trap",
      targetType: "deployment",
      targetId: deployment.id,
      details: {
        name: deployment.name,
        from: "no_data",
        to: "scanned",
        trigger: "auto",
        imageCount: totalImageRows.length,
        videoCount: totalVideoRows.length,
      },
    });
  }

  return { imageCount: totalImageRows.length, videoCount: totalVideoRows.length };
}

/**
 * Refresh upload-count fields (camera/audio/ibutton totals + sizes + newest dates)
 * for a single deployment. Caller is responsible for authorization.
 */
export async function refreshUploadCountsInternal(
  deployment: Deployment
): Promise<{ ok: boolean; error?: string }> {
  if (!deployment.driveFolderId) {
    return { ok: false, error: "Deployment has no Drive folder" };
  }

  const result = await checkDeploymentUploads(deployment.driveFolderId);
  if (!result.success) {
    return { ok: false, error: result.error };
  }

  const u = result.data;
  await db
    .update(deployments)
    .set({
      uploadCameraCount: u.camarasTrampas,
      uploadAudioCount: u.grabadoresDeAudio,
      uploadIbuttonCount: u.ibutton,
      uploadCalibrationCount: u.calibracionDeAudio ?? null,
      uploadCameraSizeBytes: u.camarasTrampasSizeBytes,
      uploadAudioSizeBytes: u.grabadoresDeAudioSizeBytes,
      uploadIbuttonSizeBytes: u.ibuttonSizeBytes,
      uploadCalibrationSizeBytes: u.calibracionDeAudioSizeBytes ?? null,
      uploadNewestCameraDate: u.camarasTrampasNewestDate,
      uploadNewestAudioDate: u.grabadoresDeAudioNewestDate,
      uploadNewestIbuttonDate: u.ibuttonNewestDate,
      uploadNewestCalibrationDate: u.calibracionDeAudioNewestDate ?? null,
      uploadCameraFolderId: u.subfolderIds.camarasTrampas,
      uploadAudioFolderId: u.subfolderIds.grabadoresDeAudio,
      uploadIbuttonFolderId: u.subfolderIds.ibutton,
      uploadCalibrationFolderId: u.subfolderIds.calibracionDeAudio ?? null,
      uploadCountsCheckedAt: sql`(unixepoch())`,
    })
    .where(eq(deployments.id, deployment.id));

  return { ok: true };
}

/**
 * Decide whether an ODK-derived retrieval date should be written to a
 * deployment's `date_end`. ODK is the authoritative source for retrieval dates,
 * so a corrected retrieve_sensors submission must be able to overwrite an
 * existing (wrong) value — a plain fill-null guard froze bad dates forever. The
 * one exception is a manual edit: never clobber a value the user set by hand.
 *
 *  - no retrieval, or it already matches → nothing to do
 *  - date_end is null → fill it (any source)
 *  - date_end set + source is `manual` → preserve the user's edit
 *  - date_end set + source is odk/auto → overwrite with the newer ODK value
 */
export function shouldUpdateDateEnd(
  dep: { dateEnd: string | null; metadataSource: string | null },
  retrieval: string | undefined,
): retrieval is string {
  if (!retrieval || retrieval === dep.dateEnd) return false;
  if (dep.dateEnd == null) return true;
  return dep.metadataSource !== "manual";
}

/**
 * Match deployments against ODK install/retrieve submissions. Fills NULL fields,
 * and propagates a changed ODK retrieval date to `date_end` unless it was set
 * manually (see {@link shouldUpdateDateEnd}). Caller is responsible for
 * authorization.
 */
export async function matchOdkDeploymentsInternal(
  deploymentIds: number[]
): Promise<MatchResult> {
  if (deploymentIds.length === 0) {
    return { matched: [], unmatched: [] };
  }

  const deploymentsToMatch = await db
    .select()
    .from(deployments)
    .where(inArray(deployments.id, deploymentIds));

  const [rawSubmissions, rawSites, rawRetrievals] = await Promise.all([
    fetchSubmissions<Record<string, unknown>>(BIOCHOCO_PROJECT_ID, BIOCHOCO_FORM_DEPLOY),
    fetchEntities<OdkSiteEntity>(BIOCHOCO_PROJECT_ID, BIOCHOCO_DATASET_SITES),
    fetchSubmissions<Record<string, unknown>>(BIOCHOCO_PROJECT_ID, BIOCHOCO_FORM_RETRIEVE),
  ]);

  const siteMap = new Map<
    string,
    { name: string; lat: number | null; lng: number | null }
  >();
  for (const site of rawSites) {
    siteMap.set(site.site_id, {
      name: site.site_name ?? site.label ?? "",
      lat: site.latitude ? parseFloat(String(site.latitude)) : null,
      lng: site.longitude ? parseFloat(String(site.longitude)) : null,
    });
  }

  interface ParsedSubmission {
    id: string;
    deploymentId: string;
    siteId: string;
    dateInstalled: string | null;
  }

  const submissions: ParsedSubmission[] = rawSubmissions
    .map((sub) => {
      const sel = sub.site_selection as Record<string, unknown> | undefined;
      const deployId =
        (sel?.deployment_id as string) ?? (sub.deployment_id as string) ?? "";
      const siteId = (sel?.site_id as string) ?? (sub.site_id as string) ?? "";
      const depInfo = sub.deployment_info as Record<string, unknown> | undefined;
      const dateInstalled =
        (depInfo?.deploy_date as string) ??
        (sel?.fecha_instalacion as string) ??
        (sub.fecha_instalacion as string) ??
        null;
      return {
        id: sub.__id as string,
        deploymentId: deployId,
        siteId,
        dateInstalled,
      };
    })
    .filter((s) => s.deploymentId);

  const submissionMap = new Map<string, ParsedSubmission>();
  for (const sub of submissions) {
    submissionMap.set(normalize(sub.deploymentId), sub);
  }

  const retrievalMap = new Map<string, string>();
  for (const sub of rawRetrievals) {
    const sel = sub.site_selection as Record<string, unknown> | undefined;
    const depId =
      (sel?.deployment_id as string) ?? (sub.deployment_id as string) ?? "";
    const retInfo = sub.retrieval_info as Record<string, unknown> | undefined;
    const dateRetrieved =
      (retInfo?.retrieval_date as string) ??
      (sel?.fecha_recuperacion as string) ??
      (sub.fecha_recuperacion as string) ??
      null;
    if (!depId || !dateRetrieved) continue;
    const key = normalize(depId);
    const existing = retrievalMap.get(key);
    if (!existing || dateRetrieved > existing) {
      retrievalMap.set(key, dateRetrieved.slice(0, 10));
    }
  }

  const matched: OdkMatch[] = [];
  const unmatched: string[] = [];

  for (const dep of deploymentsToMatch) {
    const normalizedName = normalize(dep.name);
    const sub = submissionMap.get(normalizedName);

    if (!sub) {
      const retrieval = retrievalMap.get(normalizedName);
      if (shouldUpdateDateEnd(dep, retrieval)) {
        const retUpdates: Record<string, unknown> = {
          dateEnd: retrieval,
          updatedAt: new Date(),
        };
        if (dep.metadataSource !== "manual") {
          retUpdates.metadataSource = "odk";
        }
        await db.update(deployments).set(retUpdates).where(eq(deployments.id, dep.id));
      }
      unmatched.push(dep.name);
      continue;
    }

    const site = siteMap.get(sub.siteId);

    matched.push({
      deploymentId: dep.id,
      deploymentName: dep.name,
      odkSubmissionId: sub.id,
      odkDeploymentId: sub.deploymentId,
      siteName: site?.name ?? null,
      latitude: site?.lat ?? null,
      longitude: site?.lng ?? null,
      dateStart: sub.dateInstalled,
    });

    const updates: Record<string, unknown> = {
      odkSubmissionId: sub.id,
      updatedAt: new Date(),
    };
    if (dep.metadataSource !== "manual") {
      updates.metadataSource = "odk";
    }
    if (!dep.siteName && site?.name) updates.siteName = site.name;
    if (dep.latitude == null && site?.lat != null) updates.latitude = site.lat;
    if (dep.longitude == null && site?.lng != null) updates.longitude = site.lng;
    if (!dep.dateStart && sub.dateInstalled) updates.dateStart = sub.dateInstalled;

    const retrieval = retrievalMap.get(normalizedName);
    // Propagate the ODK retrieval date, not just fill a null. retrieve_sensors is
    // submitted (and often corrected) AFTER the install match runs, so a fill-null
    // guard left a wrong-but-non-null date_end frozen forever (REF-001: stuck at
    // the install date until a re-link). ODK is authoritative for odk-sourced rows,
    // so overwrite when it differs — but never clobber a manual edit.
    if (shouldUpdateDateEnd(dep, retrieval)) {
      updates.dateEnd = retrieval;
    }

    await db.update(deployments).set(updates).where(eq(deployments.id, dep.id));
  }

  log.info(
    { matched: matched.length, unmatched: unmatched.length },
    "[odk-match] Done"
  );

  return { matched, unmatched };
}
