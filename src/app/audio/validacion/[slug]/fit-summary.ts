/**
 * Pure presentation helpers for the species validation page.
 *
 * Extracted from the page so they can be unit-tested without React or a DOM —
 * the Vitest environment is `node`.
 */

import type { BirdnetSpeciesThreshold } from "@/db/schema";

export interface FitSummary {
  usable: boolean;
  /** Spanish reason when unusable; null when the fit produced a threshold. */
  reason: string | null;
  thresholdConf95: number | null;
  ciLower: number | null;
  ciUpper: number | null;
  nReviewed: number;
  nCorrect: number;
  nUncertain: number;
  /** Share of reviewed clips that were correct, across the whole sample. */
  rawPrecision: number | null;
}

export function summarizeFit(row: BirdnetSpeciesThreshold): FitSummary {
  const usable = row.thresholdConf95 != null && row.unusableReason == null;
  return {
    usable,
    reason: row.unusableReason,
    thresholdConf95: row.thresholdConf95,
    ciLower: row.ciLower95,
    ciUpper: row.ciUpper95,
    nReviewed: row.nReviewed,
    nCorrect: row.nCorrect,
    nUncertain: row.nUncertain,
    rawPrecision: row.nReviewed > 0 ? row.nCorrect / row.nReviewed : null,
  };
}

/**
 * Is the fit behind the current review count?
 *
 * Compares usable reviews (uncertain excluded, since the fit drops them) against
 * what the fit actually saw. A stale fit is not wrong, just out of date — the
 * page offers a re-fit rather than hiding the numbers.
 */
export function isFitStale(
  fitNReviewed: number,
  currentReviewed: number,
  currentUncertain: number
): boolean {
  return currentReviewed - currentUncertain > fitNReviewed;
}

export interface ThresholdImpact {
  /** Detections at or above the threshold. */
  kept: number;
  /** Detections below it. */
  dropped: number;
  keptFraction: number;
}

/**
 * How many of a species' detections survive a threshold.
 *
 * Takes the full confidence list rather than a count so the page can show the
 * same number for any candidate threshold without another query.
 */
export function thresholdImpact(
  confidences: readonly number[],
  threshold: number
): ThresholdImpact {
  let kept = 0;
  for (const c of confidences) if (c >= threshold) kept++;
  const total = confidences.length;
  return {
    kept,
    dropped: total - kept,
    keptFraction: total > 0 ? kept / total : 0,
  };
}

/**
 * Points on the fitted curve, for plotting.
 *
 * x is the BirdNET confidence score; y is the modelled probability that a
 * prediction at that score is correct. The model lives on the logit scale, so
 * each x is transformed before applying the coefficients.
 */
export function curvePoints(
  intercept: number,
  slope: number,
  steps = 60
): Array<{ conf: number; p: number }> {
  const points: Array<{ conf: number; p: number }> = [];
  for (let i = 0; i <= steps; i++) {
    const conf = 0.1 + (i / steps) * 0.9;
    const clamped = Math.min(0.999, Math.max(0.001, conf));
    const x = Math.log(clamped / (1 - clamped));
    points.push({ conf, p: 1 / (1 + Math.exp(-(intercept + slope * x))) });
  }
  return points;
}

/**
 * When a fit ran, in Ecuador wall-clock.
 *
 * The timezone is pinned rather than left to the runtime: the production
 * container runs UTC, so a bare `toLocaleString` would tell an Ecuadorian
 * reader a fit ran five hours later than it did. Two fits minutes apart are
 * routine — the history table showed two identical-looking rows dated
 * `2026-08-10` — so the time, not just the date, is what makes a row identifiable.
 */
export function formatFitTimestamp(when: Date): string {
  return new Intl.DateTimeFormat("es-EC", {
    timeZone: "America/Guayaquil",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(when);
}

export interface ModelVersions {
  versions: string[];
  /** More than one distinct version behind a single fit. */
  mixed: boolean;
}

/**
 * Split the stored model-version label back into its parts.
 *
 * `resolveModelVersion` joins every distinct version in the sample with ", ".
 * Older rows hold a single bare label, which parses to a one-element list, so
 * no migration is needed to read them.
 */
export function describeModelVersions(raw: string | null): ModelVersions {
  const versions = (raw ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  return { versions, mixed: versions.length > 1 };
}

/**
 * Which side complete separation fell on.
 *
 * The stored `unusableReason` is Spanish prose, not a code, so this reads the
 * counts instead — which is also exactly the condition the R side tests
 * (`nCorrect == 0 || nCorrect == nReviewed`). The distinction is the whole
 * point: the two outcomes share a failure mode and share no advice at all.
 * Every review correct means BirdNET is right across the sampled range and the
 * species needs its filter LOOSENED; every review wrong means no threshold
 * rescues it.
 */
export type SeparationCase = "all-correct" | "all-incorrect" | null;

export function separationCase(nReviewed: number, nCorrect: number): SeparationCase {
  if (nReviewed <= 0) return null;
  if (nCorrect === nReviewed) return "all-correct";
  if (nCorrect === 0) return "all-incorrect";
  return null;
}

/** Format a threshold with its CI for display, or a dash when unusable. */
export function formatThresholdWithCi(
  value: number | null,
  lower: number | null,
  upper: number | null
): string {
  if (value == null) return "—";
  const base = value.toFixed(3);
  if (lower == null || upper == null) return base;
  return `${base} (IC 95%: ${lower.toFixed(3)}–${upper.toFixed(3)})`;
}
