/**
 * Parse an iButton XLSX header "sample rate" string into seconds.
 *
 * Observed formats in the wild:
 *   "30 min", "00:30:00", "1 hr", "60 sec"
 *
 * Returns null if the input can't be interpreted, letting callers fall back
 * to a derived interval from stored readings.
 */
export function parseSampleRateSeconds(raw: string | null): number | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;

  // "HH:MM:SS"
  const hms = s.match(/^(\d+):(\d+):(\d+)$/);
  if (hms) {
    return Number(hms[1]) * 3600 + Number(hms[2]) * 60 + Number(hms[3]);
  }

  // "N min", "N minute", "N minutes"
  const min = s.match(/^(\d+)\s*(min|mins|minute|minutes)$/);
  if (min) return Number(min[1]) * 60;

  // "N hr", "N hour", "N hours"
  const hr = s.match(/^(\d+)\s*(hr|hrs|hour|hours)$/);
  if (hr) return Number(hr[1]) * 3600;

  // "N sec", "N second", "N seconds", "Ns"
  const sec = s.match(/^(\d+)\s*(s|sec|secs|second|seconds)$/);
  if (sec) return Number(sec[1]);

  return null;
}
