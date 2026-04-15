"use server";

import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import { climateReadings, climateUploads, climateEdits } from "@/db/schema";
import type { ClimateResolution } from "@/db/schema";
import type { ActionResult } from "@/lib/types";
import { sql } from "drizzle-orm";

// Allowed sort columns — constrained union type for SQL injection prevention
const ALLOWED_SORT_COLUMNS = [
  "timestamp",
  "air_temp_avg",
  "air_temp_max",
  "air_temp_min",
  "humidity_avg",
  "rain_mm",
  "solar_avg",
  "wind_speed_avg",
  "pressure_avg",
] as const;

export type ClimateSortColumn = (typeof ALLOWED_SORT_COLUMNS)[number];

export interface ClimateFilters {
  dateStart: string;
  dateEnd: string;
  resolution: ClimateResolution;
}

export interface ClimateSummary {
  latestTimestamp: string | null;
  latestUploadDate: string | null;
  totalReadings: number;
  airTempAvg: number | null;
  airTempMax: number | null;
  airTempMin: number | null;
  humidityAvg: number | null;
  totalRainMm: number | null;
  solarAvg: number | null;
  windSpeedAvg: number | null;
  pressureAvg: number | null;
}

export interface ChartDataPoint {
  timestamp: string;
  airTempAvg: number | null;
  airTempMax: number | null;
  airTempMin: number | null;
  humidityAvg: number | null;
  humidityMax: number | null;
  humidityMin: number | null;
  pressureAvg: number | null;
  pressureMax: number | null;
  pressureMin: number | null;
  rainMm: number | null;
  solarAvg: number | null;
  solarMax: number | null;
  solarMin: number | null;
  windDirAvg: number | null;
  windSpeedAvg: number | null;
  windSpeedMax: number | null;
}

export type AggregationLevel = "raw" | "daily" | "monthly" | "yearly";

function getAutoAggregation(dateStart: string, dateEnd: string): AggregationLevel {
  const start = new Date(dateStart);
  const end = new Date(dateEnd);
  const daysDiff = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);

  if (daysDiff > 365) return "monthly";
  if (daysDiff > 90) return "daily";
  return "raw";
}

export async function fetchAvailableYears(
  resolution: ClimateResolution
): Promise<ActionResult<number[]>> {
  await requirePermission("climate", "viewer");

  try {
    const rows = db
      .select({
        year: sql<string>`DISTINCT strftime('%Y', timestamp)`,
      })
      .from(climateReadings)
      .where(sql`resolution = ${resolution}`)
      .orderBy(sql`strftime('%Y', timestamp) ASC`)
      .all();

    const years = rows.map((r) => parseInt(r.year, 10)).filter((y) => !isNaN(y));
    return { success: true, data: years };
  } catch (e) {
    return {
      success: false,
      error: `Error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function fetchClimateReadingCount(
  filters: ClimateFilters
): Promise<ActionResult<number>> {
  await requirePermission("climate", "viewer");

  try {
    const { dateStart, dateEnd, resolution } = filters;
    const rows = db
      .select({ count: sql<number>`COUNT(*)` })
      .from(climateReadings)
      .where(
        sql`resolution = ${resolution} AND timestamp >= ${dateStart} AND timestamp <= ${dateEnd}`
      )
      .all();

    return { success: true, data: rows[0]?.count ?? 0 };
  } catch (e) {
    return {
      success: false,
      error: `Error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function fetchClimateSummary(
  filters: ClimateFilters
): Promise<ActionResult<ClimateSummary>> {
  await requirePermission("climate", "viewer");

  try {
    const { dateStart, dateEnd, resolution } = filters;

    const summaryRows = db
      .select({
        totalReadings: sql<number>`COUNT(*)`,
        airTempAvg: sql<number | null>`AVG(air_temp_avg)`,
        airTempMax: sql<number | null>`MAX(air_temp_max)`,
        airTempMin: sql<number | null>`MIN(air_temp_min)`,
        humidityAvg: sql<number | null>`AVG(humidity_avg)`,
        totalRainMm: sql<number | null>`SUM(rain_mm)`,
        solarAvg: sql<number | null>`AVG(solar_avg)`,
        windSpeedAvg: sql<number | null>`AVG(wind_speed_avg)`,
        pressureAvg: sql<number | null>`AVG(pressure_avg)`,
        latestTimestamp: sql<string | null>`MAX(timestamp)`,
      })
      .from(climateReadings)
      .where(
        sql`resolution = ${resolution} AND timestamp >= ${dateStart} AND timestamp <= ${dateEnd}`
      )
      .all();

    const summary = summaryRows[0];

    // Get latest upload date
    const latestUpload = db
      .select({ dateRangeEnd: climateUploads.dateRangeEnd })
      .from(climateUploads)
      .orderBy(sql`uploaded_at DESC`)
      .limit(1)
      .all();

    return {
      success: true,
      data: {
        totalReadings: summary.totalReadings ?? 0,
        airTempAvg: summary.airTempAvg !== null ? Math.round(summary.airTempAvg * 10) / 10 : null,
        airTempMax: summary.airTempMax !== null ? Math.round(summary.airTempMax * 10) / 10 : null,
        airTempMin: summary.airTempMin !== null ? Math.round(summary.airTempMin * 10) / 10 : null,
        humidityAvg: summary.humidityAvg !== null ? Math.round(summary.humidityAvg * 10) / 10 : null,
        totalRainMm: summary.totalRainMm !== null ? Math.round(summary.totalRainMm * 10) / 10 : null,
        solarAvg: summary.solarAvg !== null ? Math.round(summary.solarAvg * 10) / 10 : null,
        windSpeedAvg: summary.windSpeedAvg !== null ? Math.round(summary.windSpeedAvg * 100) / 100 : null,
        pressureAvg: summary.pressureAvg !== null ? Math.round(summary.pressureAvg * 10) / 10 : null,
        latestTimestamp: summary.latestTimestamp,
        latestUploadDate: latestUpload[0]?.dateRangeEnd ?? null,
      },
    };
  } catch (e) {
    return {
      success: false,
      error: `Error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export interface CumulativePrecipRow {
  mmdd: string; // "MM-DD" — calendar key that aligns years (leap day only present in leap years)
  doy: number; // 1–366 day of year for the first occurrence across years
  label: string; // localized short label, e.g. "14 Abr"
  values: Record<string, number | null>; // year (as string) → cumulative mm
}

export async function fetchCumulativePrecipitation(
  minYear = 2022
): Promise<ActionResult<{ rows: CumulativePrecipRow[]; years: number[] }>> {
  await requirePermission("climate", "viewer");

  try {
    // Daily rain totals for each (year, mm-dd). Cumulative sum computed in JS.
    const daily = db
      .select({
        year: sql<number>`CAST(strftime('%Y', timestamp) AS INTEGER)`,
        mmdd: sql<string>`strftime('%m-%d', timestamp)`,
        doy: sql<number>`CAST(strftime('%j', timestamp) AS INTEGER)`,
        dailyMm: sql<number | null>`SUM(rain_mm)`,
      })
      .from(climateReadings)
      .where(
        sql`resolution = 'hourly' AND CAST(strftime('%Y', timestamp) AS INTEGER) >= ${minYear}`
      )
      .groupBy(sql`strftime('%Y', timestamp), strftime('%m-%d', timestamp)`)
      .orderBy(sql`strftime('%Y', timestamp) ASC, strftime('%m-%d', timestamp) ASC`)
      .all();

    const months = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
    const yearSet = new Set<number>();
    const byMmdd = new Map<string, CumulativePrecipRow>();
    const runningTotals = new Map<number, number>();

    for (const d of daily) {
      yearSet.add(d.year);
      const prior = runningTotals.get(d.year) ?? 0;
      const cumulative = prior + (d.dailyMm ?? 0);
      runningTotals.set(d.year, cumulative);

      let row = byMmdd.get(d.mmdd);
      if (!row) {
        const m = parseInt(d.mmdd.slice(0, 2), 10) - 1;
        const day = d.mmdd.slice(3, 5);
        row = {
          mmdd: d.mmdd,
          doy: d.doy,
          label: `${day} ${months[m]}`,
          values: {},
        };
        byMmdd.set(d.mmdd, row);
      }
      row.values[String(d.year)] = Math.round(cumulative * 10) / 10;
    }

    const sortedRows = Array.from(byMmdd.values()).sort((a, b) => a.mmdd.localeCompare(b.mmdd));
    const years = Array.from(yearSet).sort((a, b) => a - b);

    return { success: true, data: { rows: sortedRows, years } };
  } catch (e) {
    return {
      success: false,
      error: `Error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function fetchClimateChartData(
  filters: ClimateFilters,
  requestedAggregation?: AggregationLevel
): Promise<ActionResult<{ data: ChartDataPoint[]; aggregation: AggregationLevel }>> {
  await requirePermission("climate", "viewer");

  try {
    const { dateStart, dateEnd, resolution } = filters;
    const aggregation = requestedAggregation ?? getAutoAggregation(dateStart, dateEnd);

    let data: ChartDataPoint[];

    if (aggregation === "raw") {
      data = db
        .select({
          timestamp: climateReadings.timestamp,
          airTempAvg: climateReadings.airTempAvg,
          airTempMax: climateReadings.airTempMax,
          airTempMin: climateReadings.airTempMin,
          humidityAvg: climateReadings.humidityAvg,
          humidityMax: climateReadings.humidityMax,
          humidityMin: climateReadings.humidityMin,
          pressureAvg: climateReadings.pressureAvg,
          pressureMax: climateReadings.pressureMax,
          pressureMin: climateReadings.pressureMin,
          rainMm: climateReadings.rainMm,
          solarAvg: climateReadings.solarAvg,
          solarMax: climateReadings.solarMax,
          solarMin: climateReadings.solarMin,
          windDirAvg: climateReadings.windDirAvg,
          windSpeedAvg: climateReadings.windSpeedAvg,
          windSpeedMax: climateReadings.windSpeedMax,
        })
        .from(climateReadings)
        .where(
          sql`resolution = ${resolution} AND timestamp >= ${dateStart} AND timestamp <= ${dateEnd}`
        )
        .orderBy(sql`timestamp ASC`)
        .all();
    } else if (aggregation === "daily") {
      data = db
        .select({
          timestamp: sql<string>`date(timestamp)`,
          airTempAvg: sql<number | null>`ROUND(AVG(air_temp_avg), 1)`,
          airTempMax: sql<number | null>`ROUND(MAX(air_temp_max), 1)`,
          airTempMin: sql<number | null>`ROUND(MIN(air_temp_min), 1)`,
          humidityAvg: sql<number | null>`ROUND(AVG(humidity_avg), 1)`,
          humidityMax: sql<number | null>`ROUND(MAX(humidity_max), 1)`,
          humidityMin: sql<number | null>`ROUND(MIN(humidity_min), 1)`,
          pressureAvg: sql<number | null>`ROUND(AVG(pressure_avg), 1)`,
          pressureMax: sql<number | null>`ROUND(MAX(pressure_max), 1)`,
          pressureMin: sql<number | null>`ROUND(MIN(pressure_min), 1)`,
          rainMm: sql<number | null>`ROUND(SUM(rain_mm), 1)`,
          solarAvg: sql<number | null>`ROUND(AVG(solar_avg), 1)`,
          solarMax: sql<number | null>`ROUND(MAX(solar_max), 1)`,
          solarMin: sql<number | null>`ROUND(MIN(solar_min), 1)`,
          windDirAvg: sql<number | null>`NULL`, // Circular data — not aggregated
          windSpeedAvg: sql<number | null>`ROUND(AVG(wind_speed_avg), 2)`,
          windSpeedMax: sql<number | null>`ROUND(MAX(wind_speed_max), 2)`,
        })
        .from(climateReadings)
        .where(
          sql`resolution = ${resolution} AND timestamp >= ${dateStart} AND timestamp <= ${dateEnd}`
        )
        .groupBy(sql`date(timestamp)`)
        .orderBy(sql`date(timestamp) ASC`)
        .all();
    } else if (aggregation === "monthly") {
      data = db
        .select({
          timestamp: sql<string>`strftime('%Y-%m', timestamp)`,
          airTempAvg: sql<number | null>`ROUND(AVG(air_temp_avg), 1)`,
          airTempMax: sql<number | null>`ROUND(MAX(air_temp_max), 1)`,
          airTempMin: sql<number | null>`ROUND(MIN(air_temp_min), 1)`,
          humidityAvg: sql<number | null>`ROUND(AVG(humidity_avg), 1)`,
          humidityMax: sql<number | null>`ROUND(MAX(humidity_max), 1)`,
          humidityMin: sql<number | null>`ROUND(MIN(humidity_min), 1)`,
          pressureAvg: sql<number | null>`ROUND(AVG(pressure_avg), 1)`,
          pressureMax: sql<number | null>`ROUND(MAX(pressure_max), 1)`,
          pressureMin: sql<number | null>`ROUND(MIN(pressure_min), 1)`,
          rainMm: sql<number | null>`ROUND(SUM(rain_mm), 1)`,
          solarAvg: sql<number | null>`ROUND(AVG(solar_avg), 1)`,
          solarMax: sql<number | null>`ROUND(MAX(solar_max), 1)`,
          solarMin: sql<number | null>`ROUND(MIN(solar_min), 1)`,
          windDirAvg: sql<number | null>`NULL`, // Circular data — not aggregated
          windSpeedAvg: sql<number | null>`ROUND(AVG(wind_speed_avg), 2)`,
          windSpeedMax: sql<number | null>`ROUND(MAX(wind_speed_max), 2)`,
        })
        .from(climateReadings)
        .where(
          sql`resolution = ${resolution} AND timestamp >= ${dateStart} AND timestamp <= ${dateEnd}`
        )
        .groupBy(sql`strftime('%Y-%m', timestamp)`)
        .orderBy(sql`strftime('%Y-%m', timestamp) ASC`)
        .all();
    } else {
      // yearly — exclude 2021 (incomplete year)
      data = db
        .select({
          timestamp: sql<string>`strftime('%Y', timestamp)`,
          airTempAvg: sql<number | null>`ROUND(AVG(air_temp_avg), 1)`,
          airTempMax: sql<number | null>`ROUND(MAX(air_temp_max), 1)`,
          airTempMin: sql<number | null>`ROUND(MIN(air_temp_min), 1)`,
          humidityAvg: sql<number | null>`ROUND(AVG(humidity_avg), 1)`,
          humidityMax: sql<number | null>`ROUND(MAX(humidity_max), 1)`,
          humidityMin: sql<number | null>`ROUND(MIN(humidity_min), 1)`,
          pressureAvg: sql<number | null>`ROUND(AVG(pressure_avg), 1)`,
          pressureMax: sql<number | null>`ROUND(MAX(pressure_max), 1)`,
          pressureMin: sql<number | null>`ROUND(MIN(pressure_min), 1)`,
          rainMm: sql<number | null>`ROUND(SUM(rain_mm), 1)`,
          solarAvg: sql<number | null>`ROUND(AVG(solar_avg), 1)`,
          solarMax: sql<number | null>`ROUND(MAX(solar_max), 1)`,
          solarMin: sql<number | null>`ROUND(MIN(solar_min), 1)`,
          windDirAvg: sql<number | null>`NULL`,
          windSpeedAvg: sql<number | null>`ROUND(AVG(wind_speed_avg), 2)`,
          windSpeedMax: sql<number | null>`ROUND(MAX(wind_speed_max), 2)`,
        })
        .from(climateReadings)
        .where(
          sql`resolution = ${resolution} AND timestamp >= ${dateStart} AND timestamp <= ${dateEnd} AND strftime('%Y', timestamp) != '2021'`
        )
        .groupBy(sql`strftime('%Y', timestamp)`)
        .orderBy(sql`strftime('%Y', timestamp) ASC`)
        .all();
    }

    return { success: true, data: { data, aggregation } };
  } catch (e) {
    return {
      success: false,
      error: `Error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export interface ClimateTablePage {
  rows: {
    timestamp: string;
    airTempAvg: number | null;
    airTempMax: number | null;
    airTempMin: number | null;
    humidityAvg: number | null;
    rainMm: number | null;
    solarAvg: number | null;
    windSpeedAvg: number | null;
    windDirAvg: number | null;
    pressureAvg: number | null;
  }[];
  totalCount: number;
  page: number;
  pageSize: number;
}

export async function fetchClimateTablePage(params: {
  filters: ClimateFilters;
  page: number;
  pageSize: number;
  sortColumn?: ClimateSortColumn;
  sortDirection?: "asc" | "desc";
}): Promise<ActionResult<ClimateTablePage>> {
  await requirePermission("climate", "viewer");

  try {
    const { filters, page, pageSize, sortColumn = "timestamp", sortDirection = "desc" } = params;
    const { dateStart, dateEnd, resolution } = filters;

    // Validate sort column against allowlist
    if (!ALLOWED_SORT_COLUMNS.includes(sortColumn)) {
      return { success: false, error: "Columna de ordenamiento no válida" };
    }

    const offset = (page - 1) * pageSize;

    // Get total count
    const countResult = db
      .select({ count: sql<number>`COUNT(*)` })
      .from(climateReadings)
      .where(
        sql`resolution = ${resolution} AND timestamp >= ${dateStart} AND timestamp <= ${dateEnd}`
      )
      .all();

    const totalCount = countResult[0]?.count ?? 0;

    // Fetch paginated rows — use raw SQL for dynamic ORDER BY (validated against allowlist)
    const orderClause = `${sortColumn} ${sortDirection === "asc" ? "ASC" : "DESC"}`;
    const rows = db
      .select({
        timestamp: climateReadings.timestamp,
        airTempAvg: climateReadings.airTempAvg,
        airTempMax: climateReadings.airTempMax,
        airTempMin: climateReadings.airTempMin,
        humidityAvg: climateReadings.humidityAvg,
        rainMm: climateReadings.rainMm,
        solarAvg: climateReadings.solarAvg,
        windSpeedAvg: climateReadings.windSpeedAvg,
        windDirAvg: climateReadings.windDirAvg,
        pressureAvg: climateReadings.pressureAvg,
      })
      .from(climateReadings)
      .where(
        sql`resolution = ${resolution} AND timestamp >= ${dateStart} AND timestamp <= ${dateEnd}`
      )
      .orderBy(sql.raw(orderClause))
      .limit(pageSize)
      .offset(offset)
      .all();

    return {
      success: true,
      data: { rows, totalCount, page, pageSize },
    };
  } catch (e) {
    return {
      success: false,
      error: `Error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

export async function fetchClimateExportData(
  filters: ClimateFilters
): Promise<ActionResult<{ rows: Record<string, unknown>[]; count: number }>> {
  await requirePermission("climate", "viewer");

  try {
    const { dateStart, dateEnd, resolution } = filters;

    const rows = db
      .select({
        timestamp: climateReadings.timestamp,
        air_temp_avg_c: climateReadings.airTempAvg,
        air_temp_max_c: climateReadings.airTempMax,
        air_temp_min_c: climateReadings.airTempMin,
        humidity_avg_pct: climateReadings.humidityAvg,
        humidity_max_pct: climateReadings.humidityMax,
        humidity_min_pct: climateReadings.humidityMin,
        pressure_avg: climateReadings.pressureAvg,
        pressure_max: climateReadings.pressureMax,
        pressure_min: climateReadings.pressureMin,
        rain_mm_total: climateReadings.rainMm,
        solar_avg_wm2: climateReadings.solarAvg,
        solar_max_wm2: climateReadings.solarMax,
        solar_min_wm2: climateReadings.solarMin,
        wind_dir_avg_deg: climateReadings.windDirAvg,
        wind_dir_max_deg: climateReadings.windDirMax,
        wind_dir_min_deg: climateReadings.windDirMin,
        wind_speed_avg_ms: climateReadings.windSpeedAvg,
        wind_speed_max_ms: climateReadings.windSpeedMax,
        wind_speed_min_ms: climateReadings.windSpeedMin,
      })
      .from(climateReadings)
      .where(
        sql`resolution = ${resolution} AND timestamp >= ${dateStart} AND timestamp <= ${dateEnd}`
      )
      .orderBy(sql`timestamp ASC`)
      .all();

    return { success: true, data: { rows: rows as Record<string, unknown>[], count: rows.length } };
  } catch (e) {
    return {
      success: false,
      error: `Error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// Allowlist of columns that can be nulled via the data editor
const EDITABLE_COLUMNS = [
  "air_temp_avg", "air_temp_max", "air_temp_min",
  "humidity_avg", "humidity_max", "humidity_min",
  "pressure_avg", "pressure_max", "pressure_min",
  "rain_mm",
  "solar_avg", "solar_max", "solar_min",
  "wind_dir_avg", "wind_dir_max", "wind_dir_min",
  "wind_speed_avg", "wind_speed_max", "wind_speed_min",
] as const;

export type EditableColumn = (typeof EDITABLE_COLUMNS)[number];

export async function nullClimateValue(params: {
  timestamp: string;
  resolution: ClimateResolution;
  column: string;
  reason?: string;
}): Promise<ActionResult<{ oldValue: number | null }>> {
  const user = await requirePermission("climate", "editor");

  const { timestamp, resolution, column, reason } = params;

  // Validate column against allowlist
  if (!EDITABLE_COLUMNS.includes(column as EditableColumn)) {
    return { success: false, error: "Columna no válida para edición" };
  }

  try {
    // Get old value first
    const rows = db
      .select()
      .from(climateReadings)
      .where(sql`timestamp = ${timestamp} AND resolution = ${resolution}`)
      .all();

    if (rows.length === 0) {
      return { success: false, error: "Registro no encontrado" };
    }

    const row = rows[0] as Record<string, unknown>;
    // Map snake_case column name to camelCase field
    const camelField = column.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    const oldValue = (row[camelField] as number | null) ?? null;

    db.transaction((tx) => {
      // Set the value to NULL — column name is validated against allowlist above
      tx.run(
        sql`UPDATE climate_readings SET ${sql.raw(column)} = NULL WHERE timestamp = ${timestamp} AND resolution = ${resolution}`
      );

      // Record the edit in the audit trail
      tx.run(sql`
        INSERT INTO climate_edits (timestamp, resolution, column_name, old_value, edited_by, reason)
        VALUES (${timestamp}, ${resolution}, ${column}, ${oldValue}, ${user.email}, ${reason ?? null})
      `);
    });

    return { success: true, data: { oldValue } };
  } catch (e) {
    return {
      success: false,
      error: `Error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}
