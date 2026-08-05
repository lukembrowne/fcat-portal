export const MIN_BRIGHTNESS = 0.4;
export const MAX_BRIGHTNESS = 1.6;
export const DEFAULT_BRIGHTNESS = 1.0;

export const MIN_CONTRAST = 0.6;
export const MAX_CONTRAST = 2.0;
export const DEFAULT_CONTRAST = 1.0;

/** Contrast compensation that a brightness change needs on its own.
 *  Darkening washes out whites; brightening washes out blacks — both
 *  benefit from a symmetric contrast bump proportional to the distance
 *  travelled. Rounded here (not at the call site) so the value is stable
 *  before anything multiplies on top of it. */
export function autoContrast(b: number): number {
  return Math.round((1 + Math.abs(1 - b) * 0.6) * 100) / 100;
}

/** Map a single brightness slider value (0.4-1.6) to a paired CSS filter
 *  that compensates for the contrast loss brightness changes create.
 *  brightness=1 returns "" (no-op). */
export function brightnessFilter(b: number): string {
  if (b === DEFAULT_BRIGHTNESS) return "";
  return `brightness(${b}) contrast(${autoContrast(b)})`;
}

/** Compose the brightness slider with the user's contrast slider.
 *
 *  User contrast multiplies on top of the automatic compensation rather
 *  than replacing it, so at contrast=1 the output is byte-identical to
 *  brightnessFilter() — the `\` shortcut keeps behaving exactly as it did
 *  before the contrast slider existed. Rounding the automatic term before
 *  multiplying is what makes that identity exact.
 *
 *  No-op terms are dropped, so a contrast-only adjustment emits just
 *  "contrast(1.4)" and both-at-default emits "". */
export function imageAdjustFilter(brightness: number, contrast: number): string {
  const composed = Math.round(autoContrast(brightness) * contrast * 100) / 100;
  const terms: string[] = [];
  if (brightness !== DEFAULT_BRIGHTNESS) terms.push(`brightness(${brightness})`);
  if (composed !== DEFAULT_CONTRAST) terms.push(`contrast(${composed})`);
  return terms.join(" ");
}
