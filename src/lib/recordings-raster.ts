/**
 * Helpers for the audio-deployment raster on /audio/[id].
 *
 * Three pure functions — easy to unit-test, no React, no SVG, no DOM.
 *
 *   buildCells(files, metricKey)  → { cells, dates }
 *   computeDomain(cells)          → [0, max]
 *   metricToFill(value, domain)   → CSS color string
 *
 * The cell layer renders directly from these, with no precomputed presentation
 * stored on the cell — fill is computed at render time.
 */

import type { AudioFileRow } from "@/app/audio/actions";
import type { AcousticIndexKey } from "@/lib/acoustic-indices";

export type RasterMetricKey = "detectionCount" | AcousticIndexKey;

export interface RasterCell {
  fileId: number;
  filename: string;
  recordedDate: string;      // "YYYY-MM-DD" Ecuador local
  recordedTime: string;      // "HH:MM:SS" Ecuador local
  dayIndex: number;          // 0..N-1 (oldest day = 0)
  minuteOfDay: number;       // 0..1439
  detectionCount: number;
  metricValue: number | null;
}

export type ScaleDomain = readonly [lo: number, hi: number];

export interface RasterBuildResult {
  cells: RasterCell[];
  /** Sorted ascending; index in this array == dayIndex on each cell. */
  dates: string[];
  /** Files whose filename timestamp could not be parsed — omitted from the grid. */
  skippedCount: number;
}

/** Extract a single metric value from an audio-file row. */
function readMetric(file: AudioFileRow, key: RasterMetricKey): number | null {
  switch (key) {
    case "detectionCount":
      return file.detectionCount;
    case "soundscapeSaturation":
      return file.soundscapeSaturation;
    case "acousticComplexityIndex":
      return file.acousticComplexityIndex;
    case "frequencyEntropy":
      return file.frequencyEntropy;
    case "temporalEntropy":
      return file.temporalEntropy;
    case "eventsPerSecond":
      return file.eventsPerSecond;
  }
}

/** Convert "HH:MM:SS" → minutes since midnight. */
function minutesFromTime(time: string): number {
  const [h, m] = time.split(":");
  return Number(h) * 60 + Number(m);
}

/**
 * Build cells and the deployment-wide date range.
 * Files without a parseable filename timestamp are dropped (skippedCount tracks them).
 */
export function buildCells(
  files: AudioFileRow[],
  metricKey: RasterMetricKey
): RasterBuildResult {
  const dateSet = new Set<string>();
  const placed: Array<{
    file: AudioFileRow;
    recordedDate: string;
    recordedTime: string;
  }> = [];
  let skippedCount = 0;

  for (const file of files) {
    if (file.recordedDate && file.recordedTime) {
      dateSet.add(file.recordedDate);
      placed.push({
        file,
        recordedDate: file.recordedDate,
        recordedTime: file.recordedTime,
      });
    } else {
      skippedCount += 1;
    }
  }

  const dates = Array.from(dateSet).sort();           // YYYY-MM-DD sorts lexically
  const dayIndex = new Map(dates.map((d, i) => [d, i] as const));

  const cells: RasterCell[] = placed.map(({ file, recordedDate, recordedTime }) => ({
    fileId: file.id,
    filename: file.filename,
    recordedDate,
    recordedTime,
    dayIndex: dayIndex.get(recordedDate)!,
    minuteOfDay: minutesFromTime(recordedTime),
    detectionCount: file.detectionCount,
    metricValue: readMetric(file, metricKey),
  }));

  return { cells, dates, skippedCount };
}

/** Domain for the color scale. v1 uses [0, max] — outlier clamping deferred. */
export function computeDomain(cells: RasterCell[]): ScaleDomain {
  let hi = 0;
  for (const cell of cells) {
    if (cell.metricValue !== null && cell.metricValue > hi) {
      hi = cell.metricValue;
    }
  }
  return [0, hi];
}

const SCALE_STOPS = 5;
const SCALE_SEGMENTS = SCALE_STOPS - 1;

/**
 * Map a metric value to a CSS color string.
 * - null → `var(--muted)` (the file exists but the metric isn't computed).
 * - 0..hi → 5-stop oklch ramp interpolated with CSS color-mix.
 */
export function metricToFill(
  value: number | null,
  [lo, hi]: ScaleDomain
): string {
  if (value === null) return "var(--muted)";
  if (hi === lo) return "var(--raster-scale-0)";
  const t = Math.min(1, Math.max(0, (value - lo) / (hi - lo)));
  const i = Math.min(SCALE_SEGMENTS - 1, Math.floor(t * SCALE_SEGMENTS));
  const localT = t * SCALE_SEGMENTS - i;
  const lower = `var(--raster-scale-${i})`;
  const upper = `var(--raster-scale-${i + 1})`;
  return `color-mix(in oklch, ${lower} ${((1 - localT) * 100).toFixed(2)}%, ${upper})`;
}

/** Spanish labels for the metric selector. */
export const RASTER_METRIC_LABELS: Record<RasterMetricKey, string> = {
  detectionCount: "Detecciones (BirdNET)",
  soundscapeSaturation: "Saturación del paisaje sonoro",
  acousticComplexityIndex: "Índice de complejidad acústica (ACI)",
  frequencyEntropy: "Entropía de frecuencia",
  temporalEntropy: "Entropía temporal",
  eventsPerSecond: "Eventos por segundo",
};

/** All metric keys, in display order. */
export const RASTER_METRIC_KEYS: readonly RasterMetricKey[] = [
  "detectionCount",
  "soundscapeSaturation",
  "acousticComplexityIndex",
  "frequencyEntropy",
  "temporalEntropy",
  "eventsPerSecond",
];
