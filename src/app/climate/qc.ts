/**
 * Climate QC flag model — shared by the upload pipeline, the manual data
 * editor, and the CSV export.
 *
 * The working numeric columns in `climate_readings` hold analysis-ready values:
 * when a cell fails QC it is set to NULL so dashboard charts stay clean. The
 * `qc_flags` column preserves *why* a cell was removed and its original value,
 * as a sparse JSON map keyed by the camelCase field name:
 *
 *   {"airTempAvg": {"flag": "R", "raw": -8.82}}
 *
 * Nothing is silently destroyed: every removed value is recoverable from
 * `qc_flags` (and, for manual edits, also from the `climate_edits` audit table).
 */

/** QC flag codes (single character, EDI/LTER-style). */
export const QC_FLAG = {
  GOOD: "G", // passed QC (value present, in range)
  MISSING: "M", // no value from the logger (sensor gap / NAN)
  RANGE: "R", // removed automatically: outside the plausible range
  MANUAL: "Q", // removed by manual review in the data editor
} as const;

export type QcFlagCode = (typeof QC_FLAG)[keyof typeof QC_FLAG];

/** One field's QC record stored inside the qc_flags JSON map. */
export interface QcFlagEntry {
  flag: Exclude<QcFlagCode, "G" | "M">;
  raw: number | null;
}

export type QcFlagMap = Record<string, QcFlagEntry>;

/** Parse the qc_flags JSON column into a map (empty map if null/invalid). */
export function parseQcFlags(json: string | null | undefined): QcFlagMap {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as QcFlagMap) : {};
  } catch {
    return {};
  }
}

/** Serialize a map back to JSON, or null when empty (keeps the column sparse). */
export function serializeQcFlags(map: QcFlagMap): string | null {
  return Object.keys(map).length > 0 ? JSON.stringify(map) : null;
}

/**
 * Resolve the export flag for one cell from its stored value + qc_flags entry:
 *  - an explicit R/Q entry wins,
 *  - otherwise a null value means the logger never reported it (M),
 *  - otherwise the value is good (G).
 */
export function exportFlag(
  value: number | null | undefined,
  entry: QcFlagEntry | undefined
): QcFlagCode {
  if (entry) return entry.flag;
  if (value === null || value === undefined) return QC_FLAG.MISSING;
  return QC_FLAG.GOOD;
}

/**
 * Canonical list of measured columns published in the CSV export, in order.
 * `key`   = export column name (with unit suffix, EDI-friendly)
 * `field` = camelCase field on `climateReadings` (and qc_flags key)
 * Each measured column is exported alongside a `<key>_flag` column.
 */
export const EXPORT_COLUMNS: { key: string; field: string }[] = [
  { key: "air_temp_avg_c", field: "airTempAvg" },
  { key: "air_temp_max_c", field: "airTempMax" },
  { key: "air_temp_min_c", field: "airTempMin" },
  { key: "humidity_avg_pct", field: "humidityAvg" },
  { key: "humidity_max_pct", field: "humidityMax" },
  { key: "humidity_min_pct", field: "humidityMin" },
  { key: "pressure_avg_hpa", field: "pressureAvg" },
  { key: "pressure_max_hpa", field: "pressureMax" },
  { key: "pressure_min_hpa", field: "pressureMin" },
  { key: "rain_mm_total", field: "rainMm" },
  { key: "solar_avg_wm2", field: "solarAvg" },
  { key: "solar_max_wm2", field: "solarMax" },
  { key: "solar_min_wm2", field: "solarMin" },
  { key: "wind_dir_avg_deg", field: "windDirAvg" },
  { key: "wind_dir_max_deg", field: "windDirMax" },
  { key: "wind_dir_min_deg", field: "windDirMin" },
  { key: "wind_speed_avg_ms", field: "windSpeedAvg" },
  { key: "wind_speed_max_ms", field: "windSpeedMax" },
  { key: "wind_speed_min_ms", field: "windSpeedMin" },
  { key: "mean_wind_speed_ms", field: "meanWindSpeed" },
  { key: "mean_wind_direction_deg", field: "meanWindDirection" },
  { key: "std_wind_dir_deg", field: "stdWindDir" },
];
