/**
 * Pure layout constants and derived types for the audio annotation spectrogram.
 *
 * No React, no DOM, no localStorage. Both the spectrogram component and the
 * settings module derive their literal-union types from the const arrays
 * declared here so there's a single source of truth — never hand-write
 * `"compacto" | "comodo" | "alto"` or `1 | 2 | 4 | 8` elsewhere.
 */

export const FREQ_AXIS_WIDTH = 70;
export const TIME_AXIS_HEIGHT = 24;

export const SPEC_HEIGHT_PRESETS = {
  compacto: 256,
  comodo: 350,
  alto: 480,
} as const;

export const ZOOM_LEVELS = [1, 2, 4, 8] as const;

export type HeightPreset = keyof typeof SPEC_HEIGHT_PRESETS;
export type ZoomLevel = (typeof ZOOM_LEVELS)[number];

export const HEIGHT_PRESETS: readonly HeightPreset[] = [
  "compacto",
  "comodo",
  "alto",
] as const;

export function heightForPreset(preset: HeightPreset): number {
  return SPEC_HEIGHT_PRESETS[preset];
}

export function isHeightPreset(value: unknown): value is HeightPreset {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(SPEC_HEIGHT_PRESETS, value)
  );
}

export function isZoomLevel(value: unknown): value is ZoomLevel {
  return (
    typeof value === "number" &&
    (ZOOM_LEVELS as readonly number[]).includes(value)
  );
}
