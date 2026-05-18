"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth";
import { fetchEntities, fetchSubmissions } from "@/lib/odk-client";
import { BIOCHOCO_PROJECT_ID, BIOCHOCO_DATASET_SITES, BIOCHOCO_FORM_DEPLOY, BIOCHOCO_FORM_RETRIEVE } from "@/lib/odk-constants";
import { loadSchedule, updateScheduleRows } from "@/lib/sheets-client";
import { editDeploymentDate, swapDeploymentDates, validateSchedule } from "@/lib/schedule-utils";
import { scheduleHash } from "@/lib/schedule-hash";
import { recordEvent } from "@/lib/system-events";
import type { OdkSiteEntity } from "@/lib/odk-types";
import type { ActionResult } from "@/lib/types";
import type { ScheduleChange } from "@/lib/schedule-types";
import type { BiochocoOverviewData, SiteInfo } from "./types";
import { db } from "@/db";
import { deployments } from "@/db/schema";
import { log } from "@/lib/log";

export async function fetchBiochocoData(): Promise<ActionResult<BiochocoOverviewData>> {
  try {
    await requirePermission("biochoco", "viewer");
    const [schedule, rawSites, rawDeploys, rawRetrieves] = await Promise.all([
      loadSchedule(),
      fetchEntities<OdkSiteEntity>(BIOCHOCO_PROJECT_ID, BIOCHOCO_DATASET_SITES),
      fetchSubmissions<Record<string, unknown>>(BIOCHOCO_PROJECT_ID, BIOCHOCO_FORM_DEPLOY),
      fetchSubmissions<Record<string, unknown>>(BIOCHOCO_PROJECT_ID, BIOCHOCO_FORM_RETRIEVE),
    ]);

    // Enrich schedule with DB data (Drive folder links + field notes).
    // Build new objects via spread (not in-place mutation) so all fields are
    // own enumerable properties on the serialized RSC payload.
    const dbDeployments = await db
      .select({
        name: deployments.name,
        driveFolderId: deployments.driveFolderId,
        fieldNotes: deployments.fieldNotes,
      })
      .from(deployments);

    const dbMap = new Map(
      dbDeployments.map((d) => [d.name, d])
    );

    const enrichedSchedule = schedule.map((row) => {
      const dbRow = dbMap.get(row.deploymentId);
      return {
        ...row,
        driveFolderLink: dbRow?.driveFolderId
          ? `https://drive.google.com/drive/folders/${dbRow.driveFolderId}`
          : row.driveFolderLink,
        fieldNotes: dbRow?.fieldNotes ?? null,
      };
    });

    // Transform sites
    const sites: SiteInfo[] = rawSites.map((s) => ({
      siteId: s.site_id ?? s.label ?? "",
      siteName: s.label ?? s.site_name ?? "",
      habitatType: s.habitat_type ?? "",
      lat: s.latitude ? parseFloat(String(s.latitude)) : null,
      lng: s.longitude ? parseFloat(String(s.longitude)) : null,
      habitatAssessed: (s.habitat_assessed as string) ?? "",
    }));

    // Extract deployment_ids and actual dates from form submissions
    // ODK groups come as nested objects in OData
    const deployDateMap = new Map<string, string>();
    const deployedIds = rawDeploys
      .map((sub) => {
        const sel = sub.site_selection as Record<string, unknown> | undefined;
        const depInfo = sub.deployment_info as Record<string, unknown> | undefined;
        const depId = (sel?.deployment_id as string) ?? (sub.deployment_id as string) ?? "";
        const date = (depInfo?.deploy_date as string) ?? (sel?.fecha_instalacion as string) ?? (sub.fecha_instalacion as string) ?? "";
        if (depId && date) deployDateMap.set(depId, date.slice(0, 10));
        return depId;
      })
      .filter(Boolean);

    const retrieveDateMap = new Map<string, string>();
    const retrievedIds = rawRetrieves
      .map((sub) => {
        const sel = sub.site_selection as Record<string, unknown> | undefined;
        const retInfo = sub.retrieval_info as Record<string, unknown> | undefined;
        const depId = (sel?.deployment_id as string) ?? (sub.deployment_id as string) ?? "";
        const date = (retInfo?.retrieval_date as string) ?? (sel?.fecha_recuperacion as string) ?? (sub.fecha_recuperacion as string) ?? "";
        if (depId && date) retrieveDateMap.set(depId, date.slice(0, 10));
        return depId;
      })
      .filter(Boolean);

    // Enrich schedule with actual ODK dates
    const scheduleWithDates = enrichedSchedule.map((row) => ({
      ...row,
      actualDeployDate: deployDateMap.get(row.deploymentId) ?? row.actualDeployDate,
      actualRetrieveDate: retrieveDateMap.get(row.deploymentId) ?? row.actualRetrieveDate,
    }));

    return {
      success: true,
      data: { schedule: scheduleWithDates, sites, deployedIds, retrievedIds },
    };
  } catch (err) {
    log.error({ err }, "Failed to fetch BioChoco data");
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

// ─── Inline Schedule Editor ──────────────────────────────────

export interface InlineSwapPreview {
  changes: ScheduleChange[];
  validationErrors: string[];
  hash: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Wrap an action body and translate the small set of English errors thrown
 * by schedule-utils into Spanish. Keeps the action sites concise and the
 * UI strings consistent.
 */
async function wrapAction<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    return { success: true, data };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Error desconocido";
    const localized =
      msg.includes("modificado por otro usuario") ? msg
      : msg.includes("Cannot swap a deployment with itself") ? "No se puede intercambiar una instalación consigo misma."
      : msg.includes("Invalid date format") ? "Fecha inválida."
      : msg.includes("not found") ? "Instalación no encontrada."
      : msg.includes("not scheduled") ? "Esta instalación no está programada."
      : msg.includes("no current planned deploy date") ? "La instalación no tiene fecha planificada."
      : msg;
    return { success: false, error: localized };
  }
}

export async function previewInlineSwap(
  id1: string,
  id2: string,
): Promise<ActionResult<InlineSwapPreview>> {
  return wrapAction<InlineSwapPreview>(async () => {
    await requirePermission("biochoco", "editor");
    const schedule = await loadSchedule();
    const { rows: updatedRows, changes } = swapDeploymentDates(schedule, id1, id2);
    return {
      changes,
      validationErrors: validateSchedule(updatedRows),
      hash: scheduleHash(schedule),
    };
  });
}

export async function commitInlineSwap(
  id1: string,
  id2: string,
  expectedHash: string,
): Promise<ActionResult<void>> {
  return wrapAction<void>(async () => {
    const user = await requirePermission("biochoco", "editor");
    const schedule = await loadSchedule();
    if (scheduleHash(schedule) !== expectedHash) {
      throw new Error(
        "El cronograma fue modificado por otro usuario. Reintenta la vista previa.",
      );
    }

    const before1 = schedule.find((r) => r.deploymentId === id1);
    const before2 = schedule.find((r) => r.deploymentId === id2);
    if (!before1 || !before2) throw new Error("Deployment not found");

    const { rows: updatedRows } = swapDeploymentDates(schedule, id1, id2);
    const after1 = updatedRows.find((r) => r.deploymentId === id1)!;
    const after2 = updatedRows.find((r) => r.deploymentId === id2)!;

    await updateScheduleRows([
      {
        deploymentId: id1,
        fields: {
          plannedDeployDate: after1.plannedDeployDate,
          plannedRetrieveDate: after1.plannedRetrieveDate,
          deploySlotId: after1.deploySlotId,
          retrieveSlotId: after1.retrieveSlotId,
          season: after1.season,
        },
      },
      {
        deploymentId: id2,
        fields: {
          plannedDeployDate: after2.plannedDeployDate,
          plannedRetrieveDate: after2.plannedRetrieveDate,
          deploySlotId: after2.deploySlotId,
          retrieveSlotId: after2.retrieveSlotId,
          season: after2.season,
        },
      },
    ]);

    await recordEvent({
      source: "biochoco-overview",
      eventType: "schedule_inline_swap",
      summary: `Fechas intercambiadas en cronograma: ${id1} ↔ ${id2}`,
      actorEmail: user.email,
      projectId: "biochoco",
      targetType: "schedule",
      targetId: id1,
      details: {
        id1,
        id2,
        beforeDate1: before1.plannedDeployDate,
        afterDate1: after1.plannedDeployDate,
        beforeDate2: before2.plannedDeployDate,
        afterDate2: after2.plannedDeployDate,
        habitatType1: after1.habitatType,
        habitatType2: after2.habitatType,
      },
    });

    revalidatePath("/biochoco");
  });
}

export async function commitDateEdit(
  deploymentId: string,
  newDeployDate: string,
): Promise<ActionResult<{ warnings: string[] }>> {
  return wrapAction<{ warnings: string[] }>(async () => {
    const user = await requirePermission("biochoco", "editor");
    if (!ISO_DATE.test(newDeployDate)) throw new Error("Invalid date format");

    const schedule = await loadSchedule();
    const before = schedule.find((r) => r.deploymentId === deploymentId);
    if (!before) throw new Error("Deployment not found");

    const { rows: updatedRows } = editDeploymentDate(schedule, deploymentId, newDeployDate);
    const after = updatedRows.find((r) => r.deploymentId === deploymentId)!;
    const warnings = validateSchedule(updatedRows);

    await updateScheduleRows([
      {
        deploymentId,
        fields: {
          plannedDeployDate: after.plannedDeployDate,
          plannedRetrieveDate: after.plannedRetrieveDate,
          deploySlotId: null,
          retrieveSlotId: null,
          season: after.season,
        },
      },
    ]);

    await recordEvent({
      source: "biochoco-overview",
      eventType: "schedule_date_edit",
      summary: `Fecha-plan editada para ${deploymentId}: ${before.plannedDeployDate} → ${after.plannedDeployDate}`,
      actorEmail: user.email,
      projectId: "biochoco",
      targetType: "schedule",
      targetId: deploymentId,
      details: {
        deploymentId,
        oldDeployDate: before.plannedDeployDate,
        newDeployDate: after.plannedDeployDate,
        oldRetrieveDate: before.plannedRetrieveDate,
        newRetrieveDate: after.plannedRetrieveDate,
        slotsCleared: before.deploySlotId !== null || before.retrieveSlotId !== null,
      },
    });

    revalidatePath("/biochoco");
    return { warnings };
  });
}
