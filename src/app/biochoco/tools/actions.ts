"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth";
import { loadSchedule, saveSchedule, loadSlotTemplate, updateScheduleRows } from "@/lib/sheets-client";
import { fetchEntities, fetchSubmissions } from "@/lib/odk-client";
import { BIOCHOCO_PROJECT_ID, BIOCHOCO_DATASET_SITES, BIOCHOCO_FORM_DEPLOY, BIOCHOCO_FORM_RETRIEVE } from "@/lib/odk-constants";
import type { ScheduleRow, ScheduleChange, SlotRow } from "@/lib/schedule-types";
import type { OdkSiteEntity } from "@/lib/odk-types";
import type { ActionResult } from "@/lib/types";
import {
  shiftSchedule,
  shiftScheduleBySlots,
  swapDeploymentDates,
  addSiteToSchedule,
  validateSchedule,
  validateSlotSchedule,
} from "@/lib/schedule-utils";
import { scheduleHash } from "@/lib/schedule-hash";
import { recordEvent } from "@/lib/system-events";

// ─── Types ───────────────────────────────────────────────────

export interface ShiftPreview {
  changes: ScheduleChange[];
  validationErrors: string[];
  scheduledCount: number;
  hash: string;
}

export interface SwapPreview {
  changes: ScheduleChange[];
  row1: { deploymentId: string; deployDate: string; retrieveDate: string; season: string };
  row2: { deploymentId: string; deployDate: string; retrieveDate: string; season: string };
  hash: string;
}

export interface AddSitePreview {
  newDeployments: ScheduleRow[];
  validationErrors: string[];
  hash: string;
}

export interface SyncUpdate {
  deploymentId: string;
  siteId: string;
  oldStatus: string;
  newStatus: string;
  actualDeployDate?: string;
  actualRetrieveDate?: string;
}

export interface ToolsPageData {
  schedule: ScheduleRow[];
  slots: SlotRow[] | null;
  hasSlots: boolean;
}

// ─── Load initial data ──────────────────────────────────────

// NOTE: Tools page intentionally reads status from the Google Sheet (not live ODK).
// The "Sincronizar ODK" tool exists to push live ODK status back to the sheet.
export async function fetchToolsData(): Promise<ActionResult<ToolsPageData>> {
  try {
    await requirePermission("biochoco", "admin");
    const schedule = await loadSchedule();
    let slots: SlotRow[] | null = null;
    let hasSlots = false;

    try {
      slots = await loadSlotTemplate();
      hasSlots = schedule.length > 0 && schedule[0].deploySlotId !== null;
    } catch {
      // Slot template not available
    }

    return { success: true, data: { schedule, slots, hasSlots } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

// ─── Bulk Shift ─────────────────────────────────────────────

export async function previewBulkShift(shiftAmount: number, useSlots: boolean): Promise<ActionResult<ShiftPreview>> {
  try {
    await requirePermission("biochoco", "admin");
    const schedule = await loadSchedule();
    const scheduledCount = schedule.filter((r) => r.status === "scheduled").length;

    let changes: ScheduleChange[];
    let validationErrors: string[];

    if (useSlots) {
      const slots = await loadSlotTemplate();
      const result = shiftScheduleBySlots(schedule, slots, shiftAmount);
      changes = result.changes;
      validationErrors = validateSlotSchedule(result.rows, slots);
    } else {
      const result = shiftSchedule(schedule, shiftAmount);
      changes = result.changes;
      validationErrors = validateSchedule(result.rows);
    }

    return { success: true, data: { changes, validationErrors, scheduledCount, hash: scheduleHash(schedule) } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export async function commitBulkShift(shiftAmount: number, useSlots: boolean, expectedHash: string): Promise<ActionResult<void>> {
  try {
    const user = await requirePermission("biochoco", "admin");

    const schedule = await loadSchedule();
    if (scheduleHash(schedule) !== expectedHash) {
      return { success: false, error: "El cronograma fue modificado por otro usuario. Por favor, revisa la vista previa de nuevo." };
    }

    let newRows: ScheduleRow[];
    let changes: ScheduleChange[];

    if (useSlots) {
      const slots = await loadSlotTemplate();
      const result = shiftScheduleBySlots(schedule, slots, shiftAmount);
      newRows = result.rows;
      changes = result.changes;
    } else {
      const result = shiftSchedule(schedule, shiftAmount);
      newRows = result.rows;
      changes = result.changes;
    }

    await saveSchedule(newRows);

    await recordEvent({
      source: "biochoco-tools",
      eventType: "schedule_shift",
      summary: `Cronograma desplazado por ${shiftAmount} ${useSlots ? "ranura(s)" : "día(s)"} (${changes.length} cambio${changes.length === 1 ? "" : "s"})`,
      actorEmail: user.email,
      projectId: "biochoco",
      targetType: "schedule",
      details: { shiftAmount, useSlots, changesCount: changes.length },
    });

    revalidatePath("/biochoco");
    return { success: true, data: undefined };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

// ─── Date Swap ──────────────────────────────────────────────

export async function previewDateSwap(id1: string, id2: string): Promise<ActionResult<SwapPreview>> {
  try {
    await requirePermission("biochoco", "admin");
    const schedule = await loadSchedule();
    const result = swapDeploymentDates(schedule, id1, id2);

    const r1 = result.rows.find((r) => r.deploymentId === id1)!;
    const r2 = result.rows.find((r) => r.deploymentId === id2)!;

    return {
      success: true,
      data: {
        changes: result.changes,
        row1: { deploymentId: id1, deployDate: r1.plannedDeployDate ?? "N/A", retrieveDate: r1.plannedRetrieveDate ?? "N/A", season: r1.season },
        row2: { deploymentId: id2, deployDate: r2.plannedDeployDate ?? "N/A", retrieveDate: r2.plannedRetrieveDate ?? "N/A", season: r2.season },
        hash: scheduleHash(schedule),
      },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export async function commitDateSwap(id1: string, id2: string, expectedHash: string): Promise<ActionResult<void>> {
  try {
    const user = await requirePermission("biochoco", "admin");

    const schedule = await loadSchedule();
    if (scheduleHash(schedule) !== expectedHash) {
      return { success: false, error: "El cronograma fue modificado por otro usuario. Por favor, revisa la vista previa de nuevo." };
    }
    const result = swapDeploymentDates(schedule, id1, id2);
    await saveSchedule(result.rows);

    await recordEvent({
      source: "biochoco-tools",
      eventType: "schedule_swap",
      summary: `Fechas intercambiadas entre ${id1} y ${id2}`,
      actorEmail: user.email,
      projectId: "biochoco",
      targetType: "schedule",
      details: { id1, id2, changesCount: result.changes.length },
    });

    revalidatePath("/biochoco");
    return { success: true, data: undefined };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

// ─── Available Sites ────────────────────────────────────────

export interface AvailableSite {
  siteId: string;
  siteName: string;
  habitatType: string;
  lat: number | null;
  lng: number | null;
}

export async function getAvailableSites(): Promise<ActionResult<AvailableSite[]>> {
  try {
    await requirePermission("biochoco", "admin");
    const [schedule, rawSites] = await Promise.all([
      loadSchedule(),
      fetchEntities<OdkSiteEntity>(BIOCHOCO_PROJECT_ID, BIOCHOCO_DATASET_SITES),
    ]);

    const inSchedule = new Set(schedule.map((r) => r.siteId));

    const available = rawSites
      .filter((s) => !inSchedule.has(s.site_id))
      .map((s) => ({
        siteId: s.site_id,
        siteName: s.site_name ?? s.label ?? "",
        habitatType: s.habitat_type ?? "",
        lat: s.latitude ? parseFloat(String(s.latitude)) : null,
        lng: s.longitude ? parseFloat(String(s.longitude)) : null,
      }));

    return { success: true, data: available };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export async function previewAddSite(siteId: string, siteName: string, habitatType: string): Promise<ActionResult<AddSitePreview>> {
  try {
    await requirePermission("biochoco", "admin");
    const schedule = await loadSchedule();
    const result = addSiteToSchedule(schedule, { siteId, siteName, habitatType });
    const validationErrors = validateSchedule(result.rows);

    return { success: true, data: { newDeployments: result.newDeployments, validationErrors, hash: scheduleHash(schedule) } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export async function commitAddSite(siteId: string, siteName: string, habitatType: string, expectedHash: string): Promise<ActionResult<void>> {
  try {
    const user = await requirePermission("biochoco", "admin");

    const schedule = await loadSchedule();
    if (scheduleHash(schedule) !== expectedHash) {
      return { success: false, error: "El cronograma fue modificado por otro usuario. Por favor, revisa la vista previa de nuevo." };
    }
    const result = addSiteToSchedule(schedule, { siteId, siteName, habitatType });
    await saveSchedule(result.rows);

    await recordEvent({
      source: "biochoco-tools",
      eventType: "schedule_add_site",
      summary: `Sitio ${siteId} agregado (${result.newDeployments.length} despliegue${result.newDeployments.length === 1 ? "" : "s"})`,
      actorEmail: user.email,
      projectId: "biochoco",
      targetType: "schedule",
      targetId: siteId,
      details: { siteId, siteName, habitatType, deploymentsAdded: result.newDeployments.length },
    });

    revalidatePath("/biochoco");
    return { success: true, data: undefined };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

// ─── Validation ─────────────────────────────────────────────

export async function runValidation(): Promise<ActionResult<string[]>> {
  try {
    await requirePermission("biochoco", "admin");
    const schedule = await loadSchedule();
    const errors = validateSchedule(schedule);
    return { success: true, data: errors };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

// ─── Sync ODK ───────────────────────────────────────────────

/**
 * Derive sync updates from ODK submissions vs current schedule.
 * Used by both preview and commit to ensure server-side truth.
 */
async function deriveSyncUpdates(): Promise<SyncUpdate[]> {
  const [schedule, , rawDeploys, rawRetrieves] = await Promise.all([
    loadSchedule(),
    fetchEntities<OdkSiteEntity>(BIOCHOCO_PROJECT_ID, BIOCHOCO_DATASET_SITES),
    fetchSubmissions<Record<string, unknown>>(BIOCHOCO_PROJECT_ID, BIOCHOCO_FORM_DEPLOY),
    fetchSubmissions<Record<string, unknown>>(BIOCHOCO_PROJECT_ID, BIOCHOCO_FORM_RETRIEVE),
  ]);

  // Build deploy/retrieve ID sets with actual dates
  const deployedMap = new Map<string, string>();
  for (const sub of rawDeploys) {
    const sel = sub.site_selection as Record<string, unknown> | undefined;
    const depInfo = sub.deployment_info as Record<string, unknown> | undefined;
    const depId = (sel?.deployment_id as string) ?? (sub.deployment_id as string) ?? "";
    const date = (depInfo?.deploy_date as string) ?? (sel?.fecha_instalacion as string) ?? (sub.fecha_instalacion as string) ?? "";
    if (depId) deployedMap.set(depId, date.slice(0, 10));
  }

  const retrievedMap = new Map<string, string>();
  for (const sub of rawRetrieves) {
    const sel = sub.site_selection as Record<string, unknown> | undefined;
    const retInfo = sub.retrieval_info as Record<string, unknown> | undefined;
    const depId = (sel?.deployment_id as string) ?? (sub.deployment_id as string) ?? "";
    const date = (retInfo?.retrieval_date as string) ?? (sel?.fecha_recuperacion as string) ?? (sub.fecha_recuperacion as string) ?? "";
    if (depId) retrievedMap.set(depId, date.slice(0, 10));
  }

  const updates: SyncUpdate[] = [];

  for (const row of schedule) {
    if (row.status === "scheduled" && deployedMap.has(row.deploymentId)) {
      updates.push({
        deploymentId: row.deploymentId,
        siteId: row.siteId,
        oldStatus: "scheduled",
        newStatus: "deployed",
        actualDeployDate: deployedMap.get(row.deploymentId),
      });
    } else if (row.status === "deployed" && retrievedMap.has(row.deploymentId)) {
      updates.push({
        deploymentId: row.deploymentId,
        siteId: row.siteId,
        oldStatus: "deployed",
        newStatus: "retrieved",
        actualRetrieveDate: retrievedMap.get(row.deploymentId),
      });
    }
  }

  return updates;
}

export async function previewSyncOdk(): Promise<ActionResult<SyncUpdate[]>> {
  try {
    await requirePermission("biochoco", "admin");
    const updates = await deriveSyncUpdates();
    return { success: true, data: updates };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/**
 * Commit sync — re-derives updates server-side from ODK, then applies only
 * the deploymentIds the user confirmed. Client cannot inject arbitrary data.
 */
export async function commitSyncOdk(deploymentIds: string[]): Promise<ActionResult<void>> {
  try {
    const user = await requirePermission("biochoco", "admin");

    // Re-derive updates from ODK (server-side truth)
    const allUpdates = await deriveSyncUpdates();

    // Only apply updates for deployment IDs the user confirmed
    const confirmedSet = new Set(deploymentIds);
    const updates = allUpdates.filter((u) => confirmedSet.has(u.deploymentId));

    if (updates.length === 0) {
      return { success: true, data: undefined };
    }

    const sheetUpdates = updates.map((u) => ({
      deploymentId: u.deploymentId,
      fields: {
        status: u.newStatus,
        ...(u.actualDeployDate ? { actualDeployDate: u.actualDeployDate } : {}),
        ...(u.actualRetrieveDate ? { actualRetrieveDate: u.actualRetrieveDate } : {}),
      },
    }));

    await updateScheduleRows(sheetUpdates);

    await recordEvent({
      source: "biochoco-tools",
      eventType: "schedule_sync_odk",
      summary: `Cronograma sincronizado con ODK (${updates.length} actualización${updates.length === 1 ? "" : "es"})`,
      actorEmail: user.email,
      projectId: "biochoco",
      targetType: "schedule",
      details: { updatesCount: updates.length },
    });

    revalidatePath("/biochoco");
    return { success: true, data: undefined };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}
