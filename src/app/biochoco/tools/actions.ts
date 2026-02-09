"use server";

import { revalidatePath } from "next/cache";
import { getCurrentUser, requirePermission } from "@/lib/auth";
import { loadSchedule, saveSchedule, loadSlotTemplate, updateScheduleRows } from "@/lib/sheets-client";
import { fetchEntities, fetchSubmissions } from "@/lib/odk-client";
import type { ScheduleRow, ScheduleChange, SlotRow } from "@/lib/schedule-types";
import type { OdkSiteEntity } from "@/lib/odk-types";
import {
  shiftSchedule,
  shiftScheduleBySlots,
  swapDeploymentDates,
  addSiteToSchedule,
  validateSchedule,
  validateSlotSchedule,
} from "@/lib/schedule-utils";
import { db } from "@/db";
import { activityLog } from "@/db/schema";

// ─── Types ───────────────────────────────────────────────────

interface ActionResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface ShiftPreview {
  changes: ScheduleChange[];
  validationErrors: string[];
  scheduledCount: number;
}

export interface SwapPreview {
  changes: ScheduleChange[];
  row1: { deploymentId: string; deployDate: string; retrieveDate: string; season: string };
  row2: { deploymentId: string; deployDate: string; retrieveDate: string; season: string };
}

export interface AddSitePreview {
  newDeployments: ScheduleRow[];
  validationErrors: string[];
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

export async function fetchToolsData(): Promise<ActionResult<ToolsPageData>> {
  try {
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

    return { success: true, data: { changes, validationErrors, scheduledCount } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export async function commitBulkShift(shiftAmount: number, useSlots: boolean): Promise<ActionResult<void>> {
  try {
    const user = await getCurrentUser();
    if (!user) return { success: false, error: "No autenticado" };

    const schedule = await loadSchedule();

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

    await db.insert(activityLog).values({
      userEmail: user.email,
      action: "schedule_shift",
      projectId: "biochoco",
      targetType: "schedule",
      details: JSON.stringify({ shiftAmount, useSlots, changesCount: changes.length }),
    });

    revalidatePath("/biochoco");
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

// ─── Date Swap ──────────────────────────────────────────────

export async function previewDateSwap(id1: string, id2: string): Promise<ActionResult<SwapPreview>> {
  try {
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
      },
    };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export async function commitDateSwap(id1: string, id2: string): Promise<ActionResult<void>> {
  try {
    const user = await getCurrentUser();
    if (!user) return { success: false, error: "No autenticado" };

    const schedule = await loadSchedule();
    const result = swapDeploymentDates(schedule, id1, id2);
    await saveSchedule(result.rows);

    await db.insert(activityLog).values({
      userEmail: user.email,
      action: "schedule_swap",
      projectId: "biochoco",
      targetType: "schedule",
      details: JSON.stringify({ id1, id2, changesCount: result.changes.length }),
    });

    revalidatePath("/biochoco");
    return { success: true };
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
    const [schedule, rawSites] = await Promise.all([
      loadSchedule(),
      fetchEntities<OdkSiteEntity>("8", "monitoring_sites_v0_14"),
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
    const schedule = await loadSchedule();
    const result = addSiteToSchedule(schedule, { siteId, siteName, habitatType });
    const validationErrors = validateSchedule(result.rows);

    return { success: true, data: { newDeployments: result.newDeployments, validationErrors } };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export async function commitAddSite(siteId: string, siteName: string, habitatType: string): Promise<ActionResult<void>> {
  try {
    const user = await getCurrentUser();
    if (!user) return { success: false, error: "No autenticado" };

    const schedule = await loadSchedule();
    const result = addSiteToSchedule(schedule, { siteId, siteName, habitatType });
    await saveSchedule(result.rows);

    await db.insert(activityLog).values({
      userEmail: user.email,
      action: "schedule_add_site",
      projectId: "biochoco",
      targetType: "schedule",
      details: JSON.stringify({ siteId, deploymentsAdded: result.newDeployments.length }),
    });

    revalidatePath("/biochoco");
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

// ─── Validation ─────────────────────────────────────────────

export async function runValidation(): Promise<ActionResult<string[]>> {
  try {
    const schedule = await loadSchedule();
    const errors = validateSchedule(schedule);
    return { success: true, data: errors };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

// ─── Sync ODK ───────────────────────────────────────────────

export async function previewSyncOdk(): Promise<ActionResult<SyncUpdate[]>> {
  try {
    const [schedule, rawSites, rawDeploys, rawRetrieves] = await Promise.all([
      loadSchedule(),
      fetchEntities<OdkSiteEntity>("8", "monitoring_sites_v0_14"),
      fetchSubmissions<Record<string, unknown>>("8", "instalar_sensores"),
      fetchSubmissions<Record<string, unknown>>("8", "retrieve_sensors"),
    ]);

    // Build deploy/retrieve ID sets with actual dates
    const deployedMap = new Map<string, string>();
    for (const sub of rawDeploys) {
      const sel = sub.site_selection as Record<string, unknown> | undefined;
      const depId = (sel?.deployment_id as string) ?? (sub.deployment_id as string) ?? "";
      const date = (sel?.fecha_instalacion as string) ?? (sub.fecha_instalacion as string) ?? "";
      if (depId) deployedMap.set(depId, date.slice(0, 10));
    }

    const retrievedMap = new Map<string, string>();
    for (const sub of rawRetrieves) {
      const sel = sub.site_selection as Record<string, unknown> | undefined;
      const depId = (sel?.deployment_id as string) ?? (sub.deployment_id as string) ?? "";
      const date = (sel?.fecha_recuperacion as string) ?? (sub.fecha_recuperacion as string) ?? "";
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

    return { success: true, data: updates };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

export async function commitSyncOdk(updates: SyncUpdate[]): Promise<ActionResult<void>> {
  try {
    const user = await getCurrentUser();
    if (!user) return { success: false, error: "No autenticado" };

    const sheetUpdates = updates.map((u) => ({
      deploymentId: u.deploymentId,
      fields: {
        status: u.newStatus,
        ...(u.actualDeployDate ? { actualDeployDate: u.actualDeployDate } : {}),
        ...(u.actualRetrieveDate ? { actualRetrieveDate: u.actualRetrieveDate } : {}),
      },
    }));

    await updateScheduleRows(sheetUpdates);

    await db.insert(activityLog).values({
      userEmail: user.email,
      action: "schedule_sync_odk",
      projectId: "biochoco",
      targetType: "schedule",
      details: JSON.stringify({ updatesCount: updates.length }),
    });

    revalidatePath("/biochoco");
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}
