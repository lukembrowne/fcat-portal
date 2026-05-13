/**
 * Persisted user preferences for the audio annotation spectrogram.
 *
 * Stored under `audio.spectrogram.v1` in localStorage. The `.v1` suffix is a
 * legacy artifact from the pre-version-discriminator era — going forward, the
 * `version` field inside the JSON is the migration anchor, and the key name
 * stays stable so users don't lose preferences across this change.
 *
 * Per-browser (not per-user-account) — multiple verifiers on the same
 * workstation share preferences. Matches the existing pattern elsewhere in
 * the codebase (deployments-table, species-display, etc.).
 *
 * Pure helpers — no React imports here so the type/migration logic stays
 * isomorphic and unit-testable under vitest's node environment.
 */

import { COLORMAP_NAMES, type ColormapName } from "@/lib/spectrogram-colormaps";
import {
  isHeightPreset,
  isZoomLevel,
  type HeightPreset,
  type ZoomLevel,
} from "@/lib/spectrogram-layout";

export const STORAGE_KEY = "audio.spectrogram.v1";

export type FftSize = 512 | 1024 | 2048;

interface BaseSettings {
  displayMaxHz: number;
  gainDB: number;
  rangeDB: number;
  fftSize: FftSize;
  colormap: ColormapName;
}

export interface SettingsV1 extends BaseSettings {
  version: 1;
}

export interface SettingsV2 extends BaseSettings {
  version: 2;
  spectrogramHeight: HeightPreset;
  zoomLevel: ZoomLevel;
  followPlayback: boolean;
}

export type StoredSettings = SettingsV1 | SettingsV2;
export type CurrentSettings = SettingsV2;

export const DEFAULT_SETTINGS: CurrentSettings = {
  version: 2,
  displayMaxHz: 12000,
  gainDB: 25,
  rangeDB: 70,
  fftSize: 1024,
  colormap: "magma",
  spectrogramHeight: "comodo",
  zoomLevel: 1,
  followPlayback: true,
};

/**
 * Exhaustive-switch migration from any prior version to the current shape.
 * Adding a new version: append a `case`; the `never` assertion in `default`
 * fails to compile until the new case lands.
 */
export function migrate(stored: StoredSettings): CurrentSettings {
  switch (stored.version) {
    case 1:
      return {
        ...stored,
        version: 2,
        spectrogramHeight: DEFAULT_SETTINGS.spectrogramHeight,
        zoomLevel: DEFAULT_SETTINGS.zoomLevel,
        followPlayback: DEFAULT_SETTINGS.followPlayback,
      };
    case 2:
      return stored;
    default: {
      const _exhaustive: never = stored;
      void _exhaustive;
      return DEFAULT_SETTINGS;
    }
  }
}

/**
 * Validate an `unknown` parsed-JSON blob and produce a typed `StoredSettings`.
 * Missing or invalid field values fall back to `DEFAULT_SETTINGS`. Missing
 * `version` defaults to `1` (matches the on-disk shape that existed before
 * this change). Never throws.
 */
export function normalize(parsed: unknown): StoredSettings {
  if (!parsed || typeof parsed !== "object") {
    return { ...DEFAULT_SETTINGS };
  }
  const obj = parsed as Record<string, unknown>;
  const version: 1 | 2 = obj.version === 2 ? 2 : 1;

  const base: BaseSettings = {
    displayMaxHz:
      typeof obj.displayMaxHz === "number"
        ? obj.displayMaxHz
        : DEFAULT_SETTINGS.displayMaxHz,
    gainDB:
      typeof obj.gainDB === "number" ? obj.gainDB : DEFAULT_SETTINGS.gainDB,
    rangeDB:
      typeof obj.rangeDB === "number" ? obj.rangeDB : DEFAULT_SETTINGS.rangeDB,
    fftSize:
      obj.fftSize === 512 || obj.fftSize === 1024 || obj.fftSize === 2048
        ? obj.fftSize
        : DEFAULT_SETTINGS.fftSize,
    colormap:
      typeof obj.colormap === "string" &&
      (COLORMAP_NAMES as readonly string[]).includes(obj.colormap)
        ? (obj.colormap as ColormapName)
        : DEFAULT_SETTINGS.colormap,
  };

  if (version === 1) return { ...base, version: 1 };

  return {
    ...base,
    version: 2,
    spectrogramHeight: isHeightPreset(obj.spectrogramHeight)
      ? obj.spectrogramHeight
      : DEFAULT_SETTINGS.spectrogramHeight,
    zoomLevel: isZoomLevel(obj.zoomLevel)
      ? obj.zoomLevel
      : DEFAULT_SETTINGS.zoomLevel,
    followPlayback:
      typeof obj.followPlayback === "boolean"
        ? obj.followPlayback
        : DEFAULT_SETTINGS.followPlayback,
  };
}

export function loadStoredSettings(): CurrentSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return migrate(normalize(JSON.parse(raw)));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveStoredSettings(settings: CurrentSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private-mode Safari, quota exceeded, etc. — silent fallback.
  }
}
