import "server-only";
import { db } from "@/db";
import { sql } from "drizzle-orm";
import { log } from "@/lib/log";
import type { CuratedAudioClip, CuratedImage, ReportSnapshot, ReportStats } from "./snapshot-types";
import {
  exactCoord,
  resolveCuratedAudio,
  resolveCuratedImages,
  siteCode,
  summarizeCameraSpecies,
  type EffectiveSpeciesRow,
  type SpeciesMeta,
} from "./snapshot-transforms";
import { countSitesByHabitat, habitatForSite } from "./habitat";

// BioChoco = ct_projects.id 1 (documented convention; matches extract.mjs).
const PROJECT_ID = 1;
// Confidence floor for "candidate" audio species (matches the report).
const AUDIO_CONF = 0.8;

// Deployment scope: this project, excluding soft-deleted rows.
const DEP_SCOPE = sql`ct_project_id = ${PROJECT_ID} AND (excluded IS NULL OR excluded = 0)`;

function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v ?? 0);
}

/**
 * Compute the outward-safe BioChoco stat payload from live tables. Ported from
 * ~/apps/biochoco-report/extract.mjs. Emits site codes only (no landowner
 * names); sampling-site coordinates are shown at full precision by FCAT's call.
 */
export async function computeStats(): Promise<ReportStats> {
  const project =
    (await db.get<{ id: number; name: string }>(
      sql`SELECT id, name FROM ct_projects WHERE id = ${PROJECT_ID}`,
    )) ?? null;

  const deploymentCount = num(
    (await db.get<{ n: number }>(sql`SELECT COUNT(*) n FROM biochoco_deployments WHERE ${DEP_SCOPE}`))?.n,
  );
  const retrievedCount = num(
    (await db.get<{ n: number }>(
      sql`SELECT COUNT(*) n FROM biochoco_deployments WHERE ${DEP_SCOPE} AND date_end IS NOT NULL`,
    ))?.n,
  );
  const rs = await db.get<{ cam: number; audio: number; climate: number }>(sql`
    SELECT
      SUM(CASE WHEN upload_camera_count  > 0 THEN 1 ELSE 0 END) cam,
      SUM(CASE WHEN upload_audio_count   > 0 THEN 1 ELSE 0 END) audio,
      SUM(CASE WHEN upload_ibutton_count > 0 THEN 1 ELSE 0 END) climate
      FROM biochoco_deployments WHERE ${DEP_SCOPE} AND date_end IS NOT NULL`);
  const retrievedSensors = {
    cam: num(rs?.cam),
    audio: num(rs?.audio),
    climate: num(rs?.climate),
  };
  // Distinct site codes → per-habitat site counts via the ODK-derived map.
  const distinctSiteCodes = (
    await db.all<{ name: string }>(sql`
      SELECT DISTINCT name FROM biochoco_deployments WHERE ${DEP_SCOPE}`)
  ).map((r) => siteCode(r.name));
  const distinctSites = new Set(distinctSiteCodes).size;
  const habitatCounts = countSitesByHabitat(distinctSiteCodes);
  const byStatus = (
    await db.all<{ status: string; n: number }>(sql`
      SELECT status, COUNT(*) n FROM biochoco_deployments WHERE ${DEP_SCOPE}
      GROUP BY status ORDER BY n DESC`)
  ).map((r) => ({ status: r.status, n: num(r.n) }));

  const samplingSpan =
    (await db.get<{ start: string | null; end: string | null }>(sql`
      SELECT MIN(date_start) start, MAX(date_end) end
        FROM biochoco_deployments WHERE ${DEP_SCOPE}`)) ?? { start: null, end: null };
  // Prefer the QA-validated sampling window (valid_* ?? date_*) so a camera that
  // died early counts its real span, not the full install→retrieve interval —
  // otherwise this published effort figure is over-reported. Same trim as the
  // CSV export and occupancy pipeline. (samplingSpan above stays raw: it is the
  // cross-sensor project date range, not camera effort.)
  const cameraTrapDays = Math.round(
    num(
      (await db.get<{ d: number }>(sql`
        SELECT COALESCE(SUM(
                 julianday(COALESCE(valid_end, date_end))
                 - julianday(COALESCE(valid_start, date_start))
               ), 0) d
          FROM biochoco_deployments
         WHERE ${DEP_SCOPE}
           AND COALESCE(valid_start, date_start) IS NOT NULL
           AND COALESCE(valid_end, date_end) IS NOT NULL`))?.d,
    ),
  );

  const totalImages = num(
    (await db.get<{ n: number }>(sql`
      SELECT COUNT(*) n FROM biochoco_images im
        JOIN biochoco_deployments d ON d.id = im.deployment_id
       WHERE d.ct_project_id = ${PROJECT_ID} AND (d.excluded IS NULL OR d.excluded = 0)`))?.n,
  );
  const totalDetections = num(
    (await db.get<{ n: number }>(sql`
      SELECT COUNT(*) n FROM biochoco_detections det
        JOIN biochoco_images im ON im.id = det.image_id
        JOIN biochoco_deployments d ON d.id = im.deployment_id
       WHERE d.ct_project_id = ${PROJECT_ID} AND (d.excluded IS NULL OR d.excluded = 0)`))?.n,
  );

  // ---- camera species (effective label, human-touched only) ----
  const effRows: EffectiveSpeciesRow[] = (
    await db.all<{ eff: string; detections: number }>(sql`
      SELECT COALESCE(NULLIF(i.corrected_species, ''), i.species) AS eff, COUNT(*) detections
        FROM biochoco_identifications i
        JOIN biochoco_detections det ON det.id = i.detection_id
        JOIN biochoco_images im ON im.id = det.image_id
        JOIN biochoco_deployments d ON d.id = im.deployment_id
       WHERE d.ct_project_id = ${PROJECT_ID} AND i.verification_status IN ('verified', 'corrected')
       GROUP BY eff ORDER BY detections DESC`)
  ).map((r) => ({ eff: r.eff, detections: num(r.detections) }));
  const speciesMeta = new Map<string, SpeciesMeta>(
    (
      await db.all<{
        scientific_name: string;
        type: string;
        taxonomic_rank: string | null;
        common_name: string;
        spanish_name: string | null;
      }>(sql`
        SELECT scientific_name, type, taxonomic_rank, common_name, spanish_name
          FROM biochoco_species`)
    ).map((s) => [
      s.scientific_name,
      {
        type: s.type,
        taxonomicRank: s.taxonomic_rank,
        commonName: s.common_name,
        spanishName: s.spanish_name,
      },
    ]),
  );
  const { cameraRealSpecies, cameraSpeciesByType, cameraTopSpecies } = summarizeCameraSpecies(
    effRows,
    speciesMeta,
  );
  // Scalar total of human-reviewed identifications (mirrors effRows' join, no group-by).
  const identificationsReviewed = num(
    (await db.get<{ n: number }>(sql`
      SELECT COUNT(*) n
        FROM biochoco_identifications i
        JOIN biochoco_detections det ON det.id = i.detection_id
        JOIN biochoco_images im ON im.id = det.image_id
        JOIN biochoco_deployments d ON d.id = im.deployment_id
       WHERE d.ct_project_id = ${PROJECT_ID}
         AND i.verification_status IN ('verified', 'corrected')`))?.n,
  );

  // ---- audio ----
  const audioAgg = await db.get<{ files: number; bytes: number; deployments: number }>(sql`
    SELECT COUNT(*) files, COALESCE(SUM(af.file_size), 0) bytes,
           COUNT(DISTINCT af.deployment_id) deployments
      FROM audio_files af
      JOIN biochoco_deployments d ON d.id = af.deployment_id
     WHERE d.ct_project_id = ${PROJECT_ID}`);
  const audio = {
    files: num(audioAgg?.files),
    bytes: num(audioAgg?.bytes),
    deployments: num(audioAgg?.deployments),
  };
  const audioDetections08 = num(
    (await db.get<{ n: number }>(sql`
      SELECT COUNT(*) n FROM audio_identifications ai
        JOIN audio_detections ad ON ad.id = ai.audio_detection_id
        JOIN audio_files af ON af.id = ad.audio_file_id
        JOIN biochoco_deployments d ON d.id = af.deployment_id
       WHERE d.ct_project_id = ${PROJECT_ID} AND ai.confidence >= ${AUDIO_CONF}`))?.n,
  );
  const audioSpeciesCount = num(
    (await db.get<{ n: number }>(sql`
      SELECT COUNT(DISTINCT ai.species) n FROM audio_identifications ai
        JOIN audio_detections ad ON ad.id = ai.audio_detection_id
        JOIN audio_files af ON af.id = ad.audio_file_id
        JOIN biochoco_deployments d ON d.id = af.deployment_id
       WHERE d.ct_project_id = ${PROJECT_ID} AND ai.confidence >= ${AUDIO_CONF}`))?.n,
  );
  const audioReviewedSpeciesCount = num(
    (await db.get<{ n: number }>(sql`
      SELECT COUNT(DISTINCT ai.species) n FROM audio_identifications ai
        JOIN audio_detections ad ON ad.id = ai.audio_detection_id
        JOIN audio_files af ON af.id = ad.audio_file_id
        JOIN biochoco_deployments d ON d.id = af.deployment_id
       WHERE d.ct_project_id = ${PROJECT_ID} AND ai.verification_status = 'verified'`))?.n,
  );
  const audioTopSpecies = (
    await db.all<{ sci: string; detections: number }>(sql`
      SELECT ai.species sci, COUNT(*) detections FROM audio_identifications ai
        JOIN audio_detections ad ON ad.id = ai.audio_detection_id
        JOIN audio_files af ON af.id = ad.audio_file_id
        JOIN biochoco_deployments d ON d.id = af.deployment_id
       WHERE d.ct_project_id = ${PROJECT_ID} AND ai.confidence >= ${AUDIO_CONF}
       GROUP BY ai.species ORDER BY detections DESC LIMIT 20`)
  ).map((r) => ({ sci: r.sci, detections: num(r.detections) }));

  // ---- iButton (only readings + processed are surfaced) ----
  const ibuttonProcessed = num(
    (await db.get<{ n: number }>(sql`
      SELECT COUNT(*) n FROM ibutton_uploads u
        JOIN biochoco_deployments d ON d.id = u.deployment_id
       WHERE d.ct_project_id = ${PROJECT_ID}`))?.n,
  );
  const ibuttonReadingsCount = num(
    (await db.get<{ n: number }>(sql`
      SELECT COUNT(*) n FROM ibutton_readings r
        JOIN biochoco_deployments d ON d.id = r.deployment_id
       WHERE d.ct_project_id = ${PROJECT_ID}`))?.n,
  );

  // ---- upload totals ----
  const ub = await db.get<{ camera: number; audio: number; ibutton: number }>(sql`
    SELECT COALESCE(SUM(upload_camera_size_bytes), 0) camera,
           COALESCE(SUM(upload_audio_size_bytes), 0) audio,
           COALESCE(SUM(upload_ibutton_size_bytes), 0) ibutton
      FROM biochoco_deployments WHERE ${DEP_SCOPE}`);
  const uploadBytes = { camera: num(ub?.camera), audio: num(ub?.audio), ibutton: num(ub?.ibutton) };
  const uc = await db.get<{ camPhotos: number; audioFiles: number; ibuttonFiles: number }>(sql`
    SELECT COALESCE(SUM(upload_camera_count), 0) camPhotos,
           COALESCE(SUM(upload_audio_count), 0) audioFiles,
           COALESCE(SUM(upload_ibutton_count), 0) ibuttonFiles
      FROM biochoco_deployments WHERE ${DEP_SCOPE}`);
  const uploadCounts = {
    camPhotos: num(uc?.camPhotos),
    audioFiles: num(uc?.audioFiles),
    ibuttonFiles: num(uc?.ibuttonFiles),
  };

  const deploymentsByMonth = (
    await db.all<{ month: string; n: number }>(sql`
      SELECT strftime('%Y-%m', date_start) month, COUNT(*) n
        FROM biochoco_deployments WHERE ${DEP_SCOPE} AND date_start IS NOT NULL
       GROUP BY month ORDER BY month`)
  ).map((r) => ({ month: r.month, n: num(r.n) }));

  // ---- per-deployment map points (with coordinates), stripped to site codes ----
  const deployments = (
    await db.all<{
      name: string;
      status: string;
      latitude: number | null;
      longitude: number | null;
      date_start: string | null;
      date_end: string | null;
      detections: number;
    }>(sql`
      SELECT d.name, d.status, d.latitude, d.longitude, d.date_start, d.date_end,
             (SELECT COUNT(*) FROM biochoco_detections det
                JOIN biochoco_images im ON im.id = det.image_id
               WHERE im.deployment_id = d.id) AS detections
        FROM biochoco_deployments d
       WHERE ${DEP_SCOPE} AND d.latitude IS NOT NULL AND d.longitude IS NOT NULL
       ORDER BY d.name`)
  ).map((d) => ({
    code: siteCode(d.name),
    status: d.status,
    habitat: habitatForSite(siteCode(d.name)),
    lat: exactCoord(d.latitude),
    lng: exactCoord(d.longitude),
    dateStart: d.date_start,
    dateEnd: d.date_end,
    detections: num(d.detections),
  }));

  return {
    project,
    deploymentCount,
    retrievedCount,
    retrievedSensors,
    distinctSites,
    habitatCounts,
    byStatus,
    samplingSpan,
    cameraTrapDays,
    totalImages,
    totalDetections,
    cameraRealSpecies,
    cameraSpeciesByType,
    identificationsReviewed,
    cameraTopSpecies,
    audio,
    audioSpeciesCount,
    audioDetections08,
    audioReviewedSpeciesCount,
    audioThreshold: AUDIO_CONF,
    audioTopSpecies,
    ibutton: { processed: ibuttonProcessed, readings: ibuttonReadingsCount },
    uploadBytes,
    uploadCounts,
    deploymentsByMonth,
    deployments,
  };
}

/** Which of the given image ids exist AND belong to BioChoco. */
async function validBiochocoImageIds(ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const rows = await db.all<{ id: number }>(sql`
    SELECT im.id FROM biochoco_images im
      JOIN biochoco_deployments d ON d.id = im.deployment_id
     WHERE d.ct_project_id = ${PROJECT_ID}
       AND im.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
  return new Set(rows.map((r) => num(r.id)));
}

async function validBiochocoAudioIds(ids: number[]): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const rows = await db.all<{ id: number }>(sql`
    SELECT af.id FROM audio_files af
      JOIN biochoco_deployments d ON d.id = af.deployment_id
     WHERE d.ct_project_id = ${PROJECT_ID}
       AND af.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
  return new Set(rows.map((r) => num(r.id)));
}

/**
 * Build a full snapshot: live stats + resolved curated media. Curated ids that
 * don't exist or aren't BioChoco's are dropped (logged), never fatal.
 */
export async function buildSnapshot(
  curation: { images: CuratedImage[]; audio: CuratedAudioClip[] },
  opts: { slug: string; generatedAt: string; generatedBy: string | null },
): Promise<ReportSnapshot> {
  const stats = await computeStats();

  const validImageIds = await validBiochocoImageIds(curation.images.map((i) => i.imageId));
  const validAudioIds = await validBiochocoAudioIds(curation.audio.map((a) => a.audioId));

  const { images, droppedImageIds } = resolveCuratedImages(curation.images, validImageIds);
  const { audio, droppedAudioIds } = resolveCuratedAudio(curation.audio, validAudioIds);

  if (droppedImageIds.length || droppedAudioIds.length) {
    log.warn(
      { slug: opts.slug, droppedImageIds, droppedAudioIds },
      "[public-report] dropped curated media ids missing from BioChoco",
    );
  }

  return {
    slug: opts.slug,
    generatedAt: opts.generatedAt,
    generatedBy: opts.generatedBy,
    stats,
    images,
    audio,
  };
}
