import { parseSampleRateSeconds } from "./sample-rate";

export const LOW_COVERAGE_THRESHOLD = 95;

export interface CoverageInputs {
  odkDeployAt: string | null; // "YYYY-MM-DD HH:mm:ss"
  odkRetrieveAt: string | null;
  sampleRate: string | null; // raw from iButton header
  rowsImported: number;
  dateRangeStart: string | null; // first stored reading
  dateRangeEnd: string | null; // last stored reading
}

export interface CoverageResult {
  odkDeployAt: string | null;
  odkRetrieveAt: string | null;
  intervalSeconds: number | null;
  expectedReadings: number | null;
  coveragePct: number | null; // null when window unknown
  hasLowCoverage: boolean;
}

/**
 * Parse a naive "YYYY-MM-DD HH:mm:ss" timestamp as seconds since epoch.
 * iButton + ODK times are stored as Ecuador local (UTC-5) without offsets;
 * treating them as UTC is safe because duration math cancels the offset.
 */
function parseTimestampSeconds(s: string | null): number | null {
  if (!s) return null;
  const t = Date.parse(s.replace(" ", "T") + "Z");
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

export function computeCoverage(inputs: CoverageInputs): CoverageResult {
  const {
    odkDeployAt,
    odkRetrieveAt,
    sampleRate,
    rowsImported,
    dateRangeStart,
    dateRangeEnd,
  } = inputs;

  // Interval: parse sample rate, else derive from stored range.
  let intervalSeconds = parseSampleRateSeconds(sampleRate);
  if (intervalSeconds === null && rowsImported >= 2) {
    const a = parseTimestampSeconds(dateRangeStart);
    const b = parseTimestampSeconds(dateRangeEnd);
    if (a !== null && b !== null && b > a) {
      intervalSeconds = Math.round((b - a) / (rowsImported - 1));
    }
  }

  const deploySec = parseTimestampSeconds(odkDeployAt);
  const retrieveSec = parseTimestampSeconds(odkRetrieveAt);

  let expectedReadings: number | null = null;
  let coveragePct: number | null = null;

  if (
    deploySec !== null &&
    retrieveSec !== null &&
    retrieveSec > deploySec &&
    intervalSeconds &&
    intervalSeconds > 0
  ) {
    const windowSeconds = retrieveSec - deploySec;
    expectedReadings = Math.floor(windowSeconds / intervalSeconds) + 1;
    if (expectedReadings > 0) {
      const pct = Math.round((rowsImported / expectedReadings) * 100);
      coveragePct = Math.min(100, Math.max(0, pct));
    }
  }

  const hasLowCoverage =
    coveragePct !== null && coveragePct < LOW_COVERAGE_THRESHOLD;

  return {
    odkDeployAt,
    odkRetrieveAt,
    intervalSeconds,
    expectedReadings,
    coveragePct,
    hasLowCoverage,
  };
}

/**
 * Compute the maximum gap (in seconds) between consecutive timestamps in
 * an ordered reading array. Returns null if fewer than 2 readings.
 */
export function computeMaxGapSeconds(
  timestamps: readonly string[]
): number | null {
  if (timestamps.length < 2) return null;
  let max = 0;
  let prev = parseTimestampSeconds(timestamps[0]);
  for (let i = 1; i < timestamps.length; i++) {
    const cur = parseTimestampSeconds(timestamps[i]);
    if (prev !== null && cur !== null) {
      const gap = cur - prev;
      if (gap > max) max = gap;
    }
    prev = cur;
  }
  return max;
}

/**
 * Human-readable duration formatter: `2h 15m`, `45m`, `3d 2h`, `30s`.
 */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "—";
  if (seconds === 0) return "0s";

  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (days > 0) {
    return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }
  if (hours > 0) {
    return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    return secs > 0 && minutes < 10 ? `${minutes}m ${secs}s` : `${minutes}m`;
  }
  return `${secs}s`;
}
