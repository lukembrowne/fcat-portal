import "server-only";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { species } from "@/db/schema";
import { computeReadiness, type ReadinessReport } from "./readiness";
import { fetchOccupancyInputs, type DateWindowAnomaly } from "./fetch";
import {
  buildAudioSubsampleReport,
  type AudioSubsampleReport,
} from "./audio-subsample-report";
import { DEFAULT_BIN_WIDTH_DAYS } from "./occasions";
import { DEFAULT_CONFIDENCE_THRESHOLD } from "@/lib/audio-confidence";

/**
 * The live data-readiness computation for /ocupacion, extracted here (out of the
 * "use server" actions module) so it can be reused by BOTH the on-demand refresh
 * action AND the weekly modeling batch, without becoming an unauthenticated
 * server action. Auth is the caller's responsibility — this is pure compute over
 * the DB. It is the expensive path (materializes every image + audio file +
 * detection); callers snapshot its result rather than run it on every page load.
 */

export interface OccupancyReadinessResult {
  camera: ReadinessReport;
  audio: ReadinessReport;
  /** Deployments dropped from a stream's site pool for want of a survey window. */
  cameraSitesDropped: number;
  audioSitesDropped: number;
  /** Deployments whose file dates fall outside their ODK survey window. */
  cameraDateAnomalies: DateWindowAnomaly[];
  audioDateAnomalies: DateWindowAnomaly[];
  /**
   * Recording-schedule subsampling applied to the audio stream to equalize
   * survey effort across 5-min and 10-min recorders. Null for the camera
   * stream (no duty cycle to normalize).
   */
  audioSubsample: AudioSubsampleReport | null;
  generatedAt: string;
}

export interface OccupancyReadinessOptions {
  binWidth?: number;
  confidenceThreshold?: number;
}

/**
 * Mutates each report's species rows in place, attaching common/Spanish names +
 * IUCN status from `biochoco_species` (joined by scientific name). Occupancy
 * stores bare binomials for both streams, so this resolves against the full
 * lookup table. Species not in the lookup keep null names — the table falls back
 * to the scientific string.
 */
async function enrichReadinessNames(reports: ReadinessReport[]): Promise<void> {
  const names = new Set<string>();
  for (const rep of reports) {
    for (const row of rep.species) names.add(row.species);
  }
  if (names.size === 0) return;

  const rows = await db
    .select({
      scientificName: species.scientificName,
      commonName: species.commonName,
      spanishName: species.spanishName,
      iucnStatus: species.iucnStatus,
    })
    .from(species)
    .where(inArray(species.scientificName, [...names]));
  const byName = new Map(rows.map((r) => [r.scientificName, r]));

  for (const rep of reports) {
    for (const row of rep.species) {
      const sp = byName.get(row.species);
      row.commonName = sp?.commonName ?? null;
      row.spanishName = sp?.spanishName ?? null;
      row.iucnStatus = sp?.iucnStatus ?? null;
    }
  }
}

/**
 * Compute the full readiness result for both streams. Throws on failure — the
 * caller (action or batch) wraps it. No auth check here.
 */
export async function computeReadinessResult(
  opts: OccupancyReadinessOptions = {},
): Promise<OccupancyReadinessResult> {
  const binWidth = opts.binWidth ?? DEFAULT_BIN_WIDTH_DAYS;
  const confidenceThreshold = opts.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;

  const cam = fetchOccupancyInputs("camera", {});
  const camera = computeReadiness(cam.sites, cam.detections, {
    stream: "camera",
    binWidth,
    detectionsDroppedNoDate: cam.detectionsDroppedNoDate,
  });

  const aud = fetchOccupancyInputs("audio", { confidenceThreshold });
  const audio = computeReadiness(aud.sites, aud.detections, {
    stream: "audio",
    binWidth,
    confidenceThreshold,
    detectionsDroppedNoDate: aud.detectionsDroppedNoDate,
  });

  await enrichReadinessNames([camera, audio]);

  return {
    camera,
    audio,
    cameraSitesDropped: cam.droppedSites,
    audioSitesDropped: aud.droppedSites,
    cameraDateAnomalies: cam.dateWindowAnomalies,
    audioDateAnomalies: aud.dateWindowAnomalies,
    audioSubsample: buildAudioSubsampleReport(aud.audioSubsample, aud.sites),
    generatedAt: new Date().toISOString(),
  };
}
