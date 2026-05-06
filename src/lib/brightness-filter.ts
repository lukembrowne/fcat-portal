export const MIN_BRIGHTNESS = 0.4;
export const MAX_BRIGHTNESS = 1.0;
export const DEFAULT_BRIGHTNESS = 1.0;

/** Map a single brightness slider value (0.4-1.0) to a paired CSS filter
 *  that compensates for the contrast loss pure brightness reduction
 *  creates. brightness=1 returns "" (the no-op identity). */
export function brightnessFilter(b: number): string {
  if (b === DEFAULT_BRIGHTNESS) return "";
  const contrast = Math.round((1 + (1 - b) * 0.6) * 100) / 100;
  return `brightness(${b}) contrast(${contrast})`;
}
