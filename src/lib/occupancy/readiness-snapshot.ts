import "server-only";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { log } from "@/lib/log";
import { occupancyReadinessSnapshots } from "@/db/schema";
import { biochocoDeploymentPool, occupancySiteGate } from "./fetch";
import { DEFAULT_BIN_WIDTH_DAYS } from "./occasions";
import { DEFAULT_CONFIDENCE_THRESHOLD } from "@/lib/audio-confidence";
import type { OccupancyReadinessResult } from "./readiness-compute";

/**
 * Snapshot store for the /ocupacion data-readiness report.
 *
 * The readiness report is expensive to compute — it materializes every image,
 * audio file, and verified detection in the BioChoco pool and date-parses each
 * row, so the cost grows with the dataset. Instead of paying it on every page
 * load, the report is computed only on an explicit refresh (or the weekly batch)
 * and stored here as a JSON blob. The page reads the latest blob and renders
 * instantly.
 *
 * A cheap data `fingerprint` (COUNT/MAX aggregates over the same BioChoco pool)
 * is captured with each snapshot; the page recomputes it on load and compares to
 * flag "hay datos nuevos" without the full materialization. See the plan for what
 * the fingerprint does (additions, pool membership, verification counts) and does
 * NOT (in-place edits — valid_* window trims, re-corrections, exclusion
 * round-trips), which stay masked until the next refresh/batch.
 */

export interface ReadinessSnapshotConfig {
  binWidth: number;
  confidenceThreshold: number;
}

export interface LoadedReadinessSnapshot {
  result: OccupancyReadinessResult;
  /** The stored fingerprint column — NOT a member of `result`. */
  fingerprint: string;
  generatedAt: Date;
  generatedBy: string | null;
}

function resolveConfig(opts: Partial<ReadinessSnapshotConfig> = {}): ReadinessSnapshotConfig {
  return {
    binWidth: opts.binWidth ?? DEFAULT_BIN_WIDTH_DAYS,
    confidenceThreshold: opts.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD,
  };
}

/** One aggregate probe → `count:max` (both cheap index scans, no JS/date work). */
function countMax(query: ReturnType<typeof sql>): string {
  const row = db.get(query) as { n: number; m: number } | undefined;
  return `${row?.n ?? 0}:${row?.m ?? 0}`;
}

function count(query: ReturnType<typeof sql>): string {
  const row = db.get(query) as { n: number } | undefined;
  return `${row?.n ?? 0}`;
}

/**
 * Cheap data fingerprint for the BioChoco occupancy pool. Deterministic (no
 * timestamps, stable ordering) so an unchanged dataset yields the identical
 * string. Each probe detects a specific kind of change:
 *   - camera/audio pool size + max id → new sites, status changes, exclusion
 *     toggles (a toggled deployment enters/leaves the filtered count)
 *   - image / audio-file count + max id → new files that can extend windows
 *   - verified/corrected detection counts → verification progress
 * Additions and pool-membership changes move these; pure in-place edits do not.
 */
export function computeReadinessFingerprint(
  opts: Partial<ReadinessSnapshotConfig> = {},
): string {
  const { binWidth, confidenceThreshold } = resolveConfig(opts);

  const cameraPool = countMax(sql`
    SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS m
    FROM biochoco_deployments
    WHERE ${occupancySiteGate("camera")} AND excluded_camera = 0
      AND ct_project_id = (SELECT id FROM ct_projects WHERE name = 'BioChoco')
  `);
  // Audio pool tracks BirdNET completion (occupancySiteGate("audio")), so a
  // deployment finishing its BirdNET run moves this probe → "hay datos nuevos"
  // fires even though the camera `status` gate would not have changed.
  const audioPool = countMax(sql`
    SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS m
    FROM biochoco_deployments
    WHERE ${occupancySiteGate("audio")} AND excluded_audio = 0
      AND ct_project_id = (SELECT id FROM ct_projects WHERE name = 'BioChoco')
  `);
  const images = countMax(sql`
    SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS m
    FROM biochoco_images
    WHERE deployment_id IN (${biochocoDeploymentPool()})
  `);
  const audioFiles = countMax(sql`
    SELECT COUNT(*) AS n, COALESCE(MAX(id), 0) AS m
    FROM audio_files
    WHERE deployment_id IN (${biochocoDeploymentPool()})
  `);
  const cameraDetections = count(sql`
    SELECT COUNT(*) AS n
    FROM biochoco_identifications id
    JOIN biochoco_detections d ON d.id = id.detection_id
    JOIN biochoco_images img ON img.id = d.image_id
    WHERE id.verification_status IN ('verified', 'corrected')
      AND img.deployment_id IN (${biochocoDeploymentPool()})
  `);
  const audioDetections = count(sql`
    SELECT COUNT(*) AS n
    FROM audio_identifications ai
    JOIN audio_detections ad ON ad.id = ai.audio_detection_id
    JOIN audio_files af ON af.id = ad.audio_file_id
    WHERE af.deployment_id IN (${biochocoDeploymentPool()})
      AND (ai.confidence >= ${confidenceThreshold}
           OR ai.verification_status IN ('verified', 'corrected'))
  `);

  return [
    `bw=${binWidth}`,
    `ct=${confidenceThreshold}`,
    `camPool=${cameraPool}`,
    `audPool=${audioPool}`,
    `img=${images}`,
    `aud=${audioFiles}`,
    `camDet=${cameraDetections}`,
    `audDet=${audioDetections}`,
  ].join("|");
}

/** Latest snapshot for a config, or null (cold start). Defensive on parse. */
export function loadLatestReadinessSnapshot(
  opts: Partial<ReadinessSnapshotConfig> = {},
): LoadedReadinessSnapshot | null {
  const { binWidth, confidenceThreshold } = resolveConfig(opts);
  const [row] = db
    .select()
    .from(occupancyReadinessSnapshots)
    .where(
      and(
        eq(occupancyReadinessSnapshots.binWidthDays, binWidth),
        eq(occupancyReadinessSnapshots.audioConfidenceThreshold, confidenceThreshold),
      ),
    )
    .orderBy(desc(occupancyReadinessSnapshots.generatedAt), desc(occupancyReadinessSnapshots.id))
    .limit(1)
    .all();
  if (!row) return null;
  try {
    const result = JSON.parse(row.resultJson) as OccupancyReadinessResult;
    return {
      result,
      fingerprint: row.fingerprint,
      generatedAt: row.generatedAt,
      generatedBy: row.generatedBy,
    };
  } catch (error) {
    // A malformed/truncated blob must never break the page — treat as cold start.
    log.error({ err: error, snapshotId: row.id }, "occupancy readiness snapshot parse failed");
    return null;
  }
}

/** Persist a fresh snapshot. Always inserts a new row (refresh history). */
export function saveReadinessSnapshot(args: {
  result: OccupancyReadinessResult;
  fingerprint: string;
  generatedBy?: string | null;
  opts?: Partial<ReadinessSnapshotConfig>;
}): void {
  const { binWidth, confidenceThreshold } = resolveConfig(args.opts);
  db.insert(occupancyReadinessSnapshots)
    .values({
      binWidthDays: binWidth,
      audioConfidenceThreshold: confidenceThreshold,
      resultJson: JSON.stringify(args.result),
      fingerprint: args.fingerprint,
      generatedBy: args.generatedBy ?? null,
      generatedAt: new Date(),
    })
    .run();
}
