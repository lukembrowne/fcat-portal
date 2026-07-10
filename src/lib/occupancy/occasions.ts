/**
 * Occasion (repeat-survey) binning for single-season occupancy.
 *
 * A site's active window is tiled into fixed-width bins (default 5 days). The
 * final bin is often ragged (deployment lengths are rarely divisible by the bin
 * width). Rather than drop the ragged tail — which loses real survey effort — we
 * keep it and expose `nDays` per occasion so the caller can carry
 * survey-effort-in-days as a (categorical) detection covariate. See
 * `docs/brainstorms/2026-07-03-occupancy-modeling-requirements.md`.
 */
import { addDays, daysBetween, type CaptureDay } from "./capture-date";

export interface OccasionLayout {
  /** Number of occasions tiling the window (last one may be ragged). */
  count: number;
  /** Days of active survey in each occasion (`count` entries; last ≤ binWidth). */
  nDays: number[];
  /** Inclusive UTC day the window starts on. */
  start: CaptureDay;
  /** Total inclusive days in the window. */
  totalDays: number;
}

export const DEFAULT_BIN_WIDTH_DAYS = 5;

/**
 * Lay out occasions across an inclusive `[start, end]` day window.
 * Throws on an inverted window so bad site metadata surfaces loudly rather than
 * producing an empty frame.
 */
export function computeOccasions(
  start: CaptureDay,
  end: CaptureDay,
  binWidth: number = DEFAULT_BIN_WIDTH_DAYS,
): OccasionLayout {
  if (!Number.isInteger(binWidth) || binWidth < 1) {
    throw new Error(`binWidth must be a positive integer, got ${binWidth}`);
  }
  const totalDays = daysBetween(start, end) + 1; // inclusive
  if (totalDays < 1) {
    throw new Error(
      `Inverted window: start=${start.toISOString()} end=${end.toISOString()}`,
    );
  }
  const count = Math.ceil(totalDays / binWidth);
  const nDays: number[] = [];
  for (let j = 0; j < count; j++) {
    nDays.push(Math.min(binWidth, totalDays - j * binWidth));
  }
  return { count, nDays, start, totalDays };
}

/**
 * Occasion index (0-based) a capture day falls into, or `null` if the day lies
 * outside the window. Days before the start or after the end are out of window.
 */
export function occasionIndexForDay(
  layout: OccasionLayout,
  captureDay: CaptureDay,
  binWidth: number = DEFAULT_BIN_WIDTH_DAYS,
): number | null {
  const offset = daysBetween(layout.start, captureDay);
  if (offset < 0 || offset >= layout.totalDays) return null;
  const idx = Math.floor(offset / binWidth);
  return idx < layout.count ? idx : null;
}

/**
 * Bucket survey-effort day-counts into coarse categorical levels for use as an
 * `unmarked` detection covariate. Full bins collapse to one level; short
 * (ragged/partial) bins get their own levels so effort differences are
 * controlled for without exploding the factor. Returns a stable string label.
 */
export function effortLevel(
  nDays: number,
  binWidth: number = DEFAULT_BIN_WIDTH_DAYS,
): string {
  if (nDays >= binWidth) return `full`; // full-width bin
  if (nDays <= 1) return `1d`;
  return `${nDays}d`;
}

/** The last day (inclusive) of occasion `j`. Useful for lunar/DOY covariates. */
export function occasionEndDay(layout: OccasionLayout, j: number, binWidth = DEFAULT_BIN_WIDTH_DAYS): CaptureDay {
  const startOffset = j * binWidth;
  const end = Math.min(startOffset + layout.nDays[j] - 1, layout.totalDays - 1);
  return addDays(layout.start, end);
}
