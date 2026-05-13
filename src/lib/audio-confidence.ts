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
  const t = canonicalThreshold(threshold);
  return sql`(
    audio_identifications.verification_status IN ('verified', 'corrected')
    OR (
      audio_identifications.confidence IS NULL
      AND audio_identifications.verification_status != 'rejected'
    )
    OR (
      audio_identifications.verification_status = 'unverified'
      AND audio_identifications.confidence >= ${t}
    )
  )`;
}
