/**
 * Shared types for BirdNET threshold validation.
 *
 * The module converts BirdNET's uncalibrated confidence score into a
 * species-specific probability threshold: draw a score-bin-stratified sample,
 * have an expert review each clip, fit glm(outcome ~ logit) in R, and solve for
 * the confidence value at which a chosen share of retained detections are true
 * positives (Wood & Kahl 2024).
 */

/** Probability levels the fit solves for. 0.95 is the one applied downstream. */
export const TARGET_PROBABILITIES = [0.9, 0.95, 0.99] as const;
export type TargetProbability = (typeof TARGET_PROBABILITIES)[number];

/** Default clips per campaign. 200 is the size Symes recommends after finding
 *  100 gave uncomfortably wide threshold confidence intervals. */
export const DEFAULT_TARGET_SAMPLE_SIZE = 200;

/**
 * Score bins spanning [0.1, 1.0]; 0.1 is BirdNET's own suppression floor.
 *
 * Nine bins, not ten: nine divides the 0.1-1.0 range into exactly 0.1-wide
 * deciles ([0.1, 0.2), [0.2, 0.3), ... [0.9, 1.0]). Ten bins would be 0.09 wide
 * with boundaries at 0.19, 0.28, 0.37 — statistically equivalent but unreadable
 * in the UI, where reviewers and collaborators talk in terms of "the 0.7-0.8
 * range".
 */
export const DEFAULT_BIN_COUNT = 9;
export const SCORE_FLOOR = 0.1;
export const SCORE_CEILING = 1.0;

/** Below this many usable reviews the fit is refused outright — a two-parameter
 *  logistic on fewer points produces a threshold whose CI spans the entire
 *  score range. */
export const MIN_REVIEWS_FOR_FIT = 20;

/**
 * Confidence is clamped to this open interval before the logit transform.
 * BirdNET emits exact 1.0 values (and the 0.1 floor sits at the other end);
 * log(1/0) is +Inf, which poisons the whole fit.
 */
export const LOGIT_CLAMP_MIN = 0.001;
export const LOGIT_CLAMP_MAX = 0.999;

export type ReviewOutcome = "correct" | "incorrect" | "uncertain";

/**
 * Where a species is in the validation path.
 *
 * `draft` is NOT the first step of the path — the sample is drawn when the
 * species is added, so a species reaches `sampled` immediately. `draft` means
 * that draw failed and has to be re-run.
 *
 * There was a `triage` stage here until 2026-08-10: ten top-scoring clips
 * reviewed first, as a cheap go/no-go before committing to 200. It worked, but
 * it cost a whole stage of workflow to explain and people skipped it. The
 * bail-out it protected now lives at the end of every review batch, where
 * "Descartar esta especie" sits beside "Cargar siguientes".
 */
export type CampaignStatus =
  | "draft"
  | "sampled"
  | "reviewing"
  | "fitted"
  | "unusable"
  | "applied"
  | "abandoned";

/**
 * How urgently a species wants reviewing, set by hand.
 *
 * Orthogonal to `CampaignStatus`, which says where a species IS. This says
 * which one a reviewer should pick up next — the scarce resource in this module
 * is expert listening time, ~200 clips per species, and with dozens of species
 * in the list nothing else in the row answers that question. The notes field
 * carries the *reason* a species is worth validating, but it is free text: the
 * taxonomist's "CHECK" only surfaces for a reader who already knows to type it.
 *
 * `medium` is the default, and it means "not singled out" rather than "middling
 * importance". Every species added before this field existed is medium, so the
 * column reads as a deviation from the baseline in either direction rather than
 * as an assessment nobody actually made.
 *
 * Keep in sync with the CHECK constraint in scripts/push-schema.mjs — Drizzle's
 * enum is TypeScript-only and will not reject a bad value.
 */
export type CampaignPriority = "high" | "medium" | "low";

/** In descending urgency, which is the order the species table defaults to. */
export const CAMPAIGN_PRIORITIES = ["high", "medium", "low"] as const;

export const DEFAULT_CAMPAIGN_PRIORITY: CampaignPriority = "medium";

/**
 * Why a fit produced no usable threshold. These are the common case, not edge
 * cases: most species BirdNET reports have no true positives at any score.
 */
export type UnusableReasonCode =
  | "insufficient_sample"
  | "complete_separation"
  | "non_monotonic"
  | "threshold_out_of_range"
  | "fit_failed";

/** Spanish copy surfaced in the UI for each unusable outcome. */
export const UNUSABLE_REASON_ES: Record<UnusableReasonCode, string> = {
  insufficient_sample:
    "Muestra insuficiente: se necesitan al menos 20 revisiones utilizables.",
  complete_separation:
    "Separación completa: todas las revisiones tienen el mismo resultado, no se puede estimar un umbral.",
  non_monotonic:
    "Relación no monótona: la precisión no aumenta con la confianza de BirdNET.",
  threshold_out_of_range:
    "Umbral fuera de rango: ningún valor de confianza alcanza la probabilidad objetivo.",
  fit_failed: "El ajuste del modelo falló.",
};

/**
 * Why a campaign's fit-eligible review set could not be resolved.
 *
 * Distinct from `UnusableReasonCode`: these fire *before* R sees anything,
 * because the portal cannot tell which reviewer's answers the model should
 * consume. `no_primary_reviewer` is the load-bearing one — silently pooling
 * every reviewer's answers there would be pseudo-replication, inflating n
 * without inflating information and reporting a threshold interval far tighter
 * than the data supports.
 */
export type FitEligibilityReason = "no_primary_reviewer" | "nothing_reviewed";

export const FIT_ELIGIBILITY_REASON_ES: Record<FitEligibilityReason, string> = {
  no_primary_reviewer:
    "Varias personas han revisado esta especie. Designe un revisor principal: el modelo usa las respuestas de una sola persona por grabación.",
  nothing_reviewed: "Todavía no hay revisiones para esta especie.",
};

/** Why an agreement statistic has no kappa value. */
export type KappaReason = "no_overlap" | "no_variation";

export const KAPPA_REASON_ES: Record<KappaReason, string> = {
  no_overlap: "Sin grabaciones revisadas en común.",
  // pe = 1: both reviewers used a single category, so chance agreement is
  // total and kappa is 0/0. Agreement is trivially perfect and uninformative.
  no_variation: "Sin variación: ambos usaron una sola categoría.",
};

/** Convert a BirdNET confidence score to its logit, clamping the boundary. */
export function confidenceToLogit(confidence: number): number {
  const c = Math.min(LOGIT_CLAMP_MAX, Math.max(LOGIT_CLAMP_MIN, confidence));
  return Math.log(c / (1 - c));
}

/** Inverse of confidenceToLogit, without the clamp. */
export function logitToConfidence(logit: number): number {
  return 1 / (1 + Math.exp(-logit));
}

/**
 * Bin edges for `binCount` bins spanning [SCORE_FLOOR, SCORE_CEILING].
 * The final bin is closed on the right so confidence exactly 1.0 lands in it
 * rather than falling outside every bin.
 */
export function binEdges(binCount: number): Array<{ lo: number; hi: number }> {
  const width = (SCORE_CEILING - SCORE_FLOOR) / binCount;
  return Array.from({ length: binCount }, (_, i) => ({
    lo: SCORE_FLOOR + i * width,
    hi: i === binCount - 1 ? SCORE_CEILING : SCORE_FLOOR + (i + 1) * width,
  }));
}

/** Which bin a confidence value falls in, or -1 if outside [floor, ceiling]. */
export function binIndexFor(confidence: number, binCount: number): number {
  if (confidence < SCORE_FLOOR || confidence > SCORE_CEILING) return -1;
  const width = (SCORE_CEILING - SCORE_FLOOR) / binCount;
  const raw = Math.floor((confidence - SCORE_FLOOR) / width);
  return Math.min(binCount - 1, Math.max(0, raw));
}
