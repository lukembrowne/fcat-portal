/**
 * Assembles an `OccupancyRunConfig` (the R runner's stdin contract) from a
 * DetectionFrame plus site covariates. Continuous covariates are z-standardized
 * here and the fitted mean/sd are returned so response curves + the AOI grid can
 * be back-transformed / standardized with the SAME parameters the model saw.
 */
import type { DetectionFrame } from "./detection-history";
import {
  fitStandardization,
  standardizeArray,
  type Standardization,
} from "./standardize";
import { DEFAULT_BIN_WIDTH_DAYS } from "./occasions";
import type { OccupancyRunConfig } from "./runner";

export interface CovariateSpec {
  name: string;
  kind: "continuous" | "factor";
  /** Values aligned 1:1 with `frame.siteIds` order. */
  values: (number | string)[];
}

export interface GridCovariateSpec {
  name: string;
  kind: "continuous" | "factor";
  /** One value per AOI grid cell. */
  values: (number | string)[];
}

export interface AssembleOptions {
  species: string;
  stream: "camera" | "audio";
  siteCovariates: CovariateSpec[];
  gridCovariates?: GridCovariateSpec[];
  binWidth?: number;
}

export interface AssembledConfig {
  config: OccupancyRunConfig;
  /** Back-transform params keyed by continuous covariate name. */
  standardizations: Record<string, Standardization>;
  /** Covariates omitted from the formula because they had no variation, with reason. */
  dropped: { name: string; reason: string }[];
}

/** A continuous covariate is only usable if it varies across sites. */
function continuousUsable(values: number[]): boolean {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length < 2) return false;
  return finite.some((v) => v !== finite[0]);
}

/** A factor covariate needs ≥2 distinct non-null levels to be estimable. */
function factorLevels(values: (string | null | undefined)[]): Set<string> {
  const levels = new Set<string>();
  for (const v of values) if (v != null) levels.add(String(v));
  return levels;
}

export function assembleRunConfig(
  frame: DetectionFrame,
  opts: AssembleOptions,
): AssembledConfig {
  const binWidth = opts.binWidth ?? DEFAULT_BIN_WIDTH_DAYS;
  const nSites = frame.siteIds.length;

  for (const cov of opts.siteCovariates) {
    if (cov.values.length !== nSites) {
      throw new Error(
        `covariate "${cov.name}" has ${cov.values.length} values but frame has ${nSites} sites`,
      );
    }
  }

  const siteCovs: Record<string, (number | string)[]> = {};
  const siteFactors: string[] = [];
  const standardizations: Record<string, Standardization> = {};
  const dropped: { name: string; reason: string }[] = [];
  const gridByName = new Map(
    (opts.gridCovariates ?? []).map((g) => [g.name, g]),
  );
  const grid: Record<string, (number | string)[]> = {};
  let anyGrid = false;

  // Only covariates that actually vary can be estimated. A constant covariate
  // (one habitat level in the sample, zero-variance forest cover) makes the
  // design matrix singular and occu fails — drop it from the formula instead, and
  // record why so the UI can explain the reduced model.
  const psiTerms: string[] = [];
  for (const cov of opts.siteCovariates) {
    if (cov.kind === "factor") {
      const levels = factorLevels(cov.values as string[]);
      if (levels.size < 2) {
        dropped.push({ name: cov.name, reason: `factor con <2 niveles (${levels.size})` });
        continue;
      }
      siteFactors.push(cov.name);
      siteCovs[cov.name] = cov.values.map(String);
      psiTerms.push(cov.name);
      const g = gridByName.get(cov.name);
      if (g) {
        grid[cov.name] = g.values.map(String);
        anyGrid = true;
      }
    } else {
      const nums = cov.values.map(Number);
      if (!continuousUsable(nums)) {
        dropped.push({ name: cov.name, reason: "covariable continua sin variación" });
        continue;
      }
      const s = fitStandardization(nums);
      standardizations[cov.name] = s;
      siteCovs[cov.name] = standardizeArray(nums, s);
      psiTerms.push(cov.name);
      const g = gridByName.get(cov.name);
      if (g) {
        // Standardize the grid with the site-fitted params — never re-fit.
        grid[cov.name] = standardizeArray(g.values.map(Number), s);
        anyGrid = true;
      }
    }
  }

  const psiFormula = psiTerms.length ? `~${psiTerms.join(" + ")}` : "~1";

  // Survey effort is a CONTINUOUS detection covariate (active days per occasion,
  // 1..binWidth) — a single `p~effort` slope, not per-level dummies (bucketed
  // effort levels caused complete separation on sparse levels, see the
  // 2026-07-14 plan). Usable only when it actually varies: an all-full-bin
  // deployment gives a constant column that occu can't identify a slope from.
  const effortValues = frame.effort.flat().filter((v): v is number => v != null);
  const distinctEffort = new Set(effortValues);
  const useEffort = distinctEffort.size >= 2;
  const detFormula = useEffort ? "~effort" : "~1";
  if (!useEffort) {
    dropped.push({ name: "effort", reason: `esfuerzo constante (${distinctEffort.size} valor)` });
  }

  const config: OccupancyRunConfig = {
    species: opts.species,
    stream: opts.stream,
    binWidth,
    y: frame.y,
    siteCovs,
    siteFactors,
    obsCovs: useEffort ? { effort: frame.effort } : {},
    // Effort is numeric now — never a factor. (siteFactors still carry habitat.)
    obsFactors: [],
    psiFormula,
    detFormula,
    grid: anyGrid ? grid : null,
    // Per continuous covariate {mean, sd} — lets the R runner relabel response
    // curves in raw units (cover fraction / metres) instead of the z-scale it fits.
    standardizations,
  };

  return { config, standardizations, dropped };
}
