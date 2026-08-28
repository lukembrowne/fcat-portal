"use client";

/**
 * The display controls above a review clip.
 *
 * Collapsed by default and behind a single "Ajustes de imagen" toggle. The
 * review queue is a 200-repetition loop whose whole design is one decision per
 * screen, and five permanently-visible sliders would take height from the
 * spectrogram on every clip to serve the handful where they matter.
 *
 * Settings persist across clips and across sessions (localStorage), because a
 * reviewer working a quiet species wants the gain up for the whole run, not
 * per clip.
 *
 * Deliberately NOT the annotation page's control row: no colormap (one more
 * choice with no bearing on a yes/no call) and no follow-playback (the clip is
 * nine seconds and always fully visible at zoom 1).
 */

import {
  CONTRAST_RANGE,
  FFT_SIZES,
  GAIN_RANGE,
  MAX_HZ_PRESETS,
  ZOOM_LEVELS,
  isDefault,
  DEFAULT_SETTINGS,
  type ReviewSpectrogramSettings,
} from "./spectrogram-settings";

export function SpectrogramControls({
  settings,
  onChange,
  open,
  onToggle,
  nyquistHz,
}: {
  settings: ReviewSpectrogramSettings;
  onChange: (next: ReviewSpectrogramSettings) => void;
  open: boolean;
  onToggle: () => void;
  /** Half the clip's sample rate, once decoded. Offered as a ceiling preset. */
  nyquistHz: number | null;
}) {
  const set = <K extends keyof ReviewSpectrogramSettings>(
    key: K,
    value: ReviewSpectrogramSettings[K]
  ) => onChange({ ...settings, [key]: value });

  const presets = nyquistHz
    ? [...MAX_HZ_PRESETS.filter((hz) => hz < nyquistHz), nyquistHz]
    : [...MAX_HZ_PRESETS];

  return (
    <div className="rounded border bg-muted/30">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-2 py-1">
        <button
          type="button"
          onClick={onToggle}
          className="text-[11px] font-medium text-muted-foreground hover:text-foreground"
          aria-expanded={open}
        >
          {open ? "▾" : "▸"} Ajustes de imagen
        </button>
        {/* Says the picture is not the default one. Without it a reviewer who
            turned the gain up three days ago reads a washed-out clip as the
            recording being bad. */}
        {!isDefault(settings) ? (
          <>
            <span className="text-[11px] tabular-nums text-amber-700">
              {settings.fftSize} · {settings.gainDB} dB · {settings.rangeDB} dB ·{" "}
              {Math.round(settings.displayMaxHz / 1000)} kHz
              {settings.zoom > 1 ? ` · ${settings.zoom}×` : ""}
            </span>
            <button
              type="button"
              onClick={() => onChange({ ...DEFAULT_SETTINGS })}
              className="text-[11px] text-sky-700 hover:underline"
            >
              Restablecer
            </button>
          </>
        ) : null}
      </div>

      {open ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-2 py-2 text-[11px]">
          <Field label="Ventana FFT" hint="Más grande = más detalle en frecuencia, menos en tiempo">
            <select
              value={settings.fftSize}
              onChange={(e) => set("fftSize", Number(e.target.value) as typeof settings.fftSize)}
              className="rounded border bg-background px-1.5 py-0.5"
            >
              {FFT_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>

          <Slider
            label="Ganancia"
            value={settings.gainDB}
            unit="dB"
            {...GAIN_RANGE}
            onChange={(v) => set("gainDB", v)}
          />

          <Slider
            label="Contraste"
            value={settings.rangeDB}
            unit="dB"
            {...CONTRAST_RANGE}
            onChange={(v) => set("rangeDB", v)}
          />

          <Field label="Frecuencia máx">
            <select
              value={settings.displayMaxHz}
              onChange={(e) => set("displayMaxHz", Number(e.target.value))}
              className="rounded border bg-background px-1.5 py-0.5"
            >
              {presets.map((hz) => (
                <option key={hz} value={hz}>
                  {hz === nyquistHz ? "Máx" : `${hz / 1000} kHz`}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Zoom">
            <div className="flex gap-1">
              {ZOOM_LEVELS.map((z) => (
                <button
                  key={z}
                  type="button"
                  onClick={() => set("zoom", z)}
                  className={`rounded border px-1.5 py-0.5 tabular-nums ${
                    settings.zoom === z ? "border-foreground bg-muted font-medium" : ""
                  }`}
                >
                  {z}×
                </button>
              ))}
            </div>
          </Field>
        </div>
      ) : null}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex items-center gap-1.5" title={hint}>
      <span className="text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

function Slider({
  label,
  value,
  unit,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  unit: string;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex items-center gap-1.5">
      <span className="text-muted-foreground">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-24"
      />
      <span className="w-10 tabular-nums text-muted-foreground">
        {value} {unit}
      </span>
    </label>
  );
}
