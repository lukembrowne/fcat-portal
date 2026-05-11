/**
 * Acoustic-indices configuration — single source of truth shared between
 * the TypeScript worker and the Python runner.
 *
 * Both sides read `INDEX_CONFIG`, `DIEL_PERIODS`, and `DIEL_PERIOD_RANGES`
 * (the Python runner receives them as part of its stdin JSON) so there is
 * no drift between Spanish UI labels, the Python compute kernel, and the
 * `diel_period` enum stored in SQLite.
 *
 * Bump `CONFIG_VERSION` whenever the SS or EPS algorithms change shape —
 * Python folds it into the SHA-256 `configHash` written on every row.
 */

export const DIEL_PERIODS = ["dawn", "midday", "dusk", "night", "other"] as const;
export type DielPeriod = (typeof DIEL_PERIODS)[number];

/** Spanish labels for the diel-period selector on the habitat dashboard. */
export const DIEL_PERIOD_LABELS: Record<DielPeriod, string> = {
  dawn: "Madrugada (05–07)",
  midday: "Mediodía (11–13)",
  dusk: "Crepúsculo (17–19)",
  night: "Noche (22–04)",
  other: "Otra",
};

/**
 * Hour ranges in local Ecuador time (UTC-5). Format: `[startHour, endHour]`
 * with the convention `night` wraps past midnight (start > end). The Python
 * `assign_diel_period` helper handles wrap-around explicitly.
 */
export const DIEL_PERIOD_RANGES: Record<Exclude<DielPeriod, "other">, [number, number]> = {
  dawn: [5, 7],
  midday: [11, 13],
  dusk: [17, 19],
  night: [22, 4],
};

/**
 * Current algorithm config — the values here flow into every Python compute
 * pass and feed the `configHash` row-level provenance. Bump CONFIG_VERSION
 * (not the numeric values) when the SS or EPS port changes.
 */
export const CONFIG_VERSION = "1.0";

export const INDEX_CONFIG = {
  targetSampleRate: 44100,
  windowSeconds: 60,
  freqLowHz: 50,
  freqHighHz: 8000,
  /** Soundscape Saturation: dB above the per-bin modal background (Burivalova 2018). */
  ssThresholdDb: 9,
  /** Events per Second: minimum on-cluster duration in seconds (Towsey 2018). */
  epsMinEventSeconds: 0.06,
} as const;

export type AcousticIndexKey =
  | "soundscapeSaturation"
  | "acousticComplexityIndex"
  | "frequencyEntropy"
  | "temporalEntropy"
  | "eventsPerSecond";
