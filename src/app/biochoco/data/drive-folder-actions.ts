"use server";

import { requirePermission } from "@/lib/auth";
import { fetchEntities, fetchSubmissions } from "@/lib/odk-client";
import {
  BIOCHOCO_PROJECT_ID,
  BIOCHOCO_DATASET_SITES,
  BIOCHOCO_FORM_DEPLOY,
} from "@/lib/odk-constants";
import type { OdkSiteEntity } from "@/lib/odk-types";
import { loadSchedule, updateScheduleRows } from "@/lib/sheets-client";
import { createDeploymentFolder } from "@/lib/drive-client";
import { db } from "@/db";
import { deployments, cameraTrapProjects } from "@/db/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/types";

// ─── Types ───────────────────────────────────────────────────

export interface MissingDeployment {
  deploymentId: string;
  odkSubmissionId: string;
  siteId: string;
  siteName: string | null;
  latitude: number | null;
  longitude: number | null;
  dateInstalled: string | null;
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
  const [rawSubmissions, rawSites, schedule] = await Promise.all([
    fetchSubmissions<Record<string, unknown>>(
      BIOCHOCO_PROJECT_ID,
      BIOCHOCO_FORM_DEPLOY
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

  return { siteMap, submissions, submissionMap, schedule, scheduleSet };
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

    const { siteMap, submissions, scheduleSet: scheduleDeploymentIds } =
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
      missing.push({
        deploymentId: sub.deploymentId,
        odkSubmissionId: sub.id,
        siteId: sub.siteId,
        siteName: site?.name ?? null,
        latitude: site?.lat ?? null,
        longitude: site?.lng ?? null,
        dateInstalled: sub.dateInstalled?.slice(0, 10) ?? null,
        inSchedule: scheduleDeploymentIds.has(sub.deploymentId),
      });
    }

    missing.sort((a, b) => a.deploymentId.localeCompare(b.deploymentId));

    return { success: true, data: missing };
  } catch (err) {
    console.error("[Drive Folders] Failed to find missing folders:", err);
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

    const rootFolderId = bioChocoProject?.driveFolderId ?? process.env.CAMERA_TRAP_ROOT_FOLDER_ID;
    if (!rootFolderId) {
      return {
        deploymentId,
        success: false,
        error: "La carpeta de Drive del proyecto BioChoco no está configurada.",
      };
    }

    const { siteMap, submissionMap, scheduleSet } =
      await fetchOdkDeploymentData();

    const sub = submissionMap.get(deploymentId);
    if (!sub) {
      return {
        deploymentId,
        success: false,
        error: "Instalación no encontrada en ODK",
      };
    }

    const site = siteMap.get(sub.siteId);

    // Create Drive folder + subfolders
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
        console.error(
          `[Drive Folders] Failed to update sheet for ${deploymentId}:`,
          err
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
          siteName: site?.name ?? null,
          latitude: site?.lat ?? null,
          longitude: site?.lng ?? null,
          dateStart: sub.dateInstalled?.slice(0, 10) ?? null,
          odkSubmissionId: sub.id,
          metadataSource: "odk",
          status: "unscanned",
        })
        .onConflictDoNothing();
    } catch (err) {
      console.error(
        `[Drive Folders] Failed to insert DB row for ${deploymentId}:`,
        err
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
    console.error(
      `[Drive Folders] Failed to create folder for ${deploymentId}:`,
      err
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

    const rootFolderId = bioChocoProject?.driveFolderId ?? process.env.CAMERA_TRAP_ROOT_FOLDER_ID;
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
        console.error(
          `[Drive Folders] Failed to update sheet for ${deploymentId}:`,
          err
        );
      }
    }

    // Update existing DB row with new folder ID
    try {
      await db
        .update(deployments)
        .set({ driveFolderId: folder.id })
        .where(eq(deployments.name, deploymentId));
    } catch (err) {
      console.error(
        `[Drive Folders] Failed to update DB row for ${deploymentId}:`,
        err
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
    console.error(
      `[Drive Folders] Failed to recreate folder for ${deploymentId}:`,
      err
    );
    return {
      deploymentId,
      success: false,
      error: err instanceof Error ? err.message : "Error desconocido",
    };
  }
}
