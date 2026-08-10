/**
 * Inter-reviewer agreement: percent agreement and Cohen's kappa.
 *
 * Pure arithmetic over a small contingency table — no database access, no R.
 * Kappa on a few hundred rows is microseconds, so this is computed on read
 * rather than persisted, which means it can never go stale after a reviewer
 * revises an answer.
 *
 * Percent agreement alone is misleading when one category dominates: two
 * reviewers who both say "incorrect" 95% of the time agree 90% of the time by
 * chance alone. Kappa corrects for that, which is exactly the situation here —
 * most BirdNET detections for most species are false positives.
 *
 * `uncertain` is a full category rather than an excluded row. Disagreement
 * about whether a clip is even judgeable is the signal most likely to separate
 * an expert from a novice, and dropping those rows would hide it.
 */

import { KAPPA_REASON_ES, type KappaReason, type ReviewOutcome } from "./types";

export interface ReviewPair {
  sampleId: number;
  /** The designated primary reviewer's answer — the reference. */
  primary: ReviewOutcome;
  /** The reviewer being compared against the primary. */
  other: ReviewOutcome;
}

export interface AgreementResult {
  /** Clips both reviewers answered. */
  n: number;
  agreed: number;
  /** Null when there is no overlap to divide by. */
  percentAgreement: number | null;
  /** Null when undefined; `kappaReason` says why. May be negative. */
  kappa: number | null;
  kappaReason: KappaReason | null;
}

const CATEGORIES: ReviewOutcome[] = ["correct", "incorrect", "uncertain"];

export function computeAgreement(pairs: ReviewPair[]): AgreementResult {
  const n = pairs.length;
  if (n === 0) {
    return {
      n: 0,
      agreed: 0,
      percentAgreement: null,
      kappa: null,
      kappaReason: "no_overlap",
    };
  }

  const agreed = pairs.filter((p) => p.primary === p.other).length;
  const po = agreed / n;

  // Expected agreement under independence: sum over categories of the product
  // of the two reviewers' marginal proportions.
  let pe = 0;
  for (const category of CATEGORIES) {
    const primaryShare = pairs.filter((p) => p.primary === category).length / n;
    const otherShare = pairs.filter((p) => p.other === category).length / n;
    pe += primaryShare * otherShare;
  }

  // pe === 1 means both reviewers used a single category, so chance agreement
  // is total and kappa is 0/0. Reported as a reason, never as NaN — a NaN here
  // renders as a blank cell that reads like "not computed yet".
  if (pe >= 1) {
    return {
      n,
      agreed,
      percentAgreement: po,
      kappa: null,
      kappaReason: "no_variation",
    };
  }

  return {
    n,
    agreed,
    percentAgreement: po,
    kappa: (po - pe) / (1 - pe),
    kappaReason: null,
  };
}

/**
 * Spanish label for a kappa value, or the reason it has none.
 *
 * The bands follow Landis & Koch, which is the convention readers of this
 * literature expect; they are descriptive, not a pass/fail gate.
 */
export function describeKappa(result: AgreementResult): string {
  if (result.kappa === null) {
    return result.kappaReason ? KAPPA_REASON_ES[result.kappaReason] : "—";
  }
  const k = result.kappa;
  if (k < 0) return "peor que el azar";
  if (k < 0.2) return "leve";
  if (k < 0.4) return "aceptable";
  if (k < 0.6) return "moderado";
  if (k < 0.8) return "sustancial";
  return "casi perfecto";
}
