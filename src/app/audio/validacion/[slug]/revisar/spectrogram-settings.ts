/**
 * Per-reviewer spectrogram display settings for the validation review queue.
 *
 * SEPARATE from `@/lib/spectrogram-settings`, which serves the annotation page,
 * and deliberately so on two counts. Its defaults are the annotation page's
 * (gain 25, range 70), not the ones the validation clips have always been
 * rendered with server-side (gain 18, range 72, magma, 12 kHz ceiling) — sharing
 * the module would silently restyle every reviewer's spectrograms the moment
 * this ships. And the two pages want different controls: annotation has
 * colormap and follow-playback, review wants a compact row it can put above a
 * clip without stealing height from it.
 *
 * The defaults here MUST stay equal to the constants in
 * `src/lib/spectrogram-image.ts`, so an untouched review queue looks exactly
 * like the pre-rendered WebP it replaces. There is a test asserting that.
 *
 * Pure — no React, no DOM beyond a guarded localStorage read, so the migration
 * logic is unit-testable under vitest's node environment.
 */

import type { ColormapName } from "@/lib/spectrogram-colormaps";

export const STORAGE_KEY = "audio.validacion.spectrogram.v1";

export const FFT_SIZES = [512, 1024, 2048, 4096] as const;
export type FftSize = (typeof FFT_SIZES)[number];

/** Time zoom. The canvas widens by this factor and the box scrolls. */
export const ZOOM_LEVELS = [1, 2, 4] as const;
export type ZoomLevel = (typeof ZOOM_LEVELS)[number];

/** Frequency ceilings offered. BirdNET's own band tops out around 12 kHz. */
export const MAX_HZ_PRESETS = [3000, 6000, 9000, 12000] as const;

export interface ReviewSpectrogramSettings {
  version: 1;
  fftSize: FftSize;
  gainDB: number;
  rangeDB: number;
  displayMaxHz: number;
  zoom: ZoomLevel;
  colormap: ColormapName;
}

export const GAIN_RANGE = { min: 0, max: 48, step: 1 } as const;
export const CONTRAST_RANGE = { min: 30, max: 100, step: 1 } as const;

export const DEFAULT_SETTINGS: ReviewSpectrogramSettings = {
  version: 1,
  fftSize: 1024,
  gainDB: 18,
  rangeDB: 72,
  displayMaxHz: 12000,
  zoom: 1,
  colormap: "magma",
};

function isFftSize(v: unknown): v is FftSize {
  return typeof v === "number" && (FFT_SIZES as readonly number[]).includes(v);
}

function isZoomLevel(v: unknown): v is ZoomLevel {
  return typeof v === "number" && (ZOOM_LEVELS as readonly number[]).includes(v);
}

function clampNumber(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

/** Validate an unknown parsed blob. Never throws; unknown fields fall back. */
export function normalize(parsed: unknown): ReviewSpectrogramSettings {
  if (!parsed || typeof parsed !== "object") return { ...DEFAULT_SETTINGS };
  const o = parsed as Record<string, unknown>;
  return {
    version: 1,
    fftSize: isFftSize(o.fftSize) ? o.fftSize : DEFAULT_SETTINGS.fftSize,
    gainDB: clampNumber(o.gainDB, GAIN_RANGE.min, GAIN_RANGE.max, DEFAULT_SETTINGS.gainDB),
    rangeDB: clampNumber(
      o.rangeDB,
      CONTRAST_RANGE.min,
      CONTRAST_RANGE.max,
      DEFAULT_SETTINGS.rangeDB
    ),
    // Not restricted to the presets: the reviewer may have stored a Nyquist
    // ceiling from a recorder with a different sample rate.
    displayMaxHz: clampNumber(o.displayMaxHz, 1000, 96000, DEFAULT_SETTINGS.displayMaxHz),
    zoom: isZoomLevel(o.zoom) ? o.zoom : DEFAULT_SETTINGS.zoom,
    colormap: DEFAULT_SETTINGS.colormap,
  };
}

/** True when nothing has been changed from the shipped defaults. */
export function isDefault(s: ReviewSpectrogramSettings): boolean {
  return (
    s.fftSize === DEFAULT_SETTINGS.fftSize &&
    s.gainDB === DEFAULT_SETTINGS.gainDB &&
    s.rangeDB === DEFAULT_SETTINGS.rangeDB &&
    s.displayMaxHz === DEFAULT_SETTINGS.displayMaxHz &&
    s.zoom === DEFAULT_SETTINGS.zoom
  );
}

const CHANGE_EVENT = "validacion-spectrogram-change";

/*
  Snapshot cache for `useSyncExternalStore`.

  `getSnapshot` must return a REFERENTIALLY STABLE value between changes —
  parsing the JSON on every call returns a fresh object each time, which React
  reads as "the store changed" and re-renders forever. Cache on the raw string
  and only re-parse when that string actually differs.
*/
let cachedRaw: string | null = null;
let cachedValue: ReviewSpectrogramSettings = DEFAULT_SETTINGS;

export function subscribeSettings(callback: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) callback();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGE_EVENT, callback);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHANGE_EVENT, callback);
  };
}

export function getSettingsSnapshot(): ReviewSpectrogramSettings {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return DEFAULT_SETTINGS;
  }
  if (raw === cachedRaw) return cachedValue;
  cachedRaw = raw;
  cachedValue = raw ? normalize(safeParse(raw)) : DEFAULT_SETTINGS;
  return cachedValue;
}

/** Hydration reads this, so the first client render matches the server's. */
export function getServerSettingsSnapshot(): ReviewSpectrogramSettings {
  return DEFAULT_SETTINGS;
}

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function saveSettings(settings: ReviewSpectrogramSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private-mode Safari, quota exceeded — the settings just do not persist,
    // and the event below still updates this tab for the rest of the session.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
