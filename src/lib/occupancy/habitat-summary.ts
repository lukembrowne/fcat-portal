import type { SitePerRow } from "./detection-history";

/** Observed (naïve) occupancy for one habitat class — a pure detection count,
 *  no model. Meaningful even when the categorical habitat occupancy model is
 *  non-identifiable (a species found in only one habitat separates the fit). */
export interface HabitatNaiveRow {
  habitat: string;
  /** Cohort sites of this habitat (with a resolved habitat class). */
  nSurveyed: number;
  /** Of those, how many had ≥1 detection of this species. */
  nDetected: number;
  /** nDetected / nSurveyed (0..1). */
  naiveOccupancy: number;
}

/**
 * Tally naïve occupancy (detected / surveyed) per habitat class over a cohort's
 * per-site rows. Purely descriptive — no model — so it still answers "where does
 * this species occur?" when the categorical habitat occupancy model can't be fit
 * (a species restricted to one habitat perfectly separates the ψ intercept).
 * Sites whose habitat is unresolved (null/undefined) are omitted. Sorted by
 * observed occupancy desc, then site count desc (habitat name as a stable tie).
 */
export function naiveOccupancyByHabitat(
  perSite: Pick<SitePerRow, "siteId" | "detected">[],
  habitatBySite: Map<string, string | null | undefined>,
): HabitatNaiveRow[] {
  const tally = new Map<string, { surveyed: number; detected: number }>();
  for (const p of perSite) {
    const hab = habitatBySite.get(p.siteId);
    if (!hab) continue;
    const t = tally.get(hab) ?? { surveyed: 0, detected: 0 };
    t.surveyed++;
    if (p.detected) t.detected++;
    tally.set(hab, t);
  }
  return [...tally.entries()]
    .map(([habitat, t]) => ({
      habitat,
      nSurveyed: t.surveyed,
      nDetected: t.detected,
      naiveOccupancy: t.surveyed > 0 ? t.detected / t.surveyed : 0,
    }))
    .sort(
      (a, b) =>
        b.naiveOccupancy - a.naiveOccupancy ||
        b.nSurveyed - a.nSurveyed ||
        a.habitat.localeCompare(b.habitat),
    );
}
