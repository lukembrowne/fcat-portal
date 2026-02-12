"use server";

import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import { climateReadings, climateUploads } from "@/db/schema";
import type { ClimateResolution } from "@/db/schema";
import type { ActionResult } from "@/lib/types";
import { parseTOA5File } from "./parser";
import { revalidatePath } from "next/cache";
import { sql } from "drizzle-orm";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// SQLite has a 999 variable limit. With 25 columns per insert, max batch ~= 39
const BATCH_SIZE = 39;

export interface UploadPreview {
  resolution: ClimateResolution;
  rowCount: number;
  dateRange: { start: string; end: string } | null;
  errorCount: number;
  errors: { line: number; message: string }[];
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

    return {
      success: true,
      data: {
        resolution: result.resolution,
        rowCount: result.rows.length,
        dateRange: result.dateRange,
        errorCount: result.errors.length,
        errors: result.errors.slice(0, 10), // Show first 10 errors only
      },
    };
  } catch (e) {
    return {
      success: false,
      error: `Error al procesar: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function commitDatFile(
  formData: FormData
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

    // Use raw SQL for the upsert to handle ON CONFLICT properly
    // Drizzle's onConflictDoUpdate requires explicit target which is tricky with composite unique
    const insertStmt = db.run(sql`SELECT 1`); // dummy to get db reference

    // Wrap everything in a transaction
    const insertSql = sql`
      INSERT INTO climate_readings (
        timestamp, resolution, record_num,
        air_temp_avg, air_temp_max, air_temp_min,
        humidity_avg, humidity_max, humidity_min,
        pressure_avg, pressure_max, pressure_min,
        rain_mm,
        solar_avg, solar_max, solar_min,
        wind_dir_avg, wind_dir_max, wind_dir_min,
        wind_speed_avg, wind_speed_max, wind_speed_min,
        mean_wind_speed, mean_wind_direction, std_wind_dir
      ) VALUES (
        ${sql.placeholder("timestamp")}, ${sql.placeholder("resolution")}, ${sql.placeholder("recordNum")},
        ${sql.placeholder("airTempAvg")}, ${sql.placeholder("airTempMax")}, ${sql.placeholder("airTempMin")},
        ${sql.placeholder("humidityAvg")}, ${sql.placeholder("humidityMax")}, ${sql.placeholder("humidityMin")},
        ${sql.placeholder("pressureAvg")}, ${sql.placeholder("pressureMax")}, ${sql.placeholder("pressureMin")},
        ${sql.placeholder("rainMm")},
        ${sql.placeholder("solarAvg")}, ${sql.placeholder("solarMax")}, ${sql.placeholder("solarMin")},
        ${sql.placeholder("windDirAvg")}, ${sql.placeholder("windDirMax")}, ${sql.placeholder("windDirMin")},
        ${sql.placeholder("windSpeedAvg")}, ${sql.placeholder("windSpeedMax")}, ${sql.placeholder("windSpeedMin")},
        ${sql.placeholder("meanWindSpeed")}, ${sql.placeholder("meanWindDirection")}, ${sql.placeholder("stdWindDir")}
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
        std_wind_dir = excluded.std_wind_dir
    `;

    // Access the underlying better-sqlite3 database for transactions
    // Use Drizzle's transaction support
    void insertStmt; // suppress unused

    // Use raw better-sqlite3 for proper transaction + prepared statement
    const rawDb = (db as unknown as { _: { session: { client: import("better-sqlite3").Database } } })._.session.client;

    const upsertStmt = rawDb.prepare(`
      INSERT INTO climate_readings (
        timestamp, resolution, record_num,
        air_temp_avg, air_temp_max, air_temp_min,
        humidity_avg, humidity_max, humidity_min,
        pressure_avg, pressure_max, pressure_min,
        rain_mm,
        solar_avg, solar_max, solar_min,
        wind_dir_avg, wind_dir_max, wind_dir_min,
        wind_speed_avg, wind_speed_max, wind_speed_min,
        mean_wind_speed, mean_wind_direction, std_wind_dir
      ) VALUES (
        @timestamp, @resolution, @recordNum,
        @airTempAvg, @airTempMax, @airTempMin,
        @humidityAvg, @humidityMax, @humidityMin,
        @pressureAvg, @pressureMax, @pressureMin,
        @rainMm,
        @solarAvg, @solarMax, @solarMin,
        @windDirAvg, @windDirMax, @windDirMin,
        @windSpeedAvg, @windSpeedMax, @windSpeedMin,
        @meanWindSpeed, @meanWindDirection, @stdWindDir
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
        std_wind_dir = excluded.std_wind_dir
    `);

    const insertUploadStmt = rawDb.prepare(`
      INSERT INTO climate_uploads (filename, resolution, rows_imported, date_range_start, date_range_end, uploaded_by)
      VALUES (@filename, @resolution, @rowsImported, @dateRangeStart, @dateRangeEnd, @uploadedBy)
    `);

    // Run everything in a single transaction
    const runTransaction = rawDb.transaction(() => {
      for (const row of result.rows) {
        upsertStmt.run(row);
      }

      insertUploadStmt.run({
        filename: file.name,
        resolution: result.resolution,
        rowsImported: result.rows.length,
        dateRangeStart: result.dateRange?.start ?? null,
        dateRangeEnd: result.dateRange?.end ?? null,
        uploadedBy: user.email,
      });
    });

    runTransaction();

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
