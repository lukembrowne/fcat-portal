/**
 * Ecuador wall-clock formatting that never depends on the server's timezone.
 *
 * Field data (camera clocks, recorder filenames, ODK dates, the QA "ventana
 * válida") is all Ecuador local time: UTC-5, no daylight saving. The production
 * container runs `TZ=America/New_York`, which agrees with Ecuador only in
 * winter, so local `Date` getters (`getHours()`, `toLocaleTimeString()` without
 * a `timeZone`) read one hour late from March to November. That shifted every
 * QA window tagged in that period by +1 h. Compute Ecuador time from the
 * instant directly instead.
 */

export const ECUADOR_TZ = "America/Guayaquil";

const ECUADOR_OFFSET_MS = -5 * 60 * 60 * 1000;

/** The Ecuador wall clock of an instant, as a `Date` to be read with UTC getters only. */
function shifted(at: Date): Date {
  return new Date(at.getTime() + ECUADOR_OFFSET_MS);
}

/** `"YYYY-MM-DDTHH:mm"` in Ecuador time: the `datetime-local` format the QA window stores. */
export function ecuadorWallClock(at: Date): string {
  return shifted(at).toISOString().slice(0, 16);
}

/** `"YYYY-MM-DD"` in Ecuador time. */
export function ecuadorDay(at: Date): string {
  return shifted(at).toISOString().slice(0, 10);
}

/** Calendar parts of an instant in Ecuador time. */
export function ecuadorParts(at: Date): { year: number; month: number; day: number } {
  const s = shifted(at);
  return { year: s.getUTCFullYear(), month: s.getUTCMonth() + 1, day: s.getUTCDate() };
}
