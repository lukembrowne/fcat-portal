/**
 * Data-readiness gate for occupancy modeling.
 *
 * Spike finding (2026-07-03): the binding constraint on this feature is NOT
 * compute — it's spatial replication of detections. Single-season occupancy
 * needs presence/absence spread across many sites (MacKenzie et al. rule of
 * thumb: ≥15–20 sites, and detections at several of them). Fitting `occu` on 2–3
 * sites yields unstable, indefensible estimates. This gate decides — per species
 * per stream — whether we model or show an explicit "datos insuficientes" state,
 * and produces Spanish reasons for the UI so the field team can see exactly what
 * is blocking each species.
 */
import type { DetectionFrame } from "./detection-history";

export interface EligibilityThresholds {
  /** Minimum surveyed sites. */
  minSites: number;
  /** Minimum sites with ≥1 detection (need presence spread, not one hotspot). */
  minSitesDetected: number;
  /** Minimum total detections. */
  minDetections: number;
  /** Minimum repeat occasions the frame must reach (p is unidentifiable at 1). */
  minOccasions: number;
}

export const DEFAULT_THRESHOLDS: EligibilityThresholds = {
  minSites: 15,
  minSitesDetected: 3,
  minDetections: 10,
  minOccasions: 2,
};

export interface EligibilityStats {
  nSitesSurveyed: number;
  nSitesDetected: number;
  totalDetections: number;
  maxOccasions: number;
  naiveOccupancy: number;
}

export interface EligibilityResult {
  eligible: boolean;
  /** Spanish, UI-facing reasons the species is not yet modelable (empty if eligible). */
  reasons: string[];
  stats: EligibilityStats;
}

export function assessEligibility(
  frame: DetectionFrame,
  thresholds: EligibilityThresholds = DEFAULT_THRESHOLDS,
): EligibilityResult {
  const stats: EligibilityStats = {
    nSitesSurveyed: frame.nSitesSurveyed,
    nSitesDetected: frame.nSitesDetected,
    totalDetections: frame.totalDetections,
    maxOccasions: frame.maxOccasions,
    naiveOccupancy: frame.naiveOccupancy,
  };

  const reasons: string[] = [];
  if (frame.nSitesSurveyed < thresholds.minSites) {
    reasons.push(
      `Muy pocos sitios muestreados (${frame.nSitesSurveyed}; se requieren ≥${thresholds.minSites}).`,
    );
  }
  if (frame.nSitesDetected < thresholds.minSitesDetected) {
    reasons.push(
      `Detecciones concentradas en muy pocos sitios (${frame.nSitesDetected}; se requieren ≥${thresholds.minSitesDetected}).`,
    );
  }
  if (frame.totalDetections < thresholds.minDetections) {
    reasons.push(
      `Muy pocas detecciones en total (${frame.totalDetections}; se requieren ≥${thresholds.minDetections}).`,
    );
  }
  if (frame.maxOccasions < thresholds.minOccasions) {
    reasons.push(
      `Muy pocas ocasiones de muestreo (${frame.maxOccasions}; se requieren ≥${thresholds.minOccasions}).`,
    );
  }

  return { eligible: reasons.length === 0, reasons, stats };
}
