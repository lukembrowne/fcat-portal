"use client";

import { useEffect, useCallback } from "react";
import { COLORMAP_NAMES, type ColormapName } from "@/lib/spectrogram-colormaps";
import { ZOOM_LEVELS, type ZoomLevel } from "@/lib/spectrogram-layout";
import {
  DEFAULT_SETTINGS,
  loadStoredSettings,
  saveStoredSettings,
  type CurrentSettings,
} from "@/lib/spectrogram-settings";

// Re-export the canonical settings type + helpers so the rest of the annotate
// page imports from one place. (Pre-existing import shape; we're shifting the
// source of truth to `@/lib/spectrogram-settings` without breaking callers.)
export type SpectrogramSettings = CurrentSettings;
export { DEFAULT_SETTINGS, loadStoredSettings };

const Y_MAX_PRESETS_HZ: readonly number[] = [3000, 6000, 9000, 12000];

interface SpectrogramControlsProps {
  settings: SpectrogramSettings;
  onChange: (next: SpectrogramSettings) => void;
  /** Used to compute the Nyquist preset label; null until audio decoded. */
  sampleRate: number | null;
  /** Rendered at the end of the controls row — used to slot in the
   *  confidence-threshold slider + "show all" toggle without nesting flex
   *  containers. */
  trailing?: React.ReactNode;
}

export function SpectrogramControls({ settings, onChange, sampleRate, trailing }: SpectrogramControlsProps) {
  // Persist on every change. saveStoredSettings is a silent no-op when
  // localStorage is unavailable (SSR, private-mode Safari, quota exceeded).
  useEffect(() => {
    saveStoredSettings(settings);
  }, [settings]);

  const update = useCallback(
    <K extends keyof SpectrogramSettings>(key: K, value: SpectrogramSettings[K]) => {
      onChange({ ...settings, [key]: value });
    },
    [settings, onChange]
  );

  const nyquist = sampleRate ? Math.round(sampleRate / 2) : null;
  const presets = nyquist ? [...Y_MAX_PRESETS_HZ, nyquist] : Y_MAX_PRESETS_HZ;

  return (
    <div className="flex items-center gap-4 px-3 py-1.5 border-b bg-background text-xs flex-wrap">
      <Field label="Frecuencia máx">
        <select
          value={settings.displayMaxHz}
          onChange={(e) => update("displayMaxHz", Number(e.target.value))}
          className="bg-background border rounded px-1.5 py-0.5"
        >
          {presets.map((hz) => (
            <option key={hz} value={hz}>
              {hz === nyquist ? "Máx (Nyquist)" : `${hz / 1000} kHz`}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Tamaño FFT" title="Resolución temporal vs frecuencia">
        <select
          value={settings.fftSize}
          onChange={(e) => update("fftSize", Number(e.target.value) as 512 | 1024 | 2048)}
          className="bg-background border rounded px-1.5 py-0.5"
        >
          <option value={512}>512</option>
          <option value={1024}>1024</option>
          <option value={2048}>2048</option>
        </select>
      </Field>

      <Field label="Mapa de color">
        <select
          value={settings.colormap}
          onChange={(e) => update("colormap", e.target.value as ColormapName)}
          className="bg-background border rounded px-1.5 py-0.5 capitalize"
        >
          {COLORMAP_NAMES.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Zoom" title="Acercar el espectrograma en el eje del tiempo">
        <select
          value={settings.zoomLevel}
          onChange={(e) => update("zoomLevel", Number(e.target.value) as ZoomLevel)}
          className="bg-background border rounded px-1.5 py-0.5"
        >
          {ZOOM_LEVELS.map((z) => (
            <option key={z} value={z}>
              {z}×
            </option>
          ))}
        </select>
      </Field>

      <label
        className="flex items-center gap-1.5 text-muted-foreground select-none"
        title="Mantener el cursor de reproducción visible al desplazar"
      >
        <input
          type="checkbox"
          checked={settings.followPlayback}
          onChange={(e) => update("followPlayback", e.target.checked)}
          className="cursor-pointer"
        />
        <span>Seguir reproducción</span>
      </label>

      <Field label={`Ganancia ${settings.gainDB} dB`}>
        <input
          type="range"
          min={-20}
          max={60}
          step={1}
          value={settings.gainDB}
          onChange={(e) => update("gainDB", Number(e.target.value))}
          className="w-24"
        />
      </Field>

      <Field label={`Rango ${settings.rangeDB} dB`}>
        <input
          type="range"
          min={30}
          max={120}
          step={5}
          value={settings.rangeDB}
          onChange={(e) => update("rangeDB", Number(e.target.value))}
          className="w-24"
        />
      </Field>

      {trailing}
    </div>
  );
}

function Field({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex items-center gap-1.5 text-muted-foreground" title={title}>
      <span>{label}</span>
      {children}
    </label>
  );
}

/** Cycle through the y-max presets — used by the `f` keyboard shortcut. */
export function cycleYMax(current: number, sampleRate: number | null): number {
  const list = sampleRate ? [...Y_MAX_PRESETS_HZ, Math.round(sampleRate / 2)] : Y_MAX_PRESETS_HZ;
  const idx = list.indexOf(current);
  return list[(idx + 1) % list.length] ?? list[0];
}

/** Cycle through colormaps — used by the `m` keyboard shortcut. */
export function cycleColormap(current: ColormapName): ColormapName {
  const idx = COLORMAP_NAMES.indexOf(current);
  return COLORMAP_NAMES[(idx + 1) % COLORMAP_NAMES.length];
}
