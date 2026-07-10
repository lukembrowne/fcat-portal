/**
 * Complete / quasi-complete separation detection for occupancy coefficients.
 *
 * When a factor level (e.g. a habitat with zero detections) or an effort level
 * perfectly predicts absence, `occu`'s MLE runs off to ±∞: the coefficient comes
 * back as ±20 with a standard error in the hundreds/thousands (or NaN). Back-
 * transformed, its "95% CI" spans the entire 0–100% range — technically correct
 * ("no information here") but misleading rendered as a confidence band. We flag
 * these so the UI shows "no estimable — datos insuficientes" instead of a
 * full-width band. Real, estimable coefficients (|β| ≲ a few, finite SE) are
 * never flagged, so this is inert for well-identified models.
 */

/** A coefficient is non-estimable (separated) if its estimate or SE has blown up. */
export function isSeparated(
  estimate: number | null | undefined,
  se: number | null | undefined,
): boolean {
  if (estimate == null || !Number.isFinite(estimate)) return true;
  if (se == null || !Number.isFinite(se)) return true; // NaN/∞ SE = not identifiable
  // Logit-scale coefficients for real effects sit within a few units with a
  // finite SE; anything past these bounds is separation, not signal.
  return se > 50 || Math.abs(estimate) > 15;
}
