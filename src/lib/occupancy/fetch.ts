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
  /**
   * Detections discarded because no capture day could be resolved
   * (dateless filename + no exif + no file_modified). This is the exact symptom
   * that once zeroed the camera stream silently — surface it, never hide it.
   */
  detectionsDroppedNoDate: number;
}

function parseYmd(s: string | null | undefined): CaptureDay | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(d.getTime()) ? null : d;
}

function deriveWindows(
  rows: {
    deployment_id: number;
    filename: string | null;
    exif: string | null;
    fileModified?: number | null;
  }[],
): Map<number, { min: CaptureDay; max: CaptureDay }> {
  const acc = new Map<number, { min: CaptureDay; max: CaptureDay }>();
  for (const r of rows) {
    const day = resolveCaptureDay({
      filename: r.filename,
      exifTimestamp: r.exif,
      fileModified: r.fileModified,
    });
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

/** Earliest / latest of the supplied days, ignoring nulls (null if both null). */
function minDay(a: CaptureDay | null | undefined, b: CaptureDay | null | undefined): CaptureDay | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a.getTime() <= b.getTime() ? a : b;
}
function maxDay(a: CaptureDay | null | undefined, b: CaptureDay | null | undefined): CaptureDay | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
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
    // Union the ODK install/retrieve window with the image-derived capture span:
    // a photo means the camera was active that day, and ODK dates occasionally
    // mismatch the data (e.g. a year-typo), which would otherwise drop every
    // in-deployment detection out of window.
    const start = minDay(parseYmd(d.date_start), derived?.min);
    const end = maxDay(parseYmd(d.date_end), derived?.max);
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

  // Occupancy site pool = BioChoco camera-trap deployments whose imagery is
  // confirmed: verified (or verified_empty — a real survey with zero detections,
  // kept as an absence site) and not excluded. Both streams share this pool for
  // consistency. Scoped to the BioChoco ct project so deployments belonging to
  // OTHER camera-trap projects (which have no BioChoco ODK site entity and would
  // otherwise force the habitat covariate to be dropped for every model) never
  // enter the analysis. Matches the app-wide BioChoco scoping used elsewhere
  // (see getBiochocoCameraTrapProjectId in biochoco/resultados/habitat-actions.ts).
  const deployments = db.all(sql`
    SELECT id, site_name, name, latitude, longitude, date_start, date_end, field_notes
    FROM biochoco_deployments
    WHERE excluded = 0
      AND status IN ('verified', 'verified_empty')
      AND ct_project_id = (SELECT id FROM ct_projects WHERE name = 'BioChoco')
  `) as DeploymentRow[];

  if (stream === "camera") {
    const images = db.all(sql`
      SELECT deployment_id, filename, exif_timestamp AS exif, file_modified AS file_modified
      FROM biochoco_images
    `) as {
      deployment_id: number;
      filename: string | null;
      exif: string | null;
      file_modified: number | null;
    }[];
    const windows = deriveWindows(
      images.map((r) => ({
        deployment_id: r.deployment_id,
        filename: r.filename,
        exif: r.exif,
        fileModified: r.file_modified,
      })),
    );
    const { sites, covariateInputs, dropped } = buildSites(deployments, windows);

    const rows = db.all(sql`
      SELECT COALESCE(NULLIF(id.corrected_species, ''), id.species) AS species,
             img.deployment_id AS deployment_id,
             img.filename AS filename,
             img.exif_timestamp AS exif,
             img.file_modified AS file_modified
      FROM biochoco_identifications id
      JOIN biochoco_detections d ON d.id = id.detection_id
      JOIN biochoco_images img ON img.id = d.image_id
      WHERE id.verification_status IN ('verified', 'corrected')
    `) as {
      species: string;
      deployment_id: number;
      filename: string | null;
      exif: string | null;
      file_modified: number | null;
    }[];

    const poolIds = new Set(sites.map((s) => s.siteId));
    const detections: ReadinessDetection[] = [];
    let detectionsDroppedNoDate = 0;
    for (const r of rows) {
      if (!r.species) continue;
      const siteId = String(r.deployment_id);
      // Only detections in the verified pool matter; a no-date drop is meaningful
      // (and worth surfacing) only for those, not for out-of-pool legacy rows.
      if (!poolIds.has(siteId)) continue;
      const day = resolveCaptureDay({
        filename: r.filename,
        exifTimestamp: r.exif,
        fileModified: r.file_modified,
      });
      if (!day) {
        detectionsDroppedNoDate++;
        continue;
      }
      detections.push({ species: r.species, siteId, captureDay: day });
    }
    return { sites, covariateInputs, detections, droppedSites: dropped, detectionsDroppedNoDate };
  }

  // audio — filenames embed dates, so no file_modified fallback needed
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

  const poolIds = new Set(sites.map((s) => s.siteId));
  const detections: ReadinessDetection[] = [];
  let detectionsDroppedNoDate = 0;
  for (const r of rows) {
    if (!r.species) continue;
    const siteId = String(r.deployment_id);
    if (!poolIds.has(siteId)) continue;
    const day = parseCaptureDayFromFilename(r.filename);
    if (!day) {
      detectionsDroppedNoDate++;
      continue;
    }
    detections.push({ species: r.species, siteId, captureDay: day });
  }
  return { sites, covariateInputs, detections, droppedSites: dropped, detectionsDroppedNoDate };
}
