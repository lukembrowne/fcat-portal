"use server";

import { requirePermission } from "@/lib/auth";
import { fetchEntities, fetchSubmissions } from "@/lib/odk-client";
import {
  BIOCHOCO_PROJECT_ID,
  BIOCHOCO_DATASET_SITES,
  BIOCHOCO_FORM_DEPLOY,
  BIOCHOCO_FORM_RETRIEVE,
} from "@/lib/odk-constants";
import type { OdkSiteEntity } from "@/lib/odk-types";
import { loadSchedule, updateScheduleRows } from "@/lib/sheets-client";
import { createDeploymentFolder, resolveFolderDriveId } from "@/lib/drive-client";
import { db } from "@/db";
import { deployments, cameraTrapProjects } from "@/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/types";
import { log } from "@/lib/log";
import { recordEvent } from "@/lib/system-events";
import {
  sharedDriveRoutingEnabled,
  selectAndReserveSlot,
  releaseReservation,
  attachReservationToDeployment,
  getDriveStatus,
  getDriveById,
  getDriveByDriveId,
  type SelectionSuccess,
} from "@/lib/shared-drives";

// ─── Types ───────────────────────────────────────────────────

export interface MissingDeployment {
  deploymentId: string;
  odkSubmissionId: string;
  siteId: string;
  siteName: string | null;
  latitude: number | null;
  longitude: number | null;
  dateInstalled: string | null;
  dateRetrieved: string | null;
  status: "scheduled" | "deployed" | "retrieved";
  inSchedule: boolean;
}

export interface FolderResult {
  deploymentId: string;
  success: boolean;
  folderId?: string;
  folderLink?: string;
  error?: string;
}

// ─── Helpers ─────────────────────────────────────────────────

interface ParsedSubmission {
  id: string;
  deploymentId: string;
  siteId: string;
  dateInstalled: string | null;
}

function parseDeploySubmissions(
  rawSubmissions: Record<string, unknown>[]
): ParsedSubmission[] {
  return rawSubmissions
    .map((sub) => {
      const sel = sub.site_selection as Record<string, unknown> | undefined;
      const deployId =
        (sel?.deployment_id as string) ??
        (sub.deployment_id as string) ??
        "";
      const siteId =
        (sel?.site_id as string) ?? (sub.site_id as string) ?? "";
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
    .filter((s) => s.deploymentId && !s.deploymentId.startsWith("_"));
}

function buildSiteMap(
  rawSites: OdkSiteEntity[]
): Map<string, { name: string; lat: number | null; lng: number | null }> {
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
  return siteMap;
}

// ─── Shared data fetching ────────────────────────────────────

async function fetchOdkDeploymentData() {
  const [rawSubmissions, rawRetrieves, rawSites, schedule] = await Promise.all([
    fetchSubmissions<Record<string, unknown>>(
      BIOCHOCO_PROJECT_ID,
      BIOCHOCO_FORM_DEPLOY
    ),
    fetchSubmissions<Record<string, unknown>>(
      BIOCHOCO_PROJECT_ID,
      BIOCHOCO_FORM_RETRIEVE
    ),
    fetchEntities<OdkSiteEntity>(
      BIOCHOCO_PROJECT_ID,
      BIOCHOCO_DATASET_SITES
    ),
    loadSchedule(),
  ]);

  const siteMap = buildSiteMap(rawSites);
  const submissions = parseDeploySubmissions(rawSubmissions);
  const submissionMap = new Map<string, ParsedSubmission>();
  for (const sub of submissions) {
    submissionMap.set(sub.deploymentId, sub);
  }
  const scheduleSet = new Set(schedule.map((r) => r.deploymentId));

  // Build retrieve date map from retrieve submissions
  const retrievedDateMap = new Map<string, string>();
  for (const sub of rawRetrieves) {
    const sel = sub.site_selection as Record<string, unknown> | undefined;
    const retInfo = sub.retrieval_info as Record<string, unknown> | undefined;
    const depId = (sel?.deployment_id as string) ?? (sub.deployment_id as string) ?? "";
    if (!depId) continue;
    const date = (retInfo?.retrieval_date as string) ?? (sel?.fecha_recuperacion as string) ?? (sub.fecha_recuperacion as string) ?? "";
    if (date) retrievedDateMap.set(depId, date.slice(0, 10));
  }

  return { siteMap, submissions, submissionMap, schedule, scheduleSet, retrievedDateMap };
}

// ─── Actions ─────────────────────────────────────────────────

/**
 * Find ODK instalar_sensores submissions that don't have Drive folders yet.
 */
export async function getMissingDriveFolders(): Promise<
  ActionResult<MissingDeployment[]>
> {
  try {
    await requirePermission("biochoco", "editor");

    const { siteMap, submissions, scheduleSet: scheduleDeploymentIds, retrievedDateMap } =
      await fetchOdkDeploymentData();

    // Check DB for deployments with driveFolderId set (source of truth)
    const dbDeploymentsAll = await db
      .select({ name: deployments.name, driveFolderId: deployments.driveFolderId })
      .from(deployments);

    const dbWithFolder = new Set(
      dbDeploymentsAll
        .filter((d) => d.driveFolderId)
        .map((d) => d.name)
    );

    // Deduplicate submissions by deploymentId, keeping latest
    const uniqueSubmissions = new Map<string, ParsedSubmission>();
    for (const sub of submissions) {
      uniqueSubmissions.set(sub.deploymentId, sub);
    }

    // Filter to only those missing Drive folders
    const missing: MissingDeployment[] = [];
    for (const sub of uniqueSubmissions.values()) {
      if (dbWithFolder.has(sub.deploymentId)) {
        continue;
      }

      const site = siteMap.get(sub.siteId);
      const dateRetrieved = retrievedDateMap.get(sub.deploymentId) ?? null;
      const status = dateRetrieved ? "retrieved" : sub.dateInstalled ? "deployed" : "scheduled";
      missing.push({
        deploymentId: sub.deploymentId,
        odkSubmissionId: sub.id,
        siteId: sub.siteId,
        siteName: site?.name ?? null,
        latitude: site?.lat ?? null,
        longitude: site?.lng ?? null,
        dateInstalled: sub.dateInstalled?.slice(0, 10) ?? null,
        dateRetrieved,
        status,
        inSchedule: scheduleDeploymentIds.has(sub.deploymentId),
      });
    }

    missing.sort((a, b) => a.deploymentId.localeCompare(b.deploymentId));

    return { success: true, data: missing };
  } catch (err) {
    log.error({ err }, "[Drive Folders] Failed to find missing folders");
    return {
      success: false,
      error: err instanceof Error ? err.message : "Error al buscar instalaciones sin carpeta",
    };
  }
}

/**
 * Create a single Drive folder for one deployment.
 * Called sequentially from the client for progress reporting.
 */
export async function createSingleDriveFolder(
  deploymentId: string
): Promise<FolderResult> {
  try {
    await requirePermission("biochoco", "editor");

    // Look up "BioChoco" CT project for Drive folder ID
    const [bioChocoProject] = await db
      .select({ id: cameraTrapProjects.id, driveFolderId: cameraTrapProjects.driveFolderId })
      .from(cameraTrapProjects)
      .where(eq(cameraTrapProjects.name, "BioChoco"));

    const legacyRoot = bioChocoProject?.driveFolderId ?? process.env.CAMERA_TRAP_ROOT_FOLDER_ID;

    // Resolve the parent folder. When routing is enabled, pick + reserve a
    // slot on the fullest-but-eligible Shared Drive; otherwise use the legacy
    // env/project root. Routing failures are loud (recorded as error events).
    let rootFolderId: string;
    let reservation: SelectionSuccess | null = null;
    let sharedDriveId: string | null = null;

    if (sharedDriveRoutingEnabled()) {
      if (!bioChocoProject?.id) {
        return {
          deploymentId,
          success: false,
          error: "El proyecto BioChoco no existe en la base de datos.",
        };
      }
      const sel = selectAndReserveSlot(bioChocoProject.id);
      if ("error" in sel) {
        await recordEvent({
          source: "shared-drives",
          eventType: `deployment_folder_create_${sel.error}`,
          severity: "error",
          summary: `Creación de carpeta sin capacidad (${deploymentId})`,
          targetType: "ct_project",
          targetId: bioChocoProject?.id ?? null,
          details: { deploymentId },
        });
        return {
          deploymentId,
          success: false,
          error:
            sel.error === "no_capacity"
              ? "Sin capacidad disponible. Notifica al administrador para aprovisionar un nuevo drive."
              : "No hay Shared Drives activos configurados. Notifica al administrador.",
        };
      }
      // TOCTOU: an admin may have flipped the drive to read-only between the
      // reservation and now — re-check before committing a Drive write.
      if (getDriveStatus(sel.sharedDriveId) !== "active") {
        releaseReservation(sel.reservationId);
        await recordEvent({
          source: "shared-drives",
          eventType: "reservation_aborted_status_changed",
          severity: "warn",
          summary: `Reserva abortada (${deploymentId}): el drive cambió de estado`,
          targetType: "shared_drive",
          targetId: sel.sharedDriveId,
        });
        return {
          deploymentId,
          success: false,
          error: "El drive seleccionado cambió de estado. Intenta de nuevo.",
        };
      }
      rootFolderId = sel.rootFolderId;
      reservation = sel;
      sharedDriveId = sel.sharedDriveId;
    } else {
      if (!legacyRoot) {
        return {
          deploymentId,
          success: false,
          error: "La carpeta de Drive del proyecto BioChoco no está configurada.",
        };
      }
      rootFolderId = legacyRoot;
    }

    const { siteMap, submissionMap, scheduleSet } =
      await fetchOdkDeploymentData();

    const sub = submissionMap.get(deploymentId);
    if (!sub) {
      if (reservation) releaseReservation(reservation.reservationId);
      return {
        deploymentId,
        success: false,
        error: "Instalación no encontrada en ODK",
      };
    }

    const site = siteMap.get(sub.siteId);

    // Create Drive folder + subfolders. On failure, release the reservation.
    let folder: Awaited<ReturnType<typeof createDeploymentFolder>>;
    try {
      folder = await createDeploymentFolder(rootFolderId, deploymentId);
    } catch (err) {
      if (reservation) releaseReservation(reservation.reservationId);
      throw err;
    }

    // When routing is OFF the folder is still created inside a Shared Drive but
    // sharedDriveId is null — stamp it so the deployment is routable (the field
    // uploader needs the host drive's 0A id). Resolve the new folder's real
    // drive and match the registry. Best-effort; a null leaves it backfillable.
    if (!sharedDriveId) {
      try {
        const driveId = await resolveFolderDriveId(folder.id);
        if (driveId) sharedDriveId = (await getDriveByDriveId(driveId))?.id ?? null;
      } catch (err) {
        log.warn({ err, deploymentId }, "[Drive Folders] could not resolve shared drive for new folder");
      }
    }

    // Update Sheets schedule if the deployment exists there
    if (scheduleSet.has(deploymentId)) {
      try {
        await updateScheduleRows([
          {
            deploymentId,
            fields: { driveFolderLink: folder.webViewLink },
          },
        ]);
      } catch (err) {
        log.error(
          { err, deploymentId },
          "[Drive Folders] Failed to update sheet"
        );
      }
    }

    // Insert DB deployment row (onConflictDoNothing for safety)
    try {
      await db
        .insert(deployments)
        .values({
          projectId: "camera-trap",
          cameraTrapProjectId: bioChocoProject?.id ?? null,
          projectLabel: "BioChoco",
          name: deploymentId,
          driveFolderId: folder.id,
          sharedDriveId,
          siteName: site?.name ?? null,
          latitude: site?.lat ?? null,
          longitude: site?.lng ?? null,
          dateStart: sub.dateInstalled?.slice(0, 10) ?? null,
          odkSubmissionId: sub.id,
          metadataSource: "odk",
          status: "unscanned",
          // Save subfolder IDs and initial counts at creation time
          uploadCameraFolderId: folder.subfolderIds.camarasTrampas,
          uploadAudioFolderId: folder.subfolderIds.grabadoresDeAudio,
          uploadIbuttonFolderId: folder.subfolderIds.ibutton,
          uploadCalibrationFolderId: folder.subfolderIds.calibracionDeAudio,
          uploadCameraCount: 0,
          uploadAudioCount: 0,
          uploadIbuttonCount: 0,
          uploadCalibrationCount: 0,
          uploadCountsCheckedAt: new Date(),
        })
        .onConflictDoNothing();

      // Best-effort: link the reservation to the deployment row for audit.
      // (Reconcile absorbs reservations by timestamp, not by this link.)
      if (reservation) {
        const [row] = await db
          .select({ id: deployments.id })
          .from(deployments)
          .where(eq(deployments.name, deploymentId))
          .limit(1);
        if (row) attachReservationToDeployment(reservation.reservationId, row.id);
      }
    } catch (err) {
      log.error(
        { err, deploymentId },
        "[Drive Folders] Failed to insert DB row"
      );
    }

    revalidatePath("/biochoco/data");
    revalidatePath("/camera-trap");

    return {
      deploymentId,
      success: true,
      folderId: folder.id,
      folderLink: folder.webViewLink,
    };
  } catch (err) {
    log.error(
      { err, deploymentId },
      "[Drive Folders] Failed to create folder"
    );
    return {
      deploymentId,
      success: false,
      error: err instanceof Error ? err.message : "Error desconocido",
    };
  }
}

/**
 * Recreate a Drive folder for a deployment whose folder was trashed/deleted.
 * Similar to createSingleDriveFolder but UPDATEs the existing DB row.
 */
export async function recreateDriveFolder(
  deploymentId: string
): Promise<FolderResult> {
  try {
    await requirePermission("biochoco", "editor");

    // Look up "BioChoco" CT project for Drive folder ID
    const [bioChocoProject] = await db
      .select({ driveFolderId: cameraTrapProjects.driveFolderId })
      .from(cameraTrapProjects)
      .where(eq(cameraTrapProjects.name, "BioChoco"));

    const legacyRoot = bioChocoProject?.driveFolderId ?? process.env.CAMERA_TRAP_ROOT_FOLDER_ID;

    // Recreate under the SAME drive the deployment already lives on (if known),
    // so an existing deployment is never scattered across drives. No new
    // reservation: the deployment was already counted; reconcile trues up.
    const [existingDep] = await db
      .select({ sharedDriveId: deployments.sharedDriveId })
      .from(deployments)
      .where(eq(deployments.name, deploymentId))
      .limit(1);

    let rootFolderId = legacyRoot;
    if (existingDep?.sharedDriveId) {
      const drive = await getDriveById(existingDep.sharedDriveId);
      if (drive) rootFolderId = drive.rootFolderId;
    }
    if (!rootFolderId) {
      return {
        deploymentId,
        success: false,
        error: "La carpeta de Drive del proyecto BioChoco no está configurada.",
      };
    }

    const { scheduleSet } = await fetchOdkDeploymentData();

    // Create new Drive folder + subfolders
    const folder = await createDeploymentFolder(rootFolderId, deploymentId);

    // Update Sheets schedule if the deployment exists there
    if (scheduleSet.has(deploymentId)) {
      try {
        await updateScheduleRows([
          {
            deploymentId,
            fields: { driveFolderLink: folder.webViewLink },
          },
        ]);
      } catch (err) {
        log.error(
          { err, deploymentId },
          "[Drive Folders] Failed to update sheet"
        );
      }
    }

    // Update existing DB row with new folder ID and subfolder IDs
    try {
      await db
        .update(deployments)
        .set({
          driveFolderId: folder.id,
          uploadCameraFolderId: folder.subfolderIds.camarasTrampas,
          uploadAudioFolderId: folder.subfolderIds.grabadoresDeAudio,
          uploadIbuttonFolderId: folder.subfolderIds.ibutton,
          uploadCalibrationFolderId: folder.subfolderIds.calibracionDeAudio,
          uploadCameraCount: 0,
          uploadAudioCount: 0,
          uploadIbuttonCount: 0,
          uploadCalibrationCount: 0,
          uploadCountsCheckedAt: new Date(),
        })
        .where(eq(deployments.name, deploymentId));
    } catch (err) {
      log.error(
        { err, deploymentId },
        "[Drive Folders] Failed to update DB row"
      );
    }

    revalidatePath("/biochoco/data");
    revalidatePath("/camera-trap");

    return {
      deploymentId,
      success: true,
      folderId: folder.id,
      folderLink: folder.webViewLink,
    };
  } catch (err) {
    log.error(
      { err, deploymentId },
      "[Drive Folders] Failed to recreate folder"
    );
    return {
      deploymentId,
      success: false,
      error: err instanceof Error ? err.message : "Error desconocido",
    };
  }
}
