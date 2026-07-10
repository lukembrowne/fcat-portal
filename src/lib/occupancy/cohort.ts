import { parseSeedCovariates } from "./covariates";
import type { OccupancyStreamInputs } from "./fetch";

/**
 * Survey-cohort isolation. The dev seeder (scripts/seed-occupancy-dev.ts) adds
 * synthetic OCC-SEED deployments alongside the real ones; they are an UNRELATED
 * survey, so a real species must not be forced "absent" across the synthetic
 * sites (nor vice-versa) — that mixing flattens the seeded forest/elevation
 * signal and injects habitat separation. A species is fit only over the cohort
 * where it was detected. In production there are no synthetic sites, so the set
 * is empty and every species keeps the full pool (this is a no-op there).
 */

/** IDs of the dev seeder's synthetic OCC-SEED sites (empty in production). */
export function getSyntheticSiteIds(inputs: OccupancyStreamInputs): Set<string> {
  return new Set(
    inputs.sites
      .filter((s) => parseSeedCovariates(inputs.covariateInputs.get(s.siteId)?.fieldNotes) != null)
      .map((s) => s.siteId),
  );
}

/**
 * The sites a species is fit over: the cohort (synthetic OR real) in which the
 * species was detected. Returns the full `sites` list when there are no
 * synthetic sites (production).
 */
export function cohortSitesFor<S extends { siteId: string }>(
  sites: S[],
  events: { siteId: string }[],
  synthetic: Set<string>,
): S[] {
  if (synthetic.size === 0) return sites;
  const inSynthetic = events.some((e) => synthetic.has(e.siteId));
  return sites.filter((s) => synthetic.has(s.siteId) === inSynthetic);
}
