/**
 * Capture-date resolution for occupancy occasion binning.
 *
 * Spike finding (2026-07-03): `biochoco_images.exif_timestamp` is populated for
 * only ~50 of 133k images. Legacy camera-trap filenames embed `YYYYMMDD` (e.g.
 * `"Uno - 20130708 - MFDC0007.JPG"`), but current field data uses dateless
 * time-of-day filenames (e.g. `"084348_0101.jpg"`). For those, the only usable
 * capture-day signal is `biochoco_images.file_modified` (Unix seconds), which
 * tracks true capture day: on prod (2026-07-10) dep 121's 2,121 images spread
 * over 30 distinct file_modified days aligned to its 30-day deployment window —
 * a bulk-upload time would collapse to 1–2 days, so this is capture time, not
 * upload time. Resolution order: filename → exif → file_modified. A UTC calendar
 * day is all occupancy needs — occasion bins are day-granular, so we deliberately
 * discard sub-day time and timezone.
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
 * Parse a Unix-seconds file-modification time into a UTC calendar day. Reuses
 * `toUtcDay`'s 2000–2100 bound so a 0/garbage epoch (→ 1970) is rejected rather
 * than binned as a real occasion.
 */
export function parseCaptureDayFromFileModified(
  fileModified: number | null | undefined,
): CaptureDay | null {
  if (fileModified == null || !Number.isFinite(fileModified)) return null;
  const d = new Date(fileModified * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return toUtcDay(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/**
 * Resolve an image's capture day: filename first (see module note), then exif,
 * then file_modified (the only signal for dateless current filenames). Returns
 * null when none yields a plausible date — callers must treat that as an excluded
 * image with an explicit reason, never a silent drop.
 */
export function resolveCaptureDay(image: {
  filename?: string | null;
  exifTimestamp?: string | null;
  fileModified?: number | null;
}): CaptureDay | null {
  return (
    parseCaptureDayFromFilename(image.filename) ??
    parseCaptureDayFromExif(image.exifTimestamp) ??
    parseCaptureDayFromFileModified(image.fileModified)
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
