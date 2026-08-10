/**
 * Does a fitted occupancy run still reflect today's applied BirdNET thresholds?
 *
 * A run reads its audio detections through `applySpeciesConfidenceFilter` and
 * snapshots the per-species thresholds it used onto
 * `occupancy_runs.species_thresholds_json`. Applying, reverting, or re-fitting a
 * threshold afterwards changes which detections a NEW run would see, but does
 * nothing to the models already fitted — so the species page can keep showing an
 * estimate built from a filter nobody uses any more.
 *
 * `Ortalis erythroptera` is the case that motivated this: marked "sin filtro"
 * (keep everything, floor 0.10) on 2026-08-10, while the newest completed run is
 * from 2026-07-16 and filtered it at the global 0.70 — 11,059 of its 24,913
 * identifications. The page said nothing about either number.
 *
 * Everything here is pure: the DB reads live in `threshold-status.ts`.
 */

import { SCORE_FLOOR } from "@/lib/birdnet-validation/types";

/** Which direction a species' filter moved between the run and now. */
export type ThresholdChangeKind = "added" | "changed" | "removed";

export interface ThresholdChange {
  species: string;
  /** In force when the run read its detections; null = the global default. */
  atRun: number | null;
  /** In force now; null = the global default. */
  now: number | null;
  kind: ThresholdChangeKind;
}

/**
 * Fitted thresholds are stored as REAL and round-trip through JSON, so compare
 * with a tolerance. The gap that matters is ~0.001 (three displayed decimals);
 * this is far below it and still immune to float noise.
 */
const EPS = 1e-9;

const sameValue = (a: number | null, b: number | null): boolean => {
  if (a == null || b == null) return a == null && b == null;
  return Math.abs(a - b) < EPS;
};

/**
 * Read a run's `species_thresholds_json` snapshot.
 *
 * NULL means "no per-species thresholds were in force" — which covers both a run
 * predating the column and one where every threshold had been reverted. The two
 * are indistinguishable here and need not be distinguished: either way the run
 * filtered every species at its global threshold, which is exactly what an empty
 * map produces downstream.
 *
 * Malformed JSON degrades to empty rather than throwing. A corrupt snapshot
 * should cost the drift warning, not the whole occupancy page.
 */
export function parseRunSpeciesThresholds(
  json: string | null | undefined,
): Map<string, number> {
  const out = new Map<string, number>();
  if (!json) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return out;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return out;
  for (const [species, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value)) out.set(species, value);
  }
  return out;
}

/** A species' applied threshold, or null when it falls back to the global one. */
export function thresholdFor(
  map: ReadonlyMap<string, number>,
  species: string,
): number | null {
  const v = map.get(species);
  return v != null && Number.isFinite(v) ? v : null;
}

/** True when `species` would be filtered differently by a run started now. */
export function speciesThresholdChanged(
  atRun: ReadonlyMap<string, number>,
  now: ReadonlyMap<string, number>,
  species: string,
): boolean {
  return !sameValue(thresholdFor(atRun, species), thresholdFor(now, species));
}

/**
 * How to name a confidence filter in Spanish prose. One copy, because the
 * occupancy species page, the run banner and the validation page all describe
 * the same three states and must not describe them differently.
 *
 * A per-species value at the score floor is NOT "a threshold of 0.10": every
 * BirdNET detection sits at or above 0.1, so that value is a recorded decision
 * to keep everything. Stating the bare number would read as an unusually
 * permissive fit — the opposite of what it means. `source` is known only for the
 * threshold in force today; a run's snapshot stores values alone, so a
 * historical floor is described by what it does rather than where it came from.
 */
export function describeThresholdEs(
  value: number | null,
  globalThreshold: number,
  source?: string | null,
): string {
  if (value == null) return `el umbral global de ${globalThreshold.toFixed(2)}`;
  if (source === "no_filter") {
    return `«sin filtro» (se conservan todas las detecciones, piso ${value.toFixed(2)})`;
  }
  if (value <= SCORE_FLOOR) {
    return `un umbral de ${value.toFixed(2)}, el piso de puntuación (sin filtro efectivo)`;
  }
  return `el umbral validado de ${value.toFixed(3)}`;
}

/** Same three states, compressed for a table cell or an inline before → after. */
export function shortThresholdEs(value: number | null): string {
  if (value == null) return "umbral global";
  if (value <= SCORE_FLOOR) return "sin filtro";
  return value.toFixed(3);
}

/**
 * Every species whose applied threshold differs between a run and now, sorted by
 * scientific name so the warning is stable across renders.
 *
 * `removed` (a threshold reverted since the run) counts as drift for the same
 * reason `added` does: the model on screen was fitted through a filter that is
 * no longer the one the portal applies everywhere else.
 */
export function diffSpeciesThresholds(
  atRun: ReadonlyMap<string, number>,
  now: ReadonlyMap<string, number>,
): ThresholdChange[] {
  const changes: ThresholdChange[] = [];
  for (const species of new Set([...atRun.keys(), ...now.keys()])) {
    const a = thresholdFor(atRun, species);
    const b = thresholdFor(now, species);
    if (sameValue(a, b)) continue;
    changes.push({
      species,
      atRun: a,
      now: b,
      kind: a == null ? "added" : b == null ? "removed" : "changed",
    });
  }
  return changes.sort((x, y) => x.species.localeCompare(y.species));
}
