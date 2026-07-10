/**
 * Capture-date resolution for occupancy occasion binning.
 *
 * Spike finding (2026-07-03): `biochoco_images.exif_timestamp` is populated for
 * only ~20 of 23,304 images, so the reliable capture-date source is the
 * filename (camera-trap filenames embed `YYYYMMDD`, e.g.
 * `"Uno - 20130708 - MFDC0007.JPG"`). We parse the filename first and fall back
 * to exif when present. A UTC calendar day is all occupancy needs — occasion
 * bins are day-granular, so we deliberately discard sub-day time and timezone.
 */

/** A capture date reduced to a UTC calendar day (midnight UTC). */
export type CaptureDay = Date;

const YYYYMMDD = /(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/g;

/** Lower/upper plausible bounds — rejects obvious garbage tokens (serials, etc.). */
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

function toUtcDay(year: number, month1: number, day: number): CaptureDay | null {
  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  if (month1 < 1 || month1 > 12) return null;
  if (day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month1 - 1, day));
  // Reject impossible dates (e.g. 20130230 rolling over to March).
  if (
    d.getUTCFullYear() !== year ||
    d.getUTCMonth() !== month1 - 1 ||
    d.getUTCDate() !== day
  ) {
    return null;
  }
  return d;
}

/**
 * Extract a capture day from a camera-trap filename by finding the first
 * plausible `YYYYMMDD` token. Returns null if none is found.
 */
export function parseCaptureDayFromFilename(
  filename: string | null | undefined,
): CaptureDay | null {
  if (!filename) return null;
  // Reset the stateful global regex before each scan.
  YYYYMMDD.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = YYYYMMDD.exec(filename)) !== null) {
    const day = toUtcDay(
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
    );
    if (day) return day;
  }
  return null;
}

/** Parse an ISO-ish exif timestamp into a UTC calendar day. */
export function parseCaptureDayFromExif(
  exif: string | null | undefined,
): CaptureDay | null {
  if (!exif) return null;
  const t = Date.parse(exif);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * Resolve an image's capture day, filename first (see module note), exif as
 * fallback. Returns null when neither yields a plausible date — callers must
 * treat that as an excluded image with an explicit reason, never a silent drop.
 */
export function resolveCaptureDay(image: {
  filename?: string | null;
  exifTimestamp?: string | null;
}): CaptureDay | null {
  return (
    parseCaptureDayFromFilename(image.filename) ??
    parseCaptureDayFromExif(image.exifTimestamp)
  );
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole-day difference between two UTC calendar days (b - a). */
export function daysBetween(a: CaptureDay, b: CaptureDay): number {
  return Math.round((b.getTime() - a.getTime()) / MS_PER_DAY);
}

/** Add whole days to a UTC calendar day. */
export function addDays(day: CaptureDay, n: number): CaptureDay {
  return new Date(day.getTime() + n * MS_PER_DAY);
}
