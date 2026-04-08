"use server";

import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import { deployments, ibuttonUploads, ibuttonReadings } from "@/db/schema";
import { eq, sql, and, isNotNull, gt } from "drizzle-orm";
import { fetchSubmissions, fetchEntities } from "@/lib/odk-client";
import {
  BIOCHOCO_PROJECT_ID,
  BIOCHOCO_FORM_DEPLOY,
  BIOCHOCO_FORM_RETRIEVE,
  BIOCHOCO_DATASET_SITES,
} from "@/lib/odk-constants";
import type { OdkSiteEntity } from "@/lib/odk-types";
import { listFolderFiles, downloadFileToBuffer } from "@/lib/drive-client";
import { parseIbuttonXlsx } from "./parser";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/types";
import type {
  IbuttonStatus,
  ProcessingResult,
  DeploymentStatPoint,
  TemperatureDistributions,
  DeploymentSummary,
  DeploymentDetail,
} from "./types";
import { getHabitatName } from "@/app/biochoco/overview/types";

const XLSX_EXTENSIONS = new Set([".xlsx"]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip TZ offset and milliseconds from ODK time: "09:20:00.000-05:00" → "09:20:00" */
function cleanOdkTime(raw: string): string {
  return raw.replace(/\.\d{3}.*$/, "");
}

/** Build deploy/retrieve datetime maps from ODK submissions.
 *  Values are "YYYY-MM-DD HH:mm:ss" for timestamp-level truncation. */
async function loadOdkDateTimes(): Promise<{
  deployDateTimeMap: Map<string, string>;
  retrieveDateTimeMap: Map<string, string>;
}> {
  const [rawDeploys, rawRetrieves] = await Promise.all([
    fetchSubmissions<Record<string, unknown>>(
      BIOCHOCO_PROJECT_ID,
      BIOCHOCO_FORM_DEPLOY
    ),
    fetchSubmissions<Record<string, unknown>>(
      BIOCHOCO_PROJECT_ID,
      BIOCHOCO_FORM_RETRIEVE
    ),
  ]);

  const deployDateTimeMap = new Map<string, string>();
  for (const sub of rawDeploys) {
    const sel = sub.site_selection as Record<string, unknown> | undefined;
    const depInfo = sub.deployment_info as Record<string, unknown> | undefined;
    const depId =
      (sel?.deployment_id as string) ??
      (sub.deployment_id as string) ??
      "";
    if (!depId) continue;
    const date =
      (depInfo?.deploy_date as string) ??
      (sel?.fecha_instalacion as string) ??
      (sub.fecha_instalacion as string) ??
      "";
    if (!date) continue;
    const time = (depInfo?.deploy_time as string) ?? "";
    const dateStr = date.slice(0, 10);
    // Fallback: if no time, use 00:00:00 (start of day = inclusive)
    const timeStr = time ? cleanOdkTime(time) : "00:00:00";
    deployDateTimeMap.set(depId, `${dateStr} ${timeStr}`);
  }

  const retrieveDateTimeMap = new Map<string, string>();
  for (const sub of rawRetrieves) {
    const sel = sub.site_selection as Record<string, unknown> | undefined;
    const retInfo = sub.retrieval_info as Record<string, unknown> | undefined;
    const depId =
      (sel?.deployment_id as string) ??
      (sub.deployment_id as string) ??
      "";
    if (!depId) continue;
    const date =
      (retInfo?.retrieval_date as string) ??
      (sel?.fecha_recuperacion as string) ??
      (sub.fecha_recuperacion as string) ??
      "";
    if (!date) continue;
    const time = (retInfo?.retrieval_time as string) ?? "";
    const dateStr = date.slice(0, 10);
    // Fallback: if no time, use 23:59:59 (end of day = inclusive)
    const timeStr = time ? cleanOdkTime(time) : "23:59:59";
    retrieveDateTimeMap.set(depId, `${dateStr} ${timeStr}`);
  }

  return { deployDateTimeMap, retrieveDateTimeMap };
}

/** Build site_id → habitat_type map from ODK entities. */
async function loadSiteHabitatMap(): Promise<Map<string, string>> {
  const sites = await fetchEntities<OdkSiteEntity>(
    BIOCHOCO_PROJECT_ID,
    BIOCHOCO_DATASET_SITES
  );
  const map = new Map<string, string>();
  for (const site of sites) {
    if (site.habitat_type) {
      // Key by site_id (e.g., "SEC-006") for robust matching
      if (site.site_id) map.set(site.site_id, site.habitat_type);
      // Also key by site_name and label as fallbacks
      if (site.site_name) map.set(site.site_name, site.habitat_type);
      if (site.label && site.label !== site.site_name) {
        map.set(site.label, site.habitat_type);
      }
    }
  }
  return map;
}

/** Extract site_id from deployment name, e.g., "SEC-006_V1" → "SEC-006". */
function extractSiteId(deploymentName: string): string | null {
  const match = deploymentName.match(/^(.+?)_V\d+$/i);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Public actions
// ---------------------------------------------------------------------------

/**
 * Get iButton processing status: how many deployments have data, how many processed.
 */
export async function fetchIbuttonStatus(): Promise<
  ActionResult<IbuttonStatus>
> {
  try {
    await requirePermission("biochoco", "viewer");

    const rows = await db
      .select({
        total: sql<number>`count(*)`,
        processed: sql<number>`count(${ibuttonUploads.id})`,
        totalReadings: sql<number>`coalesce(sum(${ibuttonUploads.rowsImported}), 0)`,
      })
      .from(deployments)
      .leftJoin(
        ibuttonUploads,
        eq(deployments.id, ibuttonUploads.deploymentId)
      )
      .where(
        and(isNotNull(deployments.uploadIbuttonFolderId), gt(deployments.uploadIbuttonCount, 0))
      );

    const row = rows[0] ?? { total: 0, processed: 0, totalReadings: 0 };

    return {
      success: true,
      data: {
        total: row.total,
        processed: row.processed,
        unprocessed: row.total - row.processed,
        totalReadings: row.totalReadings,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Error al obtener estado",
    };
  }
}

/**
 * Process all unprocessed iButton deployments: fetch from Drive, parse, truncate, store.
 */
export async function processAllIbutton(): Promise<
  ActionResult<ProcessingResult>
> {
  try {
    const user = await requirePermission("biochoco", "editor");

    // Find unprocessed deployments
    const unprocessed = await db
      .select({
        id: deployments.id,
        name: deployments.name,
        ibuttonFolderId: deployments.uploadIbuttonFolderId,
      })
      .from(deployments)
      .leftJoin(
        ibuttonUploads,
        eq(deployments.id, ibuttonUploads.deploymentId)
      )
      .where(
        and(
          isNotNull(deployments.uploadIbuttonFolderId),
          gt(deployments.uploadIbuttonCount, 0),
          sql`${ibuttonUploads.id} IS NULL`
        )
      );

    if (unprocessed.length === 0) {
      return {
        success: true,
        data: { processed: 0, failed: 0, errors: ["No hay despliegues pendientes de procesar"] },
      };
    }

    // Load ODK date+times for truncation
    const { deployDateTimeMap, retrieveDateTimeMap } = await loadOdkDateTimes();

    let processed = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const dep of unprocessed) {
      try {
        // 1. List .xlsx files in the iButton Drive subfolder
        const files = await listFolderFiles(
          dep.ibuttonFolderId!,
          XLSX_EXTENSIONS
        );

        if (files.length === 0) {
          errors.push(`${dep.name}: no se encontró archivo .xlsx en Drive`);
          failed++;
          continue;
        }

        // 2. Download the first .xlsx file
        const file = files[0];
        const buffer = await downloadFileToBuffer(file.id);

        // 3. Parse
        const result = parseIbuttonXlsx(buffer);
        if (result.readings.length === 0) {
          errors.push(
            `${dep.name}: ${result.errors[0] ?? "sin lecturas"}`
          );
          failed++;
          continue;
        }

        // 4. Truncate to deployment window (timestamp-level)
        const deployDateTime = deployDateTimeMap.get(dep.name);
        const retrieveDateTime = retrieveDateTimeMap.get(dep.name);
        let truncated = result.readings;
        let truncationWarning: string | null = null;

        if (deployDateTime && retrieveDateTime && deployDateTime <= retrieveDateTime) {
          truncated = result.readings.filter((r) => {
            return r.timestamp >= deployDateTime && r.timestamp <= retrieveDateTime;
          });
          if (truncated.length === 0) {
            truncationWarning = `${dep.name}: todas las lecturas fuera de la ventana de despliegue (${deployDateTime} — ${retrieveDateTime})`;
          }
        } else if (!deployDateTime || !retrieveDateTime) {
          truncationWarning = `${dep.name}: fechas de despliegue/recuperación no disponibles, se importaron todas las lecturas`;
        }

        if (truncated.length === 0) {
          errors.push(truncationWarning ?? `${dep.name}: sin lecturas tras truncar`);
          failed++;
          continue;
        }

        // 5. Insert into DB (synchronous transaction)
        const dateRangeStart = truncated[0].timestamp;
        const dateRangeEnd = truncated[truncated.length - 1].timestamp;

        db.transaction((tx) => {
          // Insert upload record
          const uploadResult = tx.run(sql`
            INSERT INTO ibutton_uploads (
              deployment_id, filename, device_serial, sample_rate,
              mission_start, rows_imported, date_range_start, date_range_end,
              processed_by
            ) VALUES (
              ${dep.id}, ${file.name}, ${result.metadata.deviceSerial ?? null},
              ${result.metadata.sampleRate ?? null}, ${result.metadata.missionStart ?? null},
              ${truncated.length}, ${dateRangeStart}, ${dateRangeEnd},
              ${user.email}
            )
          `);

          const uploadId = Number(uploadResult.lastInsertRowid);

          // Insert readings
          for (const reading of truncated) {
            tx.run(sql`
              INSERT INTO ibutton_readings (
                deployment_id, upload_id, timestamp, temperature_c, flagged
              ) VALUES (
                ${dep.id}, ${uploadId}, ${reading.timestamp}, ${reading.temperatureC}, 0
              )
              ON CONFLICT(deployment_id, timestamp) DO UPDATE SET
                temperature_c = excluded.temperature_c,
                upload_id = excluded.upload_id
            `);
          }
        });

        if (truncationWarning) errors.push(truncationWarning);
        processed++;
      } catch (err) {
        errors.push(
          `${dep.name}: ${err instanceof Error ? err.message : "error desconocido"}`
        );
        failed++;
      }
    }

    revalidatePath("/biochoco/ibutton");
    return { success: true, data: { processed, failed, errors } };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Error al procesar",
    };
  }
}

/**
 * Reprocess a single deployment: delete old data, re-fetch from Drive, re-parse.
 */
export async function reprocessDeployment(
  deploymentId: number
): Promise<ActionResult<{ rowsImported: number }>> {
  try {
    const user = await requirePermission("biochoco", "editor");

    // Get deployment info
    const [dep] = await db
      .select({
        id: deployments.id,
        name: deployments.name,
        ibuttonFolderId: deployments.uploadIbuttonFolderId,
      })
      .from(deployments)
      .where(eq(deployments.id, deploymentId));

    if (!dep) {
      return { success: false, error: "Despliegue no encontrado" };
    }

    if (!dep.ibuttonFolderId) {
      return {
        success: false,
        error: "Este despliegue no tiene carpeta de iButton en Drive",
      };
    }

    // Delete existing data
    await db
      .delete(ibuttonReadings)
      .where(eq(ibuttonReadings.deploymentId, deploymentId));
    await db
      .delete(ibuttonUploads)
      .where(eq(ibuttonUploads.deploymentId, deploymentId));

    // Re-fetch and re-parse
    const files = await listFolderFiles(dep.ibuttonFolderId, XLSX_EXTENSIONS);
    if (files.length === 0) {
      return {
        success: false,
        error: "No se encontró archivo .xlsx en la carpeta de Drive",
      };
    }

    const file = files[0];
    const buffer = await downloadFileToBuffer(file.id);
    const result = parseIbuttonXlsx(buffer);

    if (result.readings.length === 0) {
      return {
        success: false,
        error: result.errors[0] ?? "No se encontraron lecturas",
      };
    }

    // Truncate (timestamp-level)
    const { deployDateTimeMap, retrieveDateTimeMap } = await loadOdkDateTimes();
    const deployDateTime = deployDateTimeMap.get(dep.name);
    const retrieveDateTime = retrieveDateTimeMap.get(dep.name);
    let truncated = result.readings;

    if (deployDateTime && retrieveDateTime && deployDateTime <= retrieveDateTime) {
      truncated = result.readings.filter((r) => {
        return r.timestamp >= deployDateTime && r.timestamp <= retrieveDateTime;
      });
    }

    if (truncated.length === 0) {
      return {
        success: false,
        error: "Todas las lecturas quedaron fuera de la ventana de despliegue",
      };
    }

    const dateRangeStart = truncated[0].timestamp;
    const dateRangeEnd = truncated[truncated.length - 1].timestamp;

    db.transaction((tx) => {
      const uploadResult = tx.run(sql`
        INSERT INTO ibutton_uploads (
          deployment_id, filename, device_serial, sample_rate,
          mission_start, rows_imported, date_range_start, date_range_end,
          processed_by
        ) VALUES (
          ${dep.id}, ${file.name}, ${result.metadata.deviceSerial ?? null},
          ${result.metadata.sampleRate ?? null}, ${result.metadata.missionStart ?? null},
          ${truncated.length}, ${dateRangeStart}, ${dateRangeEnd},
          ${user.email}
        )
      `);

      const uploadId = Number(uploadResult.lastInsertRowid);

      for (const reading of truncated) {
        tx.run(sql`
          INSERT INTO ibutton_readings (
            deployment_id, upload_id, timestamp, temperature_c, flagged
          ) VALUES (
            ${dep.id}, ${uploadId}, ${reading.timestamp}, ${reading.temperatureC}, 0
          )
        `);
      }
    });

    revalidatePath("/biochoco/ibutton");
    return { success: true, data: { rowsImported: truncated.length } };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Error al reprocesar",
    };
  }
}

/**
 * Toggle the flagged status of a single reading.
 */
export async function toggleReadingFlag(
  readingId: number
): Promise<ActionResult<{ flagged: boolean }>> {
  try {
    await requirePermission("biochoco", "editor");

    const [reading] = await db
      .select({ flagged: ibuttonReadings.flagged })
      .from(ibuttonReadings)
      .where(eq(ibuttonReadings.id, readingId));

    if (!reading) {
      return { success: false, error: "Lectura no encontrada" };
    }

    const newFlagged = !reading.flagged;
    await db
      .update(ibuttonReadings)
      .set({ flagged: newFlagged })
      .where(eq(ibuttonReadings.id, readingId));

    return { success: true, data: { flagged: newFlagged } };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Error",
    };
  }
}

/**
 * Fetch all readings and metadata for a single deployment.
 */
export async function fetchDeploymentReadings(
  deploymentId: number
): Promise<ActionResult<DeploymentDetail>> {
  try {
    await requirePermission("biochoco", "viewer");

    const [dep] = await db
      .select({
        id: deployments.id,
        name: deployments.name,
        siteName: deployments.siteName,
        dateStart: deployments.dateStart,
        dateEnd: deployments.dateEnd,
      })
      .from(deployments)
      .where(eq(deployments.id, deploymentId));

    if (!dep) {
      return { success: false, error: "Despliegue no encontrado" };
    }

    // Get habitat type from ODK
    const habitatMap = await loadSiteHabitatMap();
    const habitatType =
      (dep.siteName ? habitatMap.get(dep.siteName) : null) ??
      habitatMap.get(extractSiteId(dep.name) ?? "") ??
      null;

    const [upload] = await db
      .select()
      .from(ibuttonUploads)
      .where(eq(ibuttonUploads.deploymentId, deploymentId));

    const readings = await db
      .select({
        id: ibuttonReadings.id,
        timestamp: ibuttonReadings.timestamp,
        temperatureC: ibuttonReadings.temperatureC,
        flagged: ibuttonReadings.flagged,
      })
      .from(ibuttonReadings)
      .where(eq(ibuttonReadings.deploymentId, deploymentId))
      .orderBy(ibuttonReadings.timestamp);

    // Compute stats
    let stats: DeploymentDetail["stats"] = null;
    if (readings.length > 0) {
      const temps = readings.map((r) => r.temperatureC);
      const sum = temps.reduce((a, b) => a + b, 0);
      const mean = sum / temps.length;
      const variance =
        temps.reduce((a, t) => a + (t - mean) ** 2, 0) / temps.length;
      stats = {
        count: readings.length,
        min: Math.min(...temps),
        max: Math.max(...temps),
        mean: Math.round(mean * 100) / 100,
        stdDev: Math.round(Math.sqrt(variance) * 100) / 100,
        flaggedCount: readings.filter((r) => r.flagged).length,
      };
    }

    return {
      success: true,
      data: {
        deployment: {
          id: dep.id,
          name: dep.name,
          siteName: dep.siteName,
          habitatType,
          dateStart: dep.dateStart,
          dateEnd: dep.dateEnd,
        },
        upload: upload
          ? {
              id: upload.id,
              filename: upload.filename,
              deviceSerial: upload.deviceSerial,
              sampleRate: upload.sampleRate,
              missionStart: upload.missionStart,
              rowsImported: upload.rowsImported,
              dateRangeStart: upload.dateRangeStart,
              dateRangeEnd: upload.dateRangeEnd,
              processedBy: upload.processedBy,
              processedAt: upload.processedAt,
            }
          : null,
        readings,
        stats,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Error al cargar datos",
    };
  }
}

/**
 * Fetch per-deployment temperature stat points (min/mean/max per deployment,
 * tagged with site + habitat) for the distribution box plots. Grouping
 * (habitat vs. site) happens client-side.
 */
export async function fetchTemperatureDistributions(): Promise<
  ActionResult<TemperatureDistributions>
> {
  try {
    await requirePermission("biochoco", "viewer");

    // Get all processed deployments with their reading stats
    const depStats = await db
      .select({
        deploymentId: ibuttonUploads.deploymentId,
        deploymentName: deployments.name,
        siteName: deployments.siteName,
        readingCount: ibuttonUploads.rowsImported,
        tempMin: sql<number>`(SELECT min(temperature_c) FROM ibutton_readings WHERE deployment_id = ${ibuttonUploads.deploymentId})`,
        tempMax: sql<number>`(SELECT max(temperature_c) FROM ibutton_readings WHERE deployment_id = ${ibuttonUploads.deploymentId})`,
        tempMean: sql<number>`(SELECT round(avg(temperature_c), 2) FROM ibutton_readings WHERE deployment_id = ${ibuttonUploads.deploymentId})`,
      })
      .from(ibuttonUploads)
      .innerJoin(deployments, eq(ibuttonUploads.deploymentId, deployments.id));

    if (depStats.length === 0) {
      return { success: true, data: { points: [] } };
    }

    // Get habitat types from ODK
    const habitatMap = await loadSiteHabitatMap();

    const points: DeploymentStatPoint[] = [];
    for (const dep of depStats) {
      if (dep.tempMin === null || dep.tempMax === null || dep.tempMean === null) {
        continue;
      }
      const habitatType =
        (dep.siteName ? habitatMap.get(dep.siteName) : null) ??
        habitatMap.get(extractSiteId(dep.deploymentName ?? "") ?? "") ??
        "unknown";
      points.push({
        deploymentId: dep.deploymentId,
        deploymentName: dep.deploymentName ?? `#${dep.deploymentId}`,
        siteName: dep.siteName,
        habitatType,
        habitatLabel: getHabitatName(habitatType),
        readingCount: dep.readingCount,
        tempMin: dep.tempMin,
        tempMean: dep.tempMean,
        tempMax: dep.tempMax,
      });
    }

    // Stable order for deterministic rendering
    points.sort((a, b) => a.deploymentName.localeCompare(b.deploymentName));

    return { success: true, data: { points } };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Error al cargar resumen",
    };
  }
}

/**
 * Fetch list of all processed deployments with summary stats.
 */
export async function fetchProcessedDeployments(): Promise<
  ActionResult<DeploymentSummary[]>
> {
  try {
    await requirePermission("biochoco", "viewer");

    const rows = await db
      .select({
        deploymentId: deployments.id,
        deploymentName: deployments.name,
        siteName: deployments.siteName,
        dateStart: deployments.dateStart,
        dateEnd: deployments.dateEnd,
        rowsImported: ibuttonUploads.rowsImported,
        dateRangeStart: ibuttonUploads.dateRangeStart,
        dateRangeEnd: ibuttonUploads.dateRangeEnd,
        processedAt: ibuttonUploads.processedAt,
        processedBy: ibuttonUploads.processedBy,
        tempMin: sql<number>`(SELECT min(temperature_c) FROM ibutton_readings WHERE deployment_id = ${deployments.id})`,
        tempMax: sql<number>`(SELECT max(temperature_c) FROM ibutton_readings WHERE deployment_id = ${deployments.id})`,
        tempMean: sql<number>`(SELECT round(avg(temperature_c), 2) FROM ibutton_readings WHERE deployment_id = ${deployments.id})`,
        flaggedCount: sql<number>`(SELECT count(*) FROM ibutton_readings WHERE deployment_id = ${deployments.id} AND flagged = 1)`,
      })
      .from(ibuttonUploads)
      .innerJoin(deployments, eq(ibuttonUploads.deploymentId, deployments.id))
      .orderBy(deployments.name);

    // Get habitat types
    const habitatMap = await loadSiteHabitatMap();

    const result: DeploymentSummary[] = rows.map((r) => ({
      deploymentId: r.deploymentId,
      deploymentName: r.deploymentName,
      siteName: r.siteName,
      habitatType:
        (r.siteName ? habitatMap.get(r.siteName) : null) ??
        habitatMap.get(extractSiteId(r.deploymentName) ?? "") ??
        null,
      dateStart: r.dateRangeStart,
      dateEnd: r.dateRangeEnd,
      readingCount: r.rowsImported,
      tempMin: r.tempMin,
      tempMax: r.tempMax,
      tempMean: r.tempMean,
      flaggedCount: r.flaggedCount,
      processedAt: r.processedAt,
      processedBy: r.processedBy,
    }));

    return { success: true, data: result };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Error al cargar despliegues",
    };
  }
}
