/**
 * Detection-history assembly for single-season single-species occupancy.
 *
 * Turns a set of surveyed sites plus one species' detection events into the
 * site × occasion presence/absence matrix `unmarked::occu` consumes:
 *   - `1`   detected at that site in that occasion,
 *   - `0`   site surveyed in that occasion, species not detected,
 *   - `null` occasion beyond that site's window (NA padding to the ragged max).
 *
 * The builder is deliberately pure and stream-agnostic: the caller filters
 * detections upstream (camera → verified/corrected only; audio → confidence
 * threshold) and resolves "site" + "season" before calling. See the covariate
 * plan in the requirements doc.
 */
import type { CaptureDay } from "./capture-date";
import {
  computeOccasions,
  DEFAULT_BIN_WIDTH_DAYS,
  effortLevel,
  occasionIndexForDay,
  type OccasionLayout,
} from "./occasions";

export interface OccupancySite {
  /** Stable site key (physical-location key, or deployment id as a fallback). */
  siteId: string;
  siteName: string;
  latitude: number | null;
  longitude: number | null;
  /** Inclusive active-survey window (UTC calendar days). */
  windowStart: CaptureDay;
  windowEnd: CaptureDay;
}

export interface SpeciesDetectionEvent {
  siteId: string;
  captureDay: CaptureDay;
}

export type Cell = 0 | 1 | null;

export interface SitePerRow {
  siteId: string;
  siteName: string;
  /** Occasions this site was actually surveyed (non-NA cells in its row). */
  occasions: number;
  /** Species detections that landed inside this site's window. */
  detections: number;
  detected: boolean;
}

export interface DetectionFrame {
  siteIds: string[];
  maxOccasions: number;
  /** sites × maxOccasions presence/absence with NA padding. */
  y: Cell[][];
  /** sites × maxOccasions categorical survey-effort level; null where y is NA. */
  effort: (string | null)[][];
  perSite: SitePerRow[];
  /** Sites with ≥1 non-NA cell. */
  nSitesSurveyed: number;
  /** Sites with ≥1 detection. */
  nSitesDetected: number;
  totalDetections: number;
  /** Naive occupancy = detected / surveyed (0 when nothing surveyed). */
  naiveOccupancy: number;
}

export interface BuildOptions {
  binWidth?: number;
}

export function buildDetectionFrame(
  sites: OccupancySite[],
  events: SpeciesDetectionEvent[],
  options: BuildOptions = {},
): DetectionFrame {
  const binWidth = options.binWidth ?? DEFAULT_BIN_WIDTH_DAYS;

  const layouts = new Map<string, OccasionLayout>();
  for (const site of sites) {
    layouts.set(site.siteId, computeOccasions(site.windowStart, site.windowEnd, binWidth));
  }
  const maxOccasions = sites.length
    ? Math.max(...sites.map((s) => layouts.get(s.siteId)!.count))
    : 0;

  // Index events by site for a single pass; ignore events for unknown sites and
  // events outside a site's window (out-of-window detections are excluded, never
  // silently folded into occasion 0).
  const eventsBySite = new Map<string, CaptureDay[]>();
  for (const ev of events) {
    if (!layouts.has(ev.siteId)) continue;
    const arr = eventsBySite.get(ev.siteId);
    if (arr) arr.push(ev.captureDay);
    else eventsBySite.set(ev.siteId, [ev.captureDay]);
  }

  const y: Cell[][] = [];
  const effort: (string | null)[][] = [];
  const perSite: SitePerRow[] = [];
  const siteIds: string[] = [];
  let nSitesSurveyed = 0;
  let nSitesDetected = 0;
  let totalDetections = 0;

  for (const site of sites) {
    const layout = layouts.get(site.siteId)!;
    const row: Cell[] = new Array(maxOccasions).fill(null);
    const effortRow: (string | null)[] = new Array(maxOccasions).fill(null);
    for (let j = 0; j < layout.count; j++) {
      row[j] = 0;
      effortRow[j] = effortLevel(layout.nDays[j], binWidth);
    }

    let siteDetections = 0;
    for (const day of eventsBySite.get(site.siteId) ?? []) {
      const idx = occasionIndexForDay(layout, day, binWidth);
      if (idx === null) continue; // out of window
      row[idx] = 1;
      siteDetections++;
    }

    const surveyed = layout.count > 0;
    const detected = siteDetections > 0;
    if (surveyed) nSitesSurveyed++;
    if (detected) nSitesDetected++;
    totalDetections += siteDetections;

    y.push(row);
    effort.push(effortRow);
    siteIds.push(site.siteId);
    perSite.push({
      siteId: site.siteId,
      siteName: site.siteName,
      occasions: layout.count,
      detections: siteDetections,
      detected,
    });
  }

  return {
    siteIds,
    maxOccasions,
    y,
    effort,
    perSite,
    nSitesSurveyed,
    nSitesDetected,
    totalDetections,
    naiveOccupancy: nSitesSurveyed > 0 ? nSitesDetected / nSitesSurveyed : 0,
  };
}
