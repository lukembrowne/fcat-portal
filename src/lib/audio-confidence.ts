/**
 * Read-time confidence-threshold filter for BirdNET audio identifications.
 *
 * Single source of truth for the filter rule:
 *
 *   - INCLUDE  if verification_status IN ('verified', 'corrected')           (human-curated)
 *   - INCLUDE  if confidence IS NULL AND verification_status != 'rejected'   (manual annotation)
 *   - INCLUDE  if verification_status = 'unverified' AND confidence >= T
 *   - EXCLUDE  if verification_status = 'rejected'
 *
 * Background: BirdNET's raw confidence score is not a probability and varies
 * 10x across species in the same model run (Tebbutt et al., 2026; Wood &
 * Kahl, 2024). A single global threshold is a defensible first cut while a
 * species-specific scheme remains a planned follow-up.
 */

import { sql, type SQL } from "drizzle-orm";

export const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;
export const CONFIDENCE_MIN = 0.1;
export const CONFIDENCE_MAX = 1.0;
export const CONFIDENCE_STEP = 0.05;
export const CONFIDENCE_STORAGE_KEY = "audio.confidenceThreshold.v1";
export const CONFIDENCE_URL_PARAM = "conf";

export function canonicalThreshold(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_CONFIDENCE_THRESHOLD;
  const clamped = Math.min(CONFIDENCE_MAX, Math.max(CONFIDENCE_MIN, value));
  return Math.round(clamped * 100) / 100;
}

export function formatThreshold(value: number): string {
  return canonicalThreshold(value).toFixed(2);
}

export function parseThresholdParam(
  raw: string | string[] | undefined | null
): number {
  if (raw === undefined || raw === null) return DEFAULT_CONFIDENCE_THRESHOLD;
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return DEFAULT_CONFIDENCE_THRESHOLD;
  const trimmed = value.trim();
  if (trimmed === "") return DEFAULT_CONFIDENCE_THRESHOLD;
  const num = Number(trimmed);
  if (!Number.isFinite(num)) return DEFAULT_CONFIDENCE_THRESHOLD;
  return canonicalThreshold(num);
}

/**
 * Drizzle SQL fragment matching the filter rule above. Use as an additional
 * predicate in any query whose FROM/JOIN chain references `audio_identifications`.
 *
 *   .where(and(existingPredicate, applyConfidenceFilter(threshold)))
 *
 * Or interpolated into a raw `sql<...>` subquery:
 *
 *   sql`... WHERE deployment_id = ${id} AND ${applyConfidenceFilter(t)}`
 */
export function applyConfidenceFilter(threshold: number): SQL {
  return applySpeciesConfidenceFilter(threshold, EMPTY_THRESHOLD_MAP);
}

const EMPTY_THRESHOLD_MAP: ReadonlyMap<string, number> = new Map();

/**
 * Clamp a fitted species threshold into the valid score range.
 *
 * Unlike `canonicalThreshold` this does NOT round to 2 decimals: a fitted value
 * is a statistical estimate, and rounding 0.9511 to 0.95 would change which
 * detections survive. Non-finite values are dropped by the caller rather than
 * silently becoming the global default.
 */
function clampSpeciesThreshold(value: number): number {
  return Math.min(CONFIDENCE_MAX, Math.max(CONFIDENCE_MIN, value));
}

/**
 * Same filter, but each species may carry its own validated threshold.
 *
 * BirdNET's score means different things per species — a threshold of 0.2 can
 * be right for one and 0.95 for another (Wood & Kahl 2024). Species with an
 * applied threshold from `/audio/validacion` use it; everything else falls back
 * to `globalThreshold`, so a portal with no applied thresholds behaves exactly
 * as it did before this existed.
 *
 * WHY A GENERATED CASE AND NOT A CORRELATED SUBQUERY: the obvious alternative —
 *
 *   COALESCE((SELECT t.threshold_conf_95 FROM birdnet_species_thresholds t
 *             WHERE t.species = ${audioIdentifications.species} ...), 0.7)
 *
 * — is the exact shape that broke the audio batch in production on 2026-06-18.
 * Inside a raw Drizzle `sql` template, `${audioIdentifications.species}` renders
 * as a bare `"species"`, which SQLite resolves against the INNER table, so every
 * row matches itself and the subquery returns NULL. Building the CASE from an
 * already-loaded map sidesteps the failure mode entirely and drops a per-row
 * subquery. Species names are interpolated as bound parameters, so quoting is
 * handled by the driver.
 */
export function applySpeciesConfidenceFilter(
  globalThreshold: number,
  speciesThresholds: ReadonlyMap<string, number>
): SQL {
  const fallback = canonicalThreshold(globalThreshold);

  // Filter BEFORE testing emptiness: a map whose every entry is non-finite would
  // otherwise generate `CASE  ELSE 0.7 END`, which is a syntax error.
  const branches = [...speciesThresholds.entries()]
    .filter(([, threshold]) => Number.isFinite(threshold))
    .map(
      ([species, threshold]) =>
        sql`WHEN audio_identifications.species = ${species} THEN ${clampSpeciesThreshold(
          threshold
        )}`
    );

  const effectiveThreshold =
    branches.length === 0
      ? sql`${fallback}`
      : sql`CASE ${sql.join(branches, sql` `)} ELSE ${fallback} END`;

  return sql`(
    audio_identifications.verification_status IN ('verified', 'corrected')
    OR (
      audio_identifications.confidence IS NULL
      AND audio_identifications.verification_status != 'rejected'
    )
    OR (
      audio_identifications.verification_status = 'unverified'
      AND audio_identifications.confidence >= ${effectiveThreshold}
    )
  )`;
}
