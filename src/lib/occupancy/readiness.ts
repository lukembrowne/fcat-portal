/**
 * Data-readiness report — the piece that ships value before any model is fit.
 *
 * Spike finding (2026-07-03): occupancy is blocked by spatial replication of
 * detections, not compute. This computes, per species per stream, whether the
 * data clears the eligibility gate, and surfaces the exact blocking reasons in
 * Spanish so the field team can watch the numbers cross the threshold as
 * verification / fieldwork proceed. Pure over already-fetched rows so it is unit
 * testable; the server action does the DB fetch + capture-day resolution.
 */
import type { CaptureDay } from "./capture-date";
import {
  buildDetectionFrame,
  type OccupancySite,
  type SpeciesDetectionEvent,
} from "./detection-history";
import {
  assessEligibility,
  DEFAULT_THRESHOLDS,
  type EligibilityThresholds,
} from "./eligibility";
import { DEFAULT_BIN_WIDTH_DAYS } from "./occasions";

export type OccupancyStream = "camera" | "audio";

export interface ReadinessDetection {
  /** Canonical species (corrected species already resolved by the caller). */
  species: string;
  siteId: string;
  captureDay: CaptureDay;
}

export interface ReadinessSpeciesRow {
  /** Canonical scientific name (the occupancy key). */
  species: string;
  /**
   * Display names + IUCN status resolved from `biochoco_species`, populated by
   * the readiness computation (computeReadinessResult) — NOT by the pure compute
   * in this file. Null when the species is absent from the lookup; callers fall
   * back to `species`.
   */
  commonName?: string | null;
  spanishName?: string | null;
  iucnStatus?: string | null;
  eligible: boolean;
  reasons: string[];
  nSites: number;
  nSitesDetected: number;
  totalDetections: number;
  maxOccasions: number;
  naiveOccupancy: number;
}

export interface ReadinessReport {
  stream: OccupancyStream;
  binWidth: number;
  confidenceThreshold?: number;
  thresholds: EligibilityThresholds;
  /** Sites with a usable survey window (the occupancy site pool). */
  nSites: number;
  /** Of those, how many have coordinates (needed later for the map surface). */
  nSitesWithCoords: number;
  nSpecies: number;
  nEligibleSpecies: number;
  /** Detections discarded because no capture day could be resolved (0 for a
   *  healthy stream). Surfaced so a silent "0 species" can never recur unseen. */
  detectionsDroppedNoDate: number;
  species: ReadinessSpeciesRow[];
}

export interface ReadinessOptions {
  stream: OccupancyStream;
  binWidth?: number;
  confidenceThreshold?: number;
  thresholds?: EligibilityThresholds;
  /** Passed through from the fetch layer for surfacing in the report. */
  detectionsDroppedNoDate?: number;
}

export function computeReadiness(
  sites: OccupancySite[],
  detections: ReadinessDetection[],
  opts: ReadinessOptions,
): ReadinessReport {
  const binWidth = opts.binWidth ?? DEFAULT_BIN_WIDTH_DAYS;
  const thresholds = opts.thresholds ?? DEFAULT_THRESHOLDS;

  const bySpecies = new Map<string, SpeciesDetectionEvent[]>();
  for (const d of detections) {
    const ev: SpeciesDetectionEvent = { siteId: d.siteId, captureDay: d.captureDay };
    const arr = bySpecies.get(d.species);
    if (arr) arr.push(ev);
    else bySpecies.set(d.species, [ev]);
  }

  const rows: ReadinessSpeciesRow[] = [];
  for (const [species, events] of bySpecies) {
    const frame = buildDetectionFrame(sites, events, { binWidth });
    const { eligible, reasons, stats } = assessEligibility(frame, thresholds);
    rows.push({
      species,
      eligible,
      reasons,
      nSites: stats.nSitesSurveyed,
      nSitesDetected: stats.nSitesDetected,
      totalDetections: stats.totalDetections,
      maxOccasions: stats.maxOccasions,
      naiveOccupancy: stats.naiveOccupancy,
    });
  }

  // Eligible first, then by detection breadth (sites detected), then total.
  rows.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (b.nSitesDetected !== a.nSitesDetected) return b.nSitesDetected - a.nSitesDetected;
    return b.totalDetections - a.totalDetections;
  });

  return {
    stream: opts.stream,
    binWidth,
    confidenceThreshold: opts.confidenceThreshold,
    thresholds,
    nSites: sites.length,
    nSitesWithCoords: sites.filter((s) => s.latitude != null && s.longitude != null).length,
    nSpecies: rows.length,
    nEligibleSpecies: rows.filter((r) => r.eligible).length,
    detectionsDroppedNoDate: opts.detectionsDroppedNoDate ?? 0,
    species: rows,
  };
}
