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
  /** Inclusive active-survey window (UTC calendar days) — surfaced so the
   *  sample matrix can show each site's sampling period and flag an outlier
   *  window that inflates `maxOccasions`. */
  windowStart: CaptureDay;
  windowEnd: CaptureDay;
  /** Total inclusive days in the window (drives this site's occasion count). */
  totalDays: number;
}

export interface DetectionFrame {
  siteIds: string[];
  maxOccasions: number;
  /** sites × maxOccasions presence/absence with NA padding. */
  y: Cell[][];
  /** sites × maxOccasions continuous survey effort (active days in the occasion
   *  bin, 1..binWidth); null where y is NA. Fed to `occu` as a numeric detection
   *  covariate — a single `p~effort` slope, not per-level dummies. */
  effort: (number | null)[][];
  perSite: SitePerRow[];
  /** Sites with ≥1 non-NA cell. */
  nSitesSurveyed: number;
  /** Sites with ≥1 detection. */
  nSitesDetected: number;
  totalDetections: number;
  /** Naive occupancy = detected / surveyed (0 when nothing surveyed). */
  naiveOccupancy: number;
  /** Detection events for a site not in this frame's pool (excluded). */
  nUnknownSite: number;
  /** Detection events whose capture day fell outside their site's window. */
  nOutOfWindow: number;
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
  let nUnknownSite = 0;
  for (const ev of events) {
    if (!layouts.has(ev.siteId)) {
      nUnknownSite++;
      continue;
    }
    const arr = eventsBySite.get(ev.siteId);
    if (arr) arr.push(ev.captureDay);
    else eventsBySite.set(ev.siteId, [ev.captureDay]);
  }

  const y: Cell[][] = [];
  const effort: (number | null)[][] = [];
  const perSite: SitePerRow[] = [];
  const siteIds: string[] = [];
  let nSitesSurveyed = 0;
  let nSitesDetected = 0;
  let totalDetections = 0;
  let nOutOfWindow = 0;

  for (const site of sites) {
    const layout = layouts.get(site.siteId)!;
    const row: Cell[] = new Array(maxOccasions).fill(null);
    const effortRow: (number | null)[] = new Array(maxOccasions).fill(null);
    for (let j = 0; j < layout.count; j++) {
      row[j] = 0;
      // Continuous effort = active days in this occasion's bin (1..binWidth).
      effortRow[j] = layout.nDays[j];
    }

    let siteDetections = 0;
    for (const day of eventsBySite.get(site.siteId) ?? []) {
      const idx = occasionIndexForDay(layout, day, binWidth);
      if (idx === null) {
        nOutOfWindow++; // out of window
        continue;
      }
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
      windowStart: site.windowStart,
      windowEnd: site.windowEnd,
      totalDays: layout.totalDays,
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
    nUnknownSite,
    nOutOfWindow,
  };
}
