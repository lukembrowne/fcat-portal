"use client";

import { useEffect, useCallback } from "react";
import { COLORMAP_NAMES, type ColormapName } from "@/lib/spectrogram-colormaps";

const STORAGE_KEY = "audio.spectrogram.v1";

export interface SpectrogramSettings {
  displayMaxHz: number;
  gainDB: number;
  rangeDB: number;
  fftSize: 512 | 1024 | 2048;
  colormap: ColormapName;
}

export const DEFAULT_SETTINGS: SpectrogramSettings = {
  displayMaxHz: 12000,
  gainDB: 25,
  rangeDB: 70,
  fftSize: 1024,
  colormap: "magma",
};

const Y_MAX_PRESETS_HZ: readonly number[] = [3000, 6000, 9000, 12000];

export function loadStoredSettings(): SpectrogramSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<SpectrogramSettings>;
    return {
      displayMaxHz: typeof parsed.displayMaxHz === "number" ? parsed.displayMaxHz : DEFAULT_SETTINGS.displayMaxHz,
      gainDB: typeof parsed.gainDB === "number" ? parsed.gainDB : DEFAULT_SETTINGS.gainDB,
      rangeDB: typeof parsed.rangeDB === "number" ? parsed.rangeDB : DEFAULT_SETTINGS.rangeDB,
      fftSize: parsed.fftSize === 512 || parsed.fftSize === 2048 ? parsed.fftSize : DEFAULT_SETTINGS.fftSize,
      colormap:
        parsed.colormap && COLORMAP_NAMES.includes(parsed.colormap)
          ? parsed.colormap
          : DEFAULT_SETTINGS.colormap,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

interface SpectrogramControlsProps {
  settings: SpectrogramSettings;
  onChange: (next: SpectrogramSettings) => void;
  /** Used to compute the Nyquist preset label; null until audio decoded. */
  sampleRate: number | null;
}

export function SpectrogramControls({ settings, onChange, sampleRate }: SpectrogramControlsProps) {
  // Persist on every change
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // localStorage may be disabled — ignore
    }
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
