/**
 * Where the detection sits inside its clip, and when the clip was recorded.
 *
 * Pure and dependency-free so the review page's spectrogram overlay can be
 * covered without ffmpeg, sharp, or a DOM. `clip-cache.ts` re-exports
 * `clipWindow` from here rather than defining its own copy: the audio cut and
 * the overlay MUST agree on the window, and two implementations of the same
 * clamp is how the band ends up misaligned only on edge cases.
 */

/** Context padding either side of the detection, so the call is not clipped. */
export const CLIP_PADDING_SECONDS = 3;

export interface ClipWindow {
  start: number;
  end: number;
}

/**
 * Detection window plus padding, clamped to the file.
 *
 * A detection at t=0.5s would otherwise produce a negative `-ss`, and one
 * ending at 59.5s would run past the end of a 60s recording.
 */
export function clipWindow(source: {
  startTime: number;
  endTime: number;
  duration: number | null;
}): ClipWindow {
  const limit =
    source.duration != null && Number.isFinite(source.duration) && source.duration > 0
      ? source.duration
      : Number.POSITIVE_INFINITY;

  const start = Math.max(0, source.startTime - CLIP_PADDING_SECONDS);
  const end = Math.min(limit, source.endTime + CLIP_PADDING_SECONDS);
  // Degenerate windows (bad detection bounds) still get a listenable clip.
  return end > start ? { start, end } : { start, end: start + 1 };
}

export interface DetectionBand {
  /** Left edge of the detection as a percentage of the clip's width. */
  leftPct: number;
  /** Right edge, likewise. */
  rightPct: number;
}

/**
 * The detection's extent as percentages across the clip.
 *
 * NOT a fixed 33%–67%. The clip window clamps at both ends, so a detection near
 * the start or end of a recording gets less padding on that side and sits
 * off-centre. Hardcoding the midpoint produces a band that is subtly wrong on
 * exactly the edge cases and looks right everywhere else.
 *
 * Only the time axis is expressed. BirdNET records `min_freq = 0,
 * max_freq = 15000` on essentially every detection (2,491,918 of 2,491,919 rows
 * as of 2026-08) — a placeholder, not a measurement — so a frequency box would
 * be a full-height rectangle on every clip, and would extend past the top of an
 * image whose display ceiling is 12 kHz.
 */
export function detectionBand(
  win: ClipWindow,
  detection: { startTime: number; endTime: number }
): DetectionBand {
  const span = win.end - win.start;
  if (!Number.isFinite(span) || span <= 0) return { leftPct: 0, rightPct: 100 };

  const clamp = (value: number) => Math.min(100, Math.max(0, value));
  const rawLeft = ((detection.startTime - win.start) / span) * 100;
  const rawRight = ((detection.endTime - win.start) / span) * 100;

  // Inverted detection bounds (end before start) exist in the data and would
  // otherwise produce a reversed band. Order first, then clamp.
  const left = clamp(Math.min(rawLeft, rawRight));
  const right = clamp(Math.max(rawLeft, rawRight));

  // A zero-width band is invisible. Widen by a sliver, away from whichever
  // edge it is pinned against so the result stays inside 0-100.
  const MIN_WIDTH = 1;
  if (right - left >= MIN_WIDTH) return { leftPct: left, rightPct: right };
  return right + MIN_WIDTH <= 100
    ? { leftPct: left, rightPct: right + MIN_WIDTH }
    : { leftPct: Math.max(0, left - MIN_WIDTH), rightPct: right };
}

const FILENAME_TIMESTAMP = /_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\./;

/**
 * The clip's wall-clock recording time: the filename's timestamp plus the
 * detection's offset into the file.
 *
 * Audio filenames encode ECUADOR LOCAL time with no offset — the same
 * convention the iButton parser documents — so the arithmetic must not
 * round-trip through a local-timezone `Date` constructor. `new Date(y, m, d…)`
 * interprets its arguments in the host's zone and formatting them back in that
 * zone would appear to work on a developer laptop while shifting every
 * timestamp by five hours in a UTC container. Composing through `Date.UTC` and
 * reading back with UTC getters keeps the components untouched.
 *
 * Returns null when the filename does not carry a timestamp, so callers render
 * nothing rather than "Invalid Date".
 */
export function recordingInstant(
  filename: string | null | undefined,
  offsetSeconds: number
): string | null {
  if (!filename) return null;
  const match = filename.match(FILENAME_TIMESTAMP);
  if (!match) return null;

  const [, y, mo, d, h, mi, s] = match;
  const base = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s)
  );
  const at = new Date(base + Math.round(offsetSeconds) * 1000);

  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}` +
    ` ${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`
  );
}
