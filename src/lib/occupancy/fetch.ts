import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import {
  parseCaptureDayFromFilename,
  resolveCaptureDay,
  type CaptureDay,
} from "./capture-date";
import type { OccupancySite } from "./detection-history";
import type { ReadinessDetection, OccupancyStream } from "./readiness";
import type { SiteCovariateInput } from "./covariates";
import { DEFAULT_CONFIDENCE_THRESHOLD } from "@/lib/audio-confidence";

/**
 * Shared data fetch for occupancy: resolves the surveyed-site pool (with windows
 * + covariate inputs) and the per-species detection events for one stream.
 * Used by both the readiness report (`/ocupacion`) and the modeling processor,
 * so filtering + site/window resolution stay identical across the two.
 */

interface DeploymentRow {
  id: number;
  site_name: string | null;
  name: string;
  latitude: number | null;
  longitude: number | null;
  date_start: string | null;
  date_end: string | null;
  field_notes: string | null;
}

export interface OccupancyStreamInputs {
  sites: OccupancySite[];
  /** Covariate inputs keyed by siteId, aligned to the site pool. */
  covariateInputs: Map<string, SiteCovariateInput>;
  detections: ReadinessDetection[];
  /** Deployments with data dropped for want of a usable survey window. */
  droppedSites: number;
}

function parseYmd(s: string | null | undefined): CaptureDay | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

function deriveWindows(
  rows: { deployment_id: number; filename: string | null; exif: string | null }[],
): Map<number, { min: CaptureDay; max: CaptureDay }> {
  const acc = new Map<number, { min: CaptureDay; max: CaptureDay }>();
  for (const r of rows) {
    const day = resolveCaptureDay({ filename: r.filename, exifTimestamp: r.exif });
    if (!day) continue;
    const cur = acc.get(r.deployment_id);
    if (!cur) acc.set(r.deployment_id, { min: day, max: day });
    else {
      if (day < cur.min) cur.min = day;
      if (day > cur.max) cur.max = day;
    }
  }
  return acc;
}

function buildSites(
  deployments: DeploymentRow[],
  windows: Map<number, { min: CaptureDay; max: CaptureDay }>,
): { sites: OccupancySite[]; covariateInputs: Map<string, SiteCovariateInput>; dropped: number } {
  const sites: OccupancySite[] = [];
  const covariateInputs = new Map<string, SiteCovariateInput>();
  let dropped = 0;
  for (const d of deployments) {
    const derived = windows.get(d.id);
    const start = parseYmd(d.date_start) ?? derived?.min ?? null;
    const end = parseYmd(d.date_end) ?? derived?.max ?? null;
    if (!start || !end || end.getTime() - start.getTime() < 0) {
      if (derived) dropped++;
      continue;
    }
    // Occupancy is a spatial model: a site with no coordinates can't be given
    // forest/elevation/habitat covariates or placed on the prediction map. Left
    // in, one coord-less legacy deployment (e.g. "Histórico 2014-15") would null
    // a covariate for EVERY site and collapse the whole stream to an
    // intercept-only model, so drop it from the pool instead.
    if (d.latitude == null || d.longitude == null) {
      dropped++;
      continue;
    }
    const siteId = String(d.id);
    sites.push({
      siteId,
      siteName: d.site_name ?? d.name,
      latitude: d.latitude,
      longitude: d.longitude,
      windowStart: start,
      windowEnd: end,
    });
    covariateInputs.set(siteId, {
      siteId,
      siteName: d.site_name ?? d.name,
      deploymentName: d.name,
      latitude: d.latitude,
      longitude: d.longitude,
      fieldNotes: d.field_notes,
    });
  }
  return { sites, covariateInputs, dropped };
}

export function fetchOccupancyInputs(
  stream: OccupancyStream,
  opts: { confidenceThreshold?: number } = {},
): OccupancyStreamInputs {
  const confidenceThreshold = opts.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;

  const deployments = db.all(sql`
    SELECT id, site_name, name, latitude, longitude, date_start, date_end, field_notes
    FROM biochoco_deployments
    WHERE excluded = 0
  `) as DeploymentRow[];

  if (stream === "camera") {
    const images = db.all(sql`
      SELECT deployment_id, filename, exif_timestamp AS exif FROM biochoco_images
    `) as { deployment_id: number; filename: string | null; exif: string | null }[];
    const windows = deriveWindows(images);
    const { sites, covariateInputs, dropped } = buildSites(deployments, windows);

    const rows = db.all(sql`
      SELECT COALESCE(NULLIF(id.corrected_species, ''), id.species) AS species,
             img.deployment_id AS deployment_id,
             img.filename AS filename,
             img.exif_timestamp AS exif
      FROM biochoco_identifications id
      JOIN biochoco_detections d ON d.id = id.detection_id
      JOIN biochoco_images img ON img.id = d.image_id
      WHERE id.verification_status IN ('verified', 'corrected')
    `) as { species: string; deployment_id: number; filename: string | null; exif: string | null }[];

    const detections: ReadinessDetection[] = [];
    for (const r of rows) {
      const day = resolveCaptureDay({ filename: r.filename, exifTimestamp: r.exif });
      if (!day || !r.species) continue;
      detections.push({ species: r.species, siteId: String(r.deployment_id), captureDay: day });
    }
    return { sites, covariateInputs, detections, droppedSites: dropped };
  }

  // audio
  const audioFilesRows = db.all(sql`
    SELECT deployment_id, filename FROM audio_files
  `) as { deployment_id: number; filename: string | null }[];
  const windows = deriveWindows(
    audioFilesRows.map((r) => ({ deployment_id: r.deployment_id, filename: r.filename, exif: null })),
  );
  const { sites, covariateInputs, dropped } = buildSites(deployments, windows);

  const rows = db.all(sql`
    SELECT COALESCE(NULLIF(ai.corrected_species, ''), ai.species) AS species,
           af.deployment_id AS deployment_id,
           af.filename AS filename
    FROM audio_identifications ai
    JOIN audio_detections ad ON ad.id = ai.audio_detection_id
    JOIN audio_files af ON af.id = ad.audio_file_id
    WHERE ai.confidence >= ${confidenceThreshold}
       OR ai.verification_status IN ('verified', 'corrected')
  `) as { species: string; deployment_id: number; filename: string | null }[];

  const detections: ReadinessDetection[] = [];
  for (const r of rows) {
    const day = parseCaptureDayFromFilename(r.filename);
    if (!day || !r.species) continue;
    detections.push({ species: r.species, siteId: String(r.deployment_id), captureDay: day });
  }
  return { sites, covariateInputs, detections, droppedSites: dropped };
}
