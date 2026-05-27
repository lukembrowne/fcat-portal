"use server";

import { revalidatePath, updateTag } from "next/cache";
import { requirePermission } from "@/lib/auth";
import { fetchEntities, fetchSubmissions, fetchEntity, updateEntity, OdkEntityError } from "@/lib/odk-client";
import { BIOCHOCO_PROJECT_ID, BIOCHOCO_DATASET_SITES, BIOCHOCO_FORM_DEPLOY, BIOCHOCO_FORM_RETRIEVE } from "@/lib/odk-constants";
import { loadSchedule, updateScheduleRows } from "@/lib/sheets-client";
import { editDeploymentDate, swapDeploymentDates, validateSchedule } from "@/lib/schedule-utils";
import { scheduleHash } from "@/lib/schedule-hash";
import { recordEvent } from "@/lib/system-events";
import type { OdkSiteEntity } from "@/lib/odk-types";
import type { ActionResult } from "@/lib/types";
import type { ScheduleChange } from "@/lib/schedule-types";
import { HABITAT_NAMES, type BiochocoOverviewData, type SiteInfo } from "./types";
import { db } from "@/db";
import { deployments } from "@/db/schema";
import { log } from "@/lib/log";

export async function fetchBiochocoData(): Promise<ActionResult<BiochocoOverviewData>> {
  try {
    await requirePermission("biochoco", "viewer");
    const [schedule, rawSites, rawDeploys, rawRetrieves] = await Promise.all([
      loadSchedule(),
      fetchEntities<OdkSiteEntity>(BIOCHOCO_PROJECT_ID, BIOCHOCO_DATASET_SITES, { tags: ["biochoco-sites"] }),
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
      uuid: s.uuid,
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

// ─── Site Entity Editor ──────────────────────────────────────

export interface SiteEntityEditInput {
  siteId: string;
  uuid: string;
  name: string;
  latitude: string;
  longitude: string;
  habitatType: string;
  /** Values shown when the dialog opened — the optimistic-lock baseline. */
  expected: {
    name: string;
    latitude: string;
    longitude: string;
    habitatType: string;
  };
}

const SITE_CONFLICT_MSG =
  "El sitio fue actualizado por otra persona. Recarga e intenta de nuevo.";

/** Two coordinate strings match if both blank or both parse to the same float. */
function coordsEqual(a: string, b: string): boolean {
  const at = a.trim();
  const bt = b.trim();
  if (at === "" || bt === "") return at === bt;
  return parseFloat(at) === parseFloat(bt);
}

/**
 * Edit a BioChoco site's name (entity `label`), coordinates and habitat directly
 * on the ODK entity (the source of truth), then best-effort mirror the name into
 * the schedule Sheet's `site_name` column. Site fields are shared across all of
 * the site's deployments, so this affects every visit.
 *
 * Concurrency: the `expected` page-load baseline is compared against the live
 * entity before writing (catches edits since the dialog opened); `baseVersion`
 * backstops the narrow read→PATCH race. Both surface the same Spanish message.
 */
export async function updateSiteEntity(
  input: SiteEntityEditInput,
): Promise<ActionResult<{ warnings: string[] }>> {
  return wrapAction<{ warnings: string[] }>(async () => {
    const user = await requirePermission("biochoco", "editor");

    const { siteId, uuid, expected } = input;
    const name = input.name.trim();
    const latitude = input.latitude.trim();
    const longitude = input.longitude.trim();
    const habitatType = input.habitatType.trim();

    // 1. Validate (before any network call)
    if (!name) throw new Error("El nombre no puede estar vacío.");
    const latFilled = latitude !== "";
    const lngFilled = longitude !== "";
    if (latFilled !== lngFilled) throw new Error("Coordenadas inválidas.");
    if (latFilled) {
      const latN = parseFloat(latitude);
      const lngN = parseFloat(longitude);
      if (
        !Number.isFinite(latN) || !Number.isFinite(lngN) ||
        latN < -90 || latN > 90 || lngN < -180 || lngN > 180
      ) {
        throw new Error("Coordenadas inválidas.");
      }
    }
    if (habitatType !== "" && !(habitatType in HABITAT_NAMES)) {
      throw new Error("Hábitat inválido.");
    }

    // 2. Read the live entity (for version + current values). 404 → distinct message.
    let current;
    try {
      current = await fetchEntity(BIOCHOCO_PROJECT_ID, BIOCHOCO_DATASET_SITES, uuid);
    } catch (err) {
      if (err instanceof OdkEntityError && err.status === 404) {
        throw new Error("El sitio ya no existe. Recarga la página.");
      }
      throw err;
    }
    const cv = current.currentVersion;
    const data = cv.data ?? {};

    // 3. Page-load conflict check — did anyone edit since the dialog opened?
    const conflict =
      (cv.label ?? "").trim() !== expected.name.trim() ||
      !coordsEqual(data.latitude ?? "", expected.latitude) ||
      !coordsEqual(data.longitude ?? "", expected.longitude) ||
      (data.habitat_type ?? "") !== expected.habitatType;
    if (conflict) throw new Error(SITE_CONFLICT_MSG);

    // 4. Build patch. Keep ODK's `geometry` in sync if the dataset has it
    //    (lon-lat order; cleared when coords are cleared).
    const patchData: Record<string, string> = {
      latitude,
      longitude,
      habitat_type: habitatType,
    };
    if ("geometry" in data) {
      patchData.geometry = latFilled ? `POINT (${longitude} ${latitude})` : "";
    }

    try {
      await updateEntity(
        BIOCHOCO_PROJECT_ID,
        BIOCHOCO_DATASET_SITES,
        uuid,
        { label: name, data: patchData },
        cv.version,
      );
    } catch (err) {
      if (err instanceof OdkEntityError && err.status === 409) {
        throw new Error(SITE_CONFLICT_MSG);
      }
      throw err;
    }

    // 5. Best-effort Sheet sync — ODK is already committed, so never fail here.
    const warnings: string[] = [];
    try {
      const schedule = await loadSchedule();
      const rows = schedule.filter((r) => r.siteId === siteId);
      if (rows.length === 0) {
        warnings.push("Guardado en ODK. No se encontraron filas en la hoja para este sitio.");
      } else {
        const { cellsWritten } = await updateScheduleRows(
          rows.map((r) => ({ deploymentId: r.deploymentId, fields: { siteName: name } })),
        );
        if (cellsWritten === 0) {
          warnings.push("Guardado en ODK, pero la hoja no se actualizó (falta la columna site_name).");
        }
      }
    } catch (err) {
      log.warn({ err }, "[updateSiteEntity] Sheet name sync failed");
      warnings.push("Guardado en ODK, pero la hoja no se pudo actualizar.");
    }

    // 6. Audit event
    await recordEvent({
      source: "biochoco-overview",
      eventType: "site_entity_edit",
      summary: `Sitio editado: ${siteId} (${cv.label} → ${name})`,
      actorEmail: user.email,
      projectId: "biochoco",
      targetType: "site",
      targetId: siteId,
      details: {
        siteId,
        uuid,
        before: {
          name: cv.label,
          latitude: data.latitude ?? "",
          longitude: data.longitude ?? "",
          habitatType: data.habitat_type ?? "",
        },
        after: { name, latitude, longitude, habitatType },
      },
    });

    // 7. Refresh ODK-derived views (overview sites + cross-tab habitat map).
    //    `updateTag` is the Next 16 single-arg, read-your-own-writes primitive
    //    for Server Actions; it invalidates the "biochoco-sites" fetch Data Cache
    //    tag attached in fetchEntities. `revalidatePath` refreshes the route tree.
    updateTag("biochoco-sites");
    revalidatePath("/biochoco");
    return { warnings };
  });
}
