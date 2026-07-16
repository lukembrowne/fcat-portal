/**
 * Pure formatting helper for the landowner "example recording" clip.
 * Kept out of the client components so it stays unit-testable.
 */

/**
 * Format an audio clip duration (in seconds) as "m:ss".
 * Returns null when the duration is unknown or not a positive finite number,
 * so callers can omit the duration entirely rather than render "0:00".
 */
export function formatClipDuration(
  seconds: number | null | undefined,
): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}
