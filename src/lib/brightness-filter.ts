export const MIN_BRIGHTNESS = 0.4;
export const MAX_BRIGHTNESS = 1.6;
export const DEFAULT_BRIGHTNESS = 1.0;

/** Map a single brightness slider value (0.4-1.6) to a paired CSS filter
 *  that compensates for the contrast loss brightness changes create.
 *  Darkening washes out whites; brightening washes out blacks — both
 *  benefit from a symmetric contrast bump. brightness=1 returns "" (no-op). */
export function brightnessFilter(b: number): string {
  if (b === DEFAULT_BRIGHTNESS) return "";
  const contrast = Math.round((1 + Math.abs(1 - b) * 0.6) * 100) / 100;
  return `brightness(${b}) contrast(${contrast})`;
}
