import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { birdnetValidationCampaigns } from "@/db/schema";
import type { getUserCameraTrapProjects } from "@/lib/camera-trap-auth";
import {
  extractSiteIdFromDeploymentName,
  loadSiteHabitatMap,
  resolveHabitatForDeployment,
  UNKNOWN_HABITAT_KEY,
} from "@/lib/habitat-lookup";
import { recordingInstant } from "./clip-geometry";
import { deploymentScopeSql, speciesNamesFor } from "./query-helpers";

/**
 * CSV export of the clips reviewers confirmed as correct, with what it takes
 * to join them to habitat: site id (the ODK sites dataset key), coordinates,
 * habitat type, and the detection's local wall-clock time.
 *
 * WHICH ANSWERS COUNT. Every reviewer's. A clip is a row when at least one
 * reviewer answered "correct", and the row carries how many said correct,
 * incorrect and unsure, so a clip the reviewers disagree on can be filtered
 * out downstream. This is a list of confirmed detections, not the fit input:
 * the threshold fit still reads exactly one answer per clip
 * (`resolveFitEligibleReviews`), and nothing here feeds it.
 *
 * NOT BLINDED. Every reviewer's answers are exported even while a species is
 * still under review, including to someone part-way through reviewing it — a
 * deliberate choice for this download, unlike the review page and the site
 * coverage counts. `validation_status` says whether the species is finished.
 *
 * NO LANDOWNER NAMES. `biochoco_deployments.site_name` carries the landowner
 * ("CCN-003 - Gregory Paladines"), and this file is meant to travel to
 * collaborators. `site_id` is the habitat join key, so the name stays out.
 */

/** Mainland Ecuador is UTC-5 year-round (no DST). Filenames carry local time. */
export const ECUADOR_UTC_OFFSET = "-05:00";

export interface CorrectDetectionRow {
  species: string;
  commonName: string | null;
  spanishName: string | null;
  campaignId: number;
  campaignStatus: string;
  sampleId: number;
  audioIdentificationId: number;
  detectionId: number;
  deploymentId: number | null;
  deploymentName: string | null;
  projectName: string | null;
  siteId: string | null;
  latitude: number | null;
  longitude: number | null;
  habitat: string | null;
  habitatSource: "odk" | "snapshot" | null;
  recordingFile: string;
  driveFileId: string | null;
  detectionStartS: number;
  detectionEndS: number;
  /** `YYYY-MM-DD HH:MM:SS`, Ecuador local; null when the filename has no timestamp. */
  detectionLocal: string | null;
  inDeploymentWindow: boolean | null;
  birdnetConfidence: number;
  scoreBin: number;
  modelVersion: string | null;
  /** Reviewers who answered "correct", alphabetical. Never empty. */
  reviewersCorrect: string[];
  nCorrect: number;
  nIncorrect: number;
  nUncertain: number;
  /** Most recent "correct" answer. */
  lastReviewedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** `2025-11-23 09:00:58` → `2025-11-23T09:00:58-05:00`. */
export function toIsoWithOffset(local: string | null): string | null {
  if (!local) return null;
  return `${local.replace(" ", "T")}${ECUADOR_UTC_OFFSET}`;
}

/** Normalise a deployment window bound to `YYYY-MM-DDTHH:MM` for string comparison. */
function windowBound(value: string | null, end: boolean): string | null {
  if (!value) return null;
  const v = value.trim().replace(" ", "T");
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return `${v}T${end ? "23:59" : "00:00"}`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return v.slice(0, 16);
  return null;
}

/**
 * Whether a detection falls inside the deployment's valid recording window
 * (`valid_start`/`valid_end`, local `YYYY-MM-DDTHH:MM`). Null when neither
 * bound is known or the detection has no timestamp — "unknown", not "inside".
 * This is what flags a recorder test uploaded into the wrong folder.
 */
export function withinWindow(
  detectionLocal: string | null,
  validStart: string | null,
  validEnd: string | null
): boolean | null {
  if (!detectionLocal) return null;
  const start = windowBound(validStart, false);
  const end = windowBound(validEnd, true);
  if (!start && !end) return null;
  const at = detectionLocal.replace(" ", "T").slice(0, 16);
  if (start && at < start) return false;
  if (end && at > end) return false;
  return true;
}

export const CORRECT_EXPORT_COLUMNS = [
  "species_scientific",
  "species_common_en",
  "species_common_es",
  "detection_datetime_local",
  "detection_datetime_iso",
  "detection_date",
  "detection_time",
  "site_id",
  "deployment_name",
  "deployment_id",
  "project",
  "latitude",
  "longitude",
  "habitat",
  "habitat_source",
  "in_deployment_window",
  "recording_file",
  "detection_start_s",
  "detection_end_s",
  "birdnet_confidence",
  "score_bin",
  "model_version",
  "reviewers_correct",
  "n_correct",
  "n_incorrect",
  "n_uncertain",
  "last_reviewed_at",
  "drive_file_id",
  "sample_id",
  "audio_identification_id",
  "detection_id",
  "validation_id",
  "validation_status",
] as const;

function csvVal(val: string | number | boolean | null | undefined): string {
  if (val === null || val === undefined || val === "") return "";
  const str = String(val);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/** The CSV text: header row, then one row per correct clip. */
export function buildCorrectDetectionsCsv(rows: CorrectDetectionRow[]): string {
  const lines: string[] = [CORRECT_EXPORT_COLUMNS.join(",")];

  for (const r of rows) {
    const [date, time] = r.detectionLocal ? r.detectionLocal.split(" ") : [null, null];
    lines.push(
      [
        r.species,
        r.commonName,
        r.spanishName,
        r.detectionLocal,
        toIsoWithOffset(r.detectionLocal),
        date,
        time,
        r.siteId,
        r.deploymentName,
        r.deploymentId,
        r.projectName,
        r.latitude,
        r.longitude,
        r.habitat,
        r.habitatSource,
        r.inDeploymentWindow === null ? null : r.inDeploymentWindow ? "true" : "false",
        r.recordingFile,
        r.detectionStartS,
        r.detectionEndS,
        r.birdnetConfidence,
        r.scoreBin,
        r.modelVersion,
        r.reviewersCorrect.join("; "),
        r.nCorrect,
        r.nIncorrect,
        r.nUncertain,
        r.lastReviewedAt ? r.lastReviewedAt.toISOString() : null,
        r.driveFileId,
        r.sampleId,
        r.audioIdentificationId,
        r.detectionId,
        r.campaignId,
        r.campaignStatus,
      ]
        .map(csvVal)
        .join(",")
    );
  }

  // BOM first so Excel reads accented names as UTF-8.
  return "﻿" + lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

interface RawRow {
  sample_id: number;
  audio_identification_id: number;
  confidence: number;
  bin_index: number;
  snapshot_habitat: string | null;
  reviewers_correct: string;
  n_correct: number;
  n_incorrect: number;
  n_uncertain: number;
  last_reviewed_at: number | null;
  model_version: string | null;
  detection_id: number;
  start_time: number;
  end_time: number;
  filename: string;
  drive_file_id: string | null;
  deployment_id: number | null;
  deployment_name: string | null;
  deployment_site_name: string | null;
  latitude: number | null;
  longitude: number | null;
  valid_start: string | null;
  valid_end: string | null;
  project_name: string | null;
}

/**
 * Collect the clips the caller may see that at least one reviewer marked
 * correct, for one species or all. Ordered by species, then detection time.
 */
export async function collectCorrectDetections(opts: {
  ctProjects: Awaited<ReturnType<typeof getUserCameraTrapProjects>>;
  species?: string;
}): Promise<CorrectDetectionRow[]> {
  const campaigns = db.all<{ id: number; species: string; status: string }>(sql`
    SELECT c.id, c.species, c.status
      FROM ${birdnetValidationCampaigns} c
     WHERE ${opts.species === undefined ? sql`1 = 1` : sql`c.species = ${opts.species}`}
       AND EXISTS (
         SELECT 1 FROM birdnet_validation_samples s
           JOIN birdnet_validation_reviews r ON r.sample_id = s.id
          WHERE s.campaign_id = c.id AND r.outcome = 'correct'
       )
     ORDER BY c.species, c.id DESC
  `);

  const habitatMap = await loadSiteHabitatMap();
  const rows: CorrectDetectionRow[] = [];
  // A species restarted after being abandoned has two validations that can
  // share detections; keep each detection once (the newest validation wins,
  // since campaigns arrive id-descending within a species).
  const seen = new Set<number>();

  for (const c of campaigns) {
    const raw = db.all<RawRow>(sql`
      SELECT s.id AS sample_id, s.audio_identification_id, s.confidence, s.bin_index,
             s.habitat AS snapshot_habitat,
             GROUP_CONCAT(CASE WHEN r.outcome = 'correct' THEN r.reviewer_email END, '|')
               AS reviewers_correct,
             SUM(r.outcome = 'correct') AS n_correct,
             SUM(r.outcome = 'incorrect') AS n_incorrect,
             SUM(r.outcome = 'uncertain') AS n_uncertain,
             MAX(CASE WHEN r.outcome = 'correct' THEN r.reviewed_at END) AS last_reviewed_at,
             ai.model_version,
             ad.id AS detection_id, ad.start_time, ad.end_time,
             af.filename, af.drive_file_id,
             d.id AS deployment_id, d.name AS deployment_name,
             d.site_name AS deployment_site_name, d.latitude, d.longitude,
             d.valid_start, d.valid_end, p.name AS project_name
        FROM birdnet_validation_samples s
        JOIN birdnet_validation_reviews r ON r.sample_id = s.id
        JOIN audio_identifications ai ON ai.id = s.audio_identification_id
        JOIN audio_detections ad ON ad.id = ai.audio_detection_id
        JOIN audio_files af ON af.id = ad.audio_file_id
        LEFT JOIN biochoco_deployments d ON d.id = af.deployment_id
        LEFT JOIN ct_projects p ON p.id = d.ct_project_id
       WHERE s.campaign_id = ${c.id}
         AND ${deploymentScopeSql(opts.ctProjects)}
       GROUP BY s.id
      HAVING SUM(r.outcome = 'correct') > 0
    `);

    for (const r of raw) {
      if (seen.has(r.audio_identification_id)) continue;
      seen.add(r.audio_identification_id);

      const live = r.deployment_name
        ? resolveHabitatForDeployment(
            { siteName: r.deployment_site_name, deploymentName: r.deployment_name },
            habitatMap
          )
        : UNKNOWN_HABITAT_KEY;
      const habitat =
        live !== UNKNOWN_HABITAT_KEY ? live : (r.snapshot_habitat ?? null);
      const detectionLocal = recordingInstant(r.filename, r.start_time);

      rows.push({
        species: c.species,
        commonName: null,
        spanishName: null,
        campaignId: c.id,
        campaignStatus: c.status,
        sampleId: r.sample_id,
        audioIdentificationId: r.audio_identification_id,
        detectionId: r.detection_id,
        deploymentId: r.deployment_id,
        deploymentName: r.deployment_name,
        projectName: r.project_name,
        siteId: r.deployment_name
          ? extractSiteIdFromDeploymentName(r.deployment_name)
          : null,
        latitude: r.latitude,
        longitude: r.longitude,
        habitat,
        habitatSource:
          live !== UNKNOWN_HABITAT_KEY ? "odk" : r.snapshot_habitat ? "snapshot" : null,
        recordingFile: r.filename,
        driveFileId: r.drive_file_id,
        detectionStartS: r.start_time,
        detectionEndS: r.end_time,
        detectionLocal,
        inDeploymentWindow: withinWindow(detectionLocal, r.valid_start, r.valid_end),
        birdnetConfidence: r.confidence,
        scoreBin: r.bin_index,
        modelVersion: r.model_version,
        reviewersCorrect: r.reviewers_correct.split("|").sort(),
        nCorrect: Number(r.n_correct),
        nIncorrect: Number(r.n_incorrect),
        nUncertain: Number(r.n_uncertain),
        lastReviewedAt:
          r.last_reviewed_at === null ? null : new Date(Number(r.last_reviewed_at) * 1000),
      });
    }
  }

  const names = await speciesNamesFor([...new Set(rows.map((r) => r.species))]);
  for (const row of rows) {
    row.commonName = names.get(row.species)?.commonName ?? null;
    row.spanishName = names.get(row.species)?.spanishName ?? null;
  }
  rows.sort(
    (a, b) =>
      a.species.localeCompare(b.species) ||
      (a.detectionLocal ?? "").localeCompare(b.detectionLocal ?? "") ||
      a.sampleId - b.sampleId
  );
  return rows;
}

/** Does this species have a validation at all? For a 404 on an unknown name. */
export async function speciesHasValidation(species: string): Promise<boolean> {
  const [row] = await db
    .select({ id: birdnetValidationCampaigns.id })
    .from(birdnetValidationCampaigns)
    .where(eq(birdnetValidationCampaigns.species, species))
    .limit(1);
  return Boolean(row);
}
