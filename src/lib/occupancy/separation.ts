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

/** One occupancy (ψ / state) submodel coefficient, already split from its `psi()` wrapper. */
export interface StateCoefficient {
  name: string;
  estimate: number | null;
  se: number | null;
}

const INTERCEPT_NAMES = new Set(["Int", "(Intercept)"]);

/**
 * Model-level identifiability from the fitted ψ coefficients. Distinct from
 * `isSeparated` (one coefficient): a model is *non-identifiable* — degenerate —
 * when the whole ψ submodel carries no usable signal. This is the ocelot case:
 * a 13-parameter model fit on 4 detected sites where `occu` ran off to ±∞ on
 * every term yet still "converged" numerically, so the pipeline would otherwise
 * store a confident-looking occupancy estimate with no information behind it.
 *
 * Degenerate when either:
 *  - the ψ **intercept** is separated (the baseline occupancy itself is not
 *    estimable — nothing downstream can be trusted), or
 *  - **every** non-intercept ψ slope is separated (all covariate effects blew
 *    up; only the intercept survives, and even that is being pulled by the
 *    separated terms).
 *
 * A model with a clean intercept and ≥1 estimable slope is identifiable even if
 * one factor level separated (the paca case) — that level is dropped from the
 * synthesis per-coefficient, not the whole model.
 */
export function classifyModelIdentifiability(
  stateCoeffs: StateCoefficient[],
): { identifiable: boolean; reason?: string } {
  if (stateCoeffs.length === 0) {
    return { identifiable: false, reason: "modelo no identificable: sin coeficientes de ocupación (ψ)" };
  }
  const intercept = stateCoeffs.find((c) => INTERCEPT_NAMES.has(c.name));
  if (intercept && isSeparated(intercept.estimate, intercept.se)) {
    return { identifiable: false, reason: "modelo no identificable: separación en el intercepto de ψ" };
  }
  const slopes = stateCoeffs.filter((c) => !INTERCEPT_NAMES.has(c.name));
  if (slopes.length > 0 && slopes.every((c) => isSeparated(c.estimate, c.se))) {
    return { identifiable: false, reason: "modelo no identificable: separación en todos los términos de ψ" };
  }
  return { identifiable: true };
}
