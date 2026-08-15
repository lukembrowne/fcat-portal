/**
 * The plot <-> site correspondence for the Choconexión reforestation experiment.
 *
 * Every one of the 16 Choconexión plots contains exactly one BioChoco monitoring
 * deployment, but the correspondence is invisible from either side alone: the
 * treatment plots are numbered so that `REF-00N` sits in `P0N`, while the four
 * control plots carry sites coded by their actual habitat instead. There is no
 * `REF-008`, because P08 is a control.
 *
 * This is a literal table rather than a computed join on purpose. The
 * correspondence is fixed for the life of the experiment, and a table is
 * reviewable in a diff in a way a point-in-polygon result is not. The check that
 * proves it right lives in the Choconexión repo (`scripts/verify-sites.mjs`),
 * where the plot polygons are — so neither repo has to carry a copy of the
 * other's geometry.
 *
 * Verified on 2026-08-12: all 15 sites present in the database reproject to a
 * point inside their declared polygon. SEC-002 (P08) has no deployment row yet.
 */

export interface PlotSitePair {
  /** Choconexión plot identifier, `P01`..`P16`. */
  readonly plotId: string;
  /** BioChoco site code, matching the `NNN-NNN` prefix of a deployment name. */
  readonly siteCode: string;
}

export const PLOT_SITE_PAIRS: readonly PlotSitePair[] = Object.freeze([
  { plotId: "P01", siteCode: "REF-001" },
  { plotId: "P02", siteCode: "REF-002" },
  { plotId: "P03", siteCode: "REF-003" },
  { plotId: "P04", siteCode: "REF-004" },
  { plotId: "P05", siteCode: "REF-005" },
  { plotId: "P06", siteCode: "REF-006" },
  { plotId: "P07", siteCode: "REF-007" },
  // P08 is a control plot; there is no REF-008.
  { plotId: "P08", siteCode: "SEC-002" },
  { plotId: "P09", siteCode: "REF-009" },
  { plotId: "P10", siteCode: "REF-010" },
  { plotId: "P11", siteCode: "REF-011" },
  { plotId: "P12", siteCode: "REF-012" },
  { plotId: "P13", siteCode: "REF-013" },
  { plotId: "P14", siteCode: "PRI-003" },
  { plotId: "P15", siteCode: "SEC-001" },
  { plotId: "P16", siteCode: "PRI-002" },
] as const);

const BY_SITE = new Map(PLOT_SITE_PAIRS.map((p) => [p.siteCode, p.plotId]));
const BY_PLOT = new Map(PLOT_SITE_PAIRS.map((p) => [p.plotId, p.siteCode]));

/** The plot containing this site, or undefined if the site is not in the experiment. */
export function plotForSite(siteCode: string): string | undefined {
  return BY_SITE.get(siteCode);
}

/** The site inside this plot, or undefined if the plot is not one of the 16. */
export function siteForPlot(plotId: string): string | undefined {
  return BY_PLOT.get(plotId);
}

/**
 * The site code embedded in a deployment name.
 *
 * Deployment names carry a visit suffix (`REF-007_V1`); the site code is the
 * part before it. Matches the convention in the public overview's `siteCode`.
 */
export function siteCodeFromDeploymentName(name: string): string {
  return name.trim().split("_")[0];
}
