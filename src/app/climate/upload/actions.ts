"use server";

import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import { climateUploads } from "@/db/schema";
import type { ClimateResolution } from "@/db/schema";
import type { ActionResult } from "@/lib/types";
import { parseTOA5File, detectAnomalies } from "./parser";
import type { Anomaly, ParsedRow } from "./parser";
import { QC_FLAG, serializeQcFlags } from "../qc";
import type { QcFlagMap } from "../qc";
import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";
import { recordEvent } from "@/lib/system-events";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export interface UploadPreview {
  resolution: ClimateResolution;
  rowCount: number;
  dateRange: { start: string; end: string } | null;
  errorCount: number;
  errors: { line: number; message: string }[];
  anomalies: Anomaly[];
}

export async function previewDatFile(
  formData: FormData
): Promise<ActionResult<UploadPreview>> {
  await requirePermission("climate", "editor");

  const file = formData.get("file") as File | null;
  if (!file) return { success: false, error: "No se seleccionó ningún archivo" };

  if (file.size > MAX_FILE_SIZE) {
    return {
      success: false,
      error: `El archivo excede el límite de 10MB (${(file.size / 1024 / 1024).toFixed(1)}MB)`,
    };
  }

  if (!file.name.endsWith(".dat")) {
    return {
      success: false,
      error: 'El archivo debe tener extensión .dat',
    };
  }

  try {
    const text = await file.text();
    const result = parseTOA5File(text);

    if (result.rows.length === 0 && result.errors.length > 0) {
      return {
        success: false,
        error: result.errors[0].message,
      };
    }

    const anomalies = detectAnomalies(result.rows);

    return {
      success: true,
      data: {
        resolution: result.resolution,
        rowCount: result.rows.length,
        dateRange: result.dateRange,
        errorCount: result.errors.length,
        errors: result.errors.slice(0, 10), // Show first 10 errors only
        anomalies,
      },
    };
  } catch (e) {
    return {
      success: false,
      error: `Error al procesar: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Apply anomaly QC: for every out-of-range cell, record the original value and
 * an "R" (range) flag in a per-row qc_flags map, then NULL the working column
 * so it is excluded from dashboards/aggregations. Nothing is destroyed — the
 * raw value is preserved in the returned map.
 *
 * @returns Map of row index → qc_flags map for rows that had anomalies.
 */
function applyAnomalyFlags(
  rows: ParsedRow[],
  anomalies: Anomaly[]
): Map<number, QcFlagMap> {
  const flagsByRow = new Map<number, QcFlagMap>();

  for (const a of anomalies) {
    const idx = a.row - 1; // Convert 1-based to 0-based
    if (idx < 0 || idx >= rows.length) continue;

    if (!flagsByRow.has(idx)) flagsByRow.set(idx, {});
    flagsByRow.get(idx)![a.column] = { flag: QC_FLAG.RANGE, raw: a.value };

    // NULL the working column (a.column is the camelCase ParsedRow field).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (rows[idx] as any)[a.column] = null;
  }

  return flagsByRow;
}

export async function commitDatFile(
  formData: FormData,
  // Default to applying QC: out-of-range cells get an "R" flag (raw value
  // preserved) and are excluded. Callers must opt out explicitly to keep
  // anomalous values as-is — see the upload UI.
  nullAnomalies = true
): Promise<ActionResult<{ rowCount: number; resolution: ClimateResolution }>> {
  const user = await requirePermission("climate", "editor");

  const file = formData.get("file") as File | null;
  if (!file) return { success: false, error: "No se seleccionó ningún archivo" };

  if (file.size > MAX_FILE_SIZE) {
    return { success: false, error: "El archivo excede el límite de 10MB" };
  }

  try {
    const text = await file.text();
    const result = parseTOA5File(text);

    if (result.rows.length === 0) {
      return {
        success: false,
        error: result.errors.length > 0
          ? result.errors[0].message
          : "No se encontraron datos para importar",
      };
    }

    // If user chose to null anomalies, flag + null them before inserting.
    // flagsByRow maps a row index to its qc_flags map (raw value + reason).
    let flagsByRow = new Map<number, QcFlagMap>();
    if (nullAnomalies) {
      const anomalies = detectAnomalies(result.rows);
      flagsByRow = applyAnomalyFlags(result.rows, anomalies);
    }

    db.transaction((tx) => {
      for (let i = 0; i < result.rows.length; i++) {
        const row = result.rows[i];
        const qcFlags = serializeQcFlags(flagsByRow.get(i) ?? {});
        tx.run(sql`
          INSERT INTO climate_readings (
            timestamp, resolution, record_num,
            air_temp_avg, air_temp_max, air_temp_min,
            humidity_avg, humidity_max, humidity_min,
            pressure_avg, pressure_max, pressure_min,
            rain_mm,
            solar_avg, solar_max, solar_min,
            wind_dir_avg, wind_dir_max, wind_dir_min,
            wind_speed_avg, wind_speed_max, wind_speed_min,
            mean_wind_speed, mean_wind_direction, std_wind_dir,
            qc_flags
          ) VALUES (
            ${row.timestamp}, ${row.resolution}, ${row.recordNum},
            ${row.airTempAvg}, ${row.airTempMax}, ${row.airTempMin},
            ${row.humidityAvg}, ${row.humidityMax}, ${row.humidityMin},
            ${row.pressureAvg}, ${row.pressureMax}, ${row.pressureMin},
            ${row.rainMm},
            ${row.solarAvg}, ${row.solarMax}, ${row.solarMin},
            ${row.windDirAvg}, ${row.windDirMax}, ${row.windDirMin},
            ${row.windSpeedAvg}, ${row.windSpeedMax}, ${row.windSpeedMin},
            ${row.meanWindSpeed ?? null}, ${row.meanWindDirection ?? null}, ${row.stdWindDir ?? null},
            ${qcFlags}
          )
          ON CONFLICT(timestamp, resolution) DO UPDATE SET
            record_num = excluded.record_num,
            air_temp_avg = excluded.air_temp_avg,
            air_temp_max = excluded.air_temp_max,
            air_temp_min = excluded.air_temp_min,
            humidity_avg = excluded.humidity_avg,
            humidity_max = excluded.humidity_max,
            humidity_min = excluded.humidity_min,
            pressure_avg = excluded.pressure_avg,
            pressure_max = excluded.pressure_max,
            pressure_min = excluded.pressure_min,
            rain_mm = excluded.rain_mm,
            solar_avg = excluded.solar_avg,
            solar_max = excluded.solar_max,
            solar_min = excluded.solar_min,
            wind_dir_avg = excluded.wind_dir_avg,
            wind_dir_max = excluded.wind_dir_max,
            wind_dir_min = excluded.wind_dir_min,
            wind_speed_avg = excluded.wind_speed_avg,
            wind_speed_max = excluded.wind_speed_max,
            wind_speed_min = excluded.wind_speed_min,
            mean_wind_speed = excluded.mean_wind_speed,
            mean_wind_direction = excluded.mean_wind_direction,
            std_wind_dir = excluded.std_wind_dir,
            qc_flags = excluded.qc_flags
        `);
      }

      tx.run(sql`
        INSERT INTO climate_uploads (filename, resolution, rows_imported, date_range_start, date_range_end, uploaded_by)
        VALUES (${file.name}, ${result.resolution}, ${result.rows.length}, ${result.dateRange?.start ?? null}, ${result.dateRange?.end ?? null}, ${user.email})
      `);
    });

    db.run(sql`PRAGMA wal_checkpoint(PASSIVE)`);
    await recordEvent({
      source: "climate",
      eventType: `climate_upload_${result.resolution}`,
      summary: `Datos climáticos ${result.resolution} cargados: ${file.name} (${result.rows.length} fila${result.rows.length === 1 ? "" : "s"})`,
      severity: "success",
      actorEmail: user.email,
      projectId: "climate",
      targetType: "climate_upload",
      details: {
        fileName: file.name,
        resolution: result.resolution,
        rowCount: result.rows.length,
        dateRangeStart: result.dateRange?.start ?? null,
        dateRangeEnd: result.dateRange?.end ?? null,
        nullAnomalies,
      },
    });
    revalidatePath("/climate");
    return {
      success: true,
      data: { rowCount: result.rows.length, resolution: result.resolution },
    };
  } catch (e) {
    return {
      success: false,
      error: `Error al guardar datos: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function fetchLastClimateUploads(): Promise<
  ActionResult<Record<ClimateResolution, { filename: string; uploadedBy: string; uploadedAt: Date; rowsImported: number; dateRangeStart: string | null; dateRangeEnd: string | null } | null>>
> {
  await requirePermission("climate", "viewer");

  try {
    const resolutions: ClimateResolution[] = ["hourly", "15min"];
    const result: Record<string, typeof resolutions extends (infer U)[] ? { filename: string; uploadedBy: string; uploadedAt: Date; rowsImported: number; dateRangeStart: string | null; dateRangeEnd: string | null } | null : never> = {};

    for (const res of resolutions) {
      const rows = db
        .select()
        .from(climateUploads)
        .where(sql`resolution = ${res}`)
        .orderBy(sql`uploaded_at DESC`)
        .limit(1)
        .all();

      result[res] = rows.length > 0
        ? {
            filename: rows[0].filename,
            uploadedBy: rows[0].uploadedBy,
            uploadedAt: rows[0].uploadedAt,
            rowsImported: rows[0].rowsImported,
            dateRangeStart: rows[0].dateRangeStart,
            dateRangeEnd: rows[0].dateRangeEnd,
          }
        : null;
    }

    return { success: true, data: result as Record<ClimateResolution, typeof result[string]> };
  } catch (e) {
    return {
      success: false,
      error: `Error al obtener uploads: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
