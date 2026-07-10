/**
 * Reconstructs the occupancy (ψ) response surface for the per-species page from
 * the persisted logit-scale coefficients + the covariate snapshot — no need to
 * re-run R. ψ = plogis(intercept + Σ βᵢ·zᵢ), holding covariates not being varied
 * at their mean (z = 0), and factor levels at the reference (coef 0).
 */
import { fitStandardization } from "./standardize";

export interface Effect {
  submodel: "state" | "det";
  param: string; // cleaned name, e.g. "Int", "forest", "habitatpasto"
  estimate: number;
}

const plogis = (x: number) => 1 / (1 + Math.exp(-x));

function stateCoef(effects: Effect[], name: string): number {
  const e = effects.find((x) => x.submodel === "state" && x.param === name);
  return e ? e.estimate : 0;
}

export interface CurvePoint {
  x: number; // raw covariate value
  psi: number;
  /** 95% CI (present when the curve is R-predicted, null on the TS fallback). */
  lower?: number | null;
  upper?: number | null;
}

/**
 * ψ vs a continuous covariate over its observed range. `rawValues` are the
 * snapshot's raw site values for that covariate (used to derive mean/sd + range).
 */
export function responseCurve(
  effects: Effect[],
  covName: string,
  rawValues: number[],
  steps = 40,
): CurvePoint[] {
  const finite = rawValues.filter((v) => Number.isFinite(v));
  if (finite.length < 2) return [];
  const s = fitStandardization(finite);
  const intercept = stateCoef(effects, "Int");
  const beta = stateCoef(effects, covName);
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  const pts: CurvePoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const raw = min + ((max - min) * i) / steps;
    const z = (raw - s.mean) / s.sd;
    pts.push({ x: raw, psi: plogis(intercept + beta * z) });
  }
  return pts;
}

export interface HabitatBar {
  habitat: string;
  psi: number;
  isReference: boolean;
  /** 95% CI (present when R-predicted, null on the TS fallback). */
  lower?: number | null;
  upper?: number | null;
}

/**
 * Predicted ψ by habitat level (continuous covariates held at mean). The level
 * without a coefficient is the model's reference.
 */
export function habitatUse(effects: Effect[], habitatLevels: string[]): HabitatBar[] {
  const intercept = stateCoef(effects, "Int");
  const levels = [...new Set(habitatLevels)].sort();
  return levels.map((level) => {
    const coefEffect = effects.find(
      (x) => x.submodel === "state" && x.param === `habitat${level}`,
    );
    const coef = coefEffect ? coefEffect.estimate : 0;
    return {
      habitat: level,
      psi: plogis(intercept + coef),
      isReference: !coefEffect,
    };
  });
}
