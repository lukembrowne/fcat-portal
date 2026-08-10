/**
 * Effective-species predicates for camera-trap and audio identifications.
 *
 * A detection's "effective species" is what the system currently treats it as,
 * computed from its latest identification row:
 *
 *   verification_status = 'rejected'   → not a detection of any species (skip)
 *   verification_status = 'corrected'  → effective = corrected_species
 *   otherwise                          → effective = species
 *
 * Using a CASE expression in WHERE / GROUP BY defeats SQLite's ability to use
 * indexes on (species) or (corrected_species). The matcher below splits the two
 * paths into an OR of two sargable predicates so each branch can hit a partial
 * index. Aggregation across both effective values is done as two index-eligible
 * SELECTs unioned in JS — see callers.
 *
 * Lives next to the schema deliberately: when the verification_status enum
 * changes, this helper must change in lockstep.
 */

import { sql, and, eq, inArray, type SQL } from "drizzle-orm";
import { db } from "./index";
import {
  identifications,
  audioIdentifications,
  detections,
  images,
  audioDetections,
  audioFiles,
  deployments,
} from "./schema";

type IdentificationTable = typeof identifications | typeof audioIdentifications;

/**
 * Drizzle SQL fragment: this identification row contributes to the given
 * effective species name. Excludes rejected rows. Pass the Drizzle table
 * object (not a string literal) so renames are caught by TypeScript.
 *
 *   .where(and(effectiveSpeciesMatches(identifications, name), ...))
 */
export function effectiveSpeciesMatches(
  table: IdentificationTable,
  scientificName: string
): SQL {
  return sql`(
    (${table.verificationStatus} IN ('unverified', 'verified')
      AND ${table.species} = ${scientificName})
    OR
    (${table.verificationStatus} = 'corrected'
      AND ${table.correctedSpecies} = ${scientificName})
  )`;
}

/**
 * Predicates that pick rows where the effective species comes from the active
 * (non-corrected, non-rejected) branch. Combined with a `species = ?` filter,
 * this lets the planner hit a partial index on `species`.
 */
export function activeIdentification(table: IdentificationTable): SQL {
  return sql`${table.verificationStatus} IN ('unverified', 'verified')`;
}

/**
 * Predicates that pick rows where the effective species comes from a human
 * correction. Combined with a `corrected_species = ?` filter, this lets the
 * planner hit a partial index on `corrected_species`.
 */
export function correctedIdentification(table: IdentificationTable): SQL {
  return sql`${table.verificationStatus} = 'corrected'`;
}

// ---------------------------------------------------------------------------
// Aggregation across both branches
// ---------------------------------------------------------------------------

/** Per-species aggregate emitted by aggregateBySpecies. */
export interface SpeciesAggregate {
  scientificName: string;
  detectionCount: number;
  siteCount: number;
  lastSeen: number | null; // unix seconds (max of MAX(...) over each branch)
  projectIds: number[]; // distinct ct_project_ids seen
}

/**
 * Aggregate per-effective-species counts for the camera-trap species index.
 *
 * Runs TWO index-eligible queries (active branch + corrected branch) and
 * merges them in JS. Each branch joins identifications → detections → images
 * → deployments and applies the deployment-scope WHERE clauses passed in.
 *
 * The caller is responsible for joining `species` once for display names.
 */
export async function aggregateCameraTrapBySpecies(
  ctProjects: number[] | "all"
): Promise<Map<string, SpeciesAggregate>> {
  const projectWhere =
    ctProjects === "all"
      ? undefined
      : ctProjects.length === 0
        ? inArray(deployments.cameraTrapProjectId, [-1])
        : inArray(deployments.cameraTrapProjectId, ctProjects);

  // Both branches group by (effective_species, deployment_id). We merge in JS
  // so distinct site/project sets are computed across active + corrected.
  const activeRows = await db
    .select({
      name: identifications.species,
      deploymentId: images.deploymentId,
      projectId: deployments.cameraTrapProjectId,
      count: sql<number>`COUNT(*)`,
      lastSeen: sql<number | null>`MAX(strftime('%s', ${images.exifTimestamp}))`,
    })
    .from(identifications)
    .innerJoin(detections, sql`${detections.id} = ${identifications.detectionId}`)
    .innerJoin(images, sql`${images.id} = ${detections.imageId}`)
    .innerJoin(deployments, sql`${deployments.id} = ${images.deploymentId}`)
    .where(and(activeIdentification(identifications), projectWhere))
    .groupBy(identifications.species, images.deploymentId);

  const correctedRows = await db
    .select({
      name: identifications.correctedSpecies,
      deploymentId: images.deploymentId,
      projectId: deployments.cameraTrapProjectId,
      count: sql<number>`COUNT(*)`,
      lastSeen: sql<number | null>`MAX(strftime('%s', ${images.exifTimestamp}))`,
    })
    .from(identifications)
    .innerJoin(detections, sql`${detections.id} = ${identifications.detectionId}`)
    .innerJoin(images, sql`${images.id} = ${detections.imageId}`)
    .innerJoin(deployments, sql`${deployments.id} = ${images.deploymentId}`)
    .where(and(correctedIdentification(identifications), projectWhere))
    .groupBy(identifications.correctedSpecies, images.deploymentId);

  type Pair = {
    name: string | null;
    deploymentId: number;
    projectId: number | null;
    count: number;
    lastSeen: number | null;
  };

  const sites = new Map<string, Set<number>>();
  const projects = new Map<string, Set<number>>();
  const out = new Map<string, SpeciesAggregate>();

  for (const r of [...activeRows, ...correctedRows] as Pair[]) {
    if (!r.name) continue;
    const existing = out.get(r.name);
    const ts = r.lastSeen ?? null;
    if (existing) {
      existing.detectionCount += Number(r.count);
      if (ts != null && (existing.lastSeen == null || ts > existing.lastSeen)) {
        existing.lastSeen = ts;
      }
    } else {
      out.set(r.name, {
        scientificName: r.name,
        detectionCount: Number(r.count),
        siteCount: 0,
        lastSeen: ts,
        projectIds: [],
      });
    }
    if (!sites.has(r.name)) sites.set(r.name, new Set());
    sites.get(r.name)!.add(r.deploymentId);
    if (r.projectId != null) {
      if (!projects.has(r.name)) projects.set(r.name, new Set());
      projects.get(r.name)!.add(r.projectId);
    }
  }

  for (const [name, agg] of out) {
    agg.siteCount = sites.get(name)?.size ?? 0;
    agg.projectIds = [...(projects.get(name) ?? [])].sort((a, b) => a - b);
  }
  return out;
}

/**
 * Per-deployment counts for a single species (camera-trap).
 *
 * Two index-eligible queries unioned in JS. Returns one row per deployment
 * with detection count and last-seen time.
 */
export interface SiteAggregate {
  deploymentId: number;
  deploymentName: string;
  latitude: number | null;
  longitude: number | null;
  cameraTrapProjectId: number | null;
  detectionCount: number;
  lastSeen: number | null;
}

export async function aggregateCameraTrapSpeciesSites(
  scientificName: string,
  ctProjects: number[] | "all"
): Promise<SiteAggregate[]> {
  const projectWhere =
    ctProjects === "all"
      ? undefined
      : ctProjects.length === 0
        ? inArray(deployments.cameraTrapProjectId, [-1])
        : inArray(deployments.cameraTrapProjectId, ctProjects);

  const baseColumns = {
    deploymentId: deployments.id,
    deploymentName: deployments.name,
    latitude: deployments.latitude,
    longitude: deployments.longitude,
    cameraTrapProjectId: deployments.cameraTrapProjectId,
    count: sql<number>`COUNT(*)`,
    lastSeen: sql<number | null>`MAX(strftime('%s', ${images.exifTimestamp}))`,
  };

  const activeRows = await db
    .select(baseColumns)
    .from(identifications)
    .innerJoin(detections, sql`${detections.id} = ${identifications.detectionId}`)
    .innerJoin(images, sql`${images.id} = ${detections.imageId}`)
    .innerJoin(deployments, sql`${deployments.id} = ${images.deploymentId}`)
    .where(
      and(
        sql`${identifications.verificationStatus} IN ('unverified','verified')`,
        sql`${identifications.species} = ${scientificName}`,
        projectWhere
      )
    )
    .groupBy(deployments.id);

  const correctedRows = await db
    .select(baseColumns)
    .from(identifications)
    .innerJoin(detections, sql`${detections.id} = ${identifications.detectionId}`)
    .innerJoin(images, sql`${images.id} = ${detections.imageId}`)
    .innerJoin(deployments, sql`${deployments.id} = ${images.deploymentId}`)
    .where(
      and(
        sql`${identifications.verificationStatus} = 'corrected'`,
        sql`${identifications.correctedSpecies} = ${scientificName}`,
        projectWhere
      )
    )
    .groupBy(deployments.id);

  const merged = new Map<number, SiteAggregate>();
  for (const r of [...activeRows, ...correctedRows]) {
    const existing = merged.get(r.deploymentId);
    if (existing) {
      existing.detectionCount += Number(r.count);
      if (r.lastSeen != null && (existing.lastSeen == null || r.lastSeen > existing.lastSeen)) {
        existing.lastSeen = r.lastSeen;
      }
    } else {
      merged.set(r.deploymentId, {
        deploymentId: r.deploymentId,
        deploymentName: r.deploymentName,
        latitude: r.latitude,
        longitude: r.longitude,
        cameraTrapProjectId: r.cameraTrapProjectId,
        detectionCount: Number(r.count),
        lastSeen: r.lastSeen,
      });
    }
  }
  return [...merged.values()];
}

// Re-export audio table refs so a future audio aggregator can mirror this file.
export { audioDetections, audioFiles };

// ---------------------------------------------------------------------------
// Audio aggregation
// ---------------------------------------------------------------------------

import { applySpeciesConfidenceFilter } from "@/lib/audio-confidence";

export interface AudioSiteAggregate {
  deploymentId: number;
  deploymentName: string;
  latitude: number | null;
  longitude: number | null;
  cameraTrapProjectId: number | null;
  detectionCount: number;
  lastSeen: number | null;
}

/**
 * Audio counterpart to aggregateCameraTrapBySpecies. Two index-eligible
 * queries grouped by (effective_species, deployment_id), merged in JS.
 * The audio_files.modified_at column stands in for "last detection date"
 * since audio_files has no recording_start column.
 */
/** Default: no per-species thresholds, i.e. the global value everywhere. */
const EMPTY_SPECIES_THRESHOLDS: ReadonlyMap<string, number> = new Map();

export async function aggregateAudioBySpecies(
  ctProjects: number[] | "all",
  threshold: number,
  speciesThresholds: ReadonlyMap<string, number> = EMPTY_SPECIES_THRESHOLDS
): Promise<Map<string, SpeciesAggregate>> {
  const projectWhere =
    ctProjects === "all"
      ? undefined
      : ctProjects.length === 0
        ? inArray(deployments.cameraTrapProjectId, [-1])
        : inArray(deployments.cameraTrapProjectId, ctProjects);

  const conf = applySpeciesConfidenceFilter(threshold, speciesThresholds);

  const activeRows = await db
    .select({
      name: audioIdentifications.species,
      deploymentId: audioFiles.deploymentId,
      projectId: deployments.cameraTrapProjectId,
      count: sql<number>`COUNT(*)`,
      lastSeen: sql<number | null>`MAX(unixepoch(${audioFiles.modifiedAt}))`,
    })
    .from(audioIdentifications)
    .innerJoin(
      audioDetections,
      sql`${audioDetections.id} = ${audioIdentifications.audioDetectionId}`
    )
    .innerJoin(audioFiles, sql`${audioFiles.id} = ${audioDetections.audioFileId}`)
    .innerJoin(
      deployments,
      sql`${deployments.id} = ${audioFiles.deploymentId}`
    )
    .where(and(activeIdentification(audioIdentifications), conf, projectWhere))
    .groupBy(audioIdentifications.species, audioFiles.deploymentId);

  const correctedRows = await db
    .select({
      name: audioIdentifications.correctedSpecies,
      deploymentId: audioFiles.deploymentId,
      projectId: deployments.cameraTrapProjectId,
      count: sql<number>`COUNT(*)`,
      lastSeen: sql<number | null>`MAX(unixepoch(${audioFiles.modifiedAt}))`,
    })
    .from(audioIdentifications)
    .innerJoin(
      audioDetections,
      sql`${audioDetections.id} = ${audioIdentifications.audioDetectionId}`
    )
    .innerJoin(audioFiles, sql`${audioFiles.id} = ${audioDetections.audioFileId}`)
    .innerJoin(
      deployments,
      sql`${deployments.id} = ${audioFiles.deploymentId}`
    )
    .where(
      and(correctedIdentification(audioIdentifications), conf, projectWhere)
    )
    .groupBy(audioIdentifications.correctedSpecies, audioFiles.deploymentId);

  return mergeBranchRows([...activeRows, ...correctedRows]);
}

/** Per-deployment counts for a single audio species. */
export async function aggregateAudioSpeciesSites(
  scientificName: string,
  ctProjects: number[] | "all",
  threshold: number,
  statuses: readonly ("unverified" | "verified" | "corrected" | "rejected")[],
  speciesThresholds: ReadonlyMap<string, number> = EMPTY_SPECIES_THRESHOLDS
): Promise<AudioSiteAggregate[]> {
  const projectWhere =
    ctProjects === "all"
      ? undefined
      : ctProjects.length === 0
        ? inArray(deployments.cameraTrapProjectId, [-1])
        : inArray(deployments.cameraTrapProjectId, ctProjects);

  const statusSet = new Set(statuses);
  const acceptsActive =
    statusSet.has("verified") || statusSet.has("unverified");
  const acceptsCorrected = statusSet.has("corrected");
  const conf = applySpeciesConfidenceFilter(threshold, speciesThresholds);

  const merged = new Map<number, AudioSiteAggregate>();

  const cols = {
    deploymentId: deployments.id,
    deploymentName: deployments.name,
    latitude: deployments.latitude,
    longitude: deployments.longitude,
    cameraTrapProjectId: deployments.cameraTrapProjectId,
    count: sql<number>`COUNT(*)`,
    lastSeen: sql<number | null>`MAX(unixepoch(${audioFiles.modifiedAt}))`,
  };

  if (acceptsActive) {
    const activeStatuses = [
      ...(statusSet.has("verified") ? (["verified"] as const) : []),
      ...(statusSet.has("unverified") ? (["unverified"] as const) : []),
    ];
    const rows = await db
      .select(cols)
      .from(audioIdentifications)
      .innerJoin(
        audioDetections,
        sql`${audioDetections.id} = ${audioIdentifications.audioDetectionId}`
      )
      .innerJoin(
        audioFiles,
        sql`${audioFiles.id} = ${audioDetections.audioFileId}`
      )
      .innerJoin(
        deployments,
        sql`${deployments.id} = ${audioFiles.deploymentId}`
      )
      .where(
        and(
          inArray(audioIdentifications.verificationStatus, [...activeStatuses]),
          sql`${audioIdentifications.species} = ${scientificName}`,
          conf,
          projectWhere
        )
      )
      .groupBy(deployments.id);
    for (const r of rows) mergeAudio(merged, r);
  }

  if (acceptsCorrected) {
    const rows = await db
      .select(cols)
      .from(audioIdentifications)
      .innerJoin(
        audioDetections,
        sql`${audioDetections.id} = ${audioIdentifications.audioDetectionId}`
      )
      .innerJoin(
        audioFiles,
        sql`${audioFiles.id} = ${audioDetections.audioFileId}`
      )
      .innerJoin(
        deployments,
        sql`${deployments.id} = ${audioFiles.deploymentId}`
      )
      .where(
        and(
          sql`${audioIdentifications.verificationStatus} = 'corrected'`,
          sql`${audioIdentifications.correctedSpecies} = ${scientificName}`,
          conf,
          projectWhere
        )
      )
      .groupBy(deployments.id);
    for (const r of rows) mergeAudio(merged, r);
  }

  return [...merged.values()];
}

function mergeAudio(
  out: Map<number, AudioSiteAggregate>,
  r: {
    deploymentId: number;
    deploymentName: string;
    latitude: number | null;
    longitude: number | null;
    cameraTrapProjectId: number | null;
    count: number;
    lastSeen: number | null;
  }
) {
  const existing = out.get(r.deploymentId);
  if (existing) {
    existing.detectionCount += Number(r.count);
    if (
      r.lastSeen != null &&
      (existing.lastSeen == null || r.lastSeen > existing.lastSeen)
    ) {
      existing.lastSeen = r.lastSeen;
    }
  } else {
    out.set(r.deploymentId, {
      deploymentId: r.deploymentId,
      deploymentName: r.deploymentName,
      latitude: r.latitude,
      longitude: r.longitude,
      cameraTrapProjectId: r.cameraTrapProjectId,
      detectionCount: Number(r.count),
      lastSeen: r.lastSeen,
    });
  }
}

function mergeBranchRows(
  rows: Array<{
    name: string | null;
    deploymentId: number;
    projectId: number | null;
    count: number;
    lastSeen: number | null;
  }>
): Map<string, SpeciesAggregate> {
  const sites = new Map<string, Set<number>>();
  const projects = new Map<string, Set<number>>();
  const out = new Map<string, SpeciesAggregate>();

  for (const r of rows) {
    if (!r.name) continue;
    const existing = out.get(r.name);
    if (existing) {
      existing.detectionCount += Number(r.count);
      if (
        r.lastSeen != null &&
        (existing.lastSeen == null || r.lastSeen > existing.lastSeen)
      ) {
        existing.lastSeen = r.lastSeen;
      }
    } else {
      out.set(r.name, {
        scientificName: r.name,
        detectionCount: Number(r.count),
        siteCount: 0,
        lastSeen: r.lastSeen,
        projectIds: [],
      });
    }
    if (!sites.has(r.name)) sites.set(r.name, new Set());
    sites.get(r.name)!.add(r.deploymentId);
    if (r.projectId != null) {
      if (!projects.has(r.name)) projects.set(r.name, new Set());
      projects.get(r.name)!.add(r.projectId);
    }
  }

  for (const [name, agg] of out) {
    agg.siteCount = sites.get(name)?.size ?? 0;
    agg.projectIds = [...(projects.get(name) ?? [])].sort((a, b) => a - b);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-deployment species roster
// ---------------------------------------------------------------------------

/** Per-species aggregate for a single audio deployment's species table. */
export interface DeploymentSpeciesAggregate {
  scientificName: string;
  detectionCount: number;
  /** Weighted mean of non-null BirdNET confidences; null when all rows are
   *  manual annotations (confidence IS NULL). */
  avgConfidence: number | null;
}

/** Raw per-branch row from the two effective-species queries below. */
export interface DeploymentSpeciesBranchRow {
  name: string | null;
  count: number;
  sumConf: number | null;
  confCount: number;
}

/**
 * Merge the active + corrected branch rows into one effective-species roster.
 *
 * Pure function (no DB) so the count/confidence math is unit-testable without a
 * database harness. Rows with a null effective name are dropped. `avgConfidence`
 * is the count-weighted mean of non-null confidences; species whose rows are all
 * null-confidence (manual annotations) yield `null`, not `0`.
 */
export function mergeDeploymentSpeciesRows(
  rows: DeploymentSpeciesBranchRow[]
): DeploymentSpeciesAggregate[] {
  const acc = new Map<
    string,
    { detectionCount: number; sumConf: number; confCount: number }
  >();
  for (const r of rows) {
    if (!r.name) continue;
    const e = acc.get(r.name) ?? {
      detectionCount: 0,
      sumConf: 0,
      confCount: 0,
    };
    e.detectionCount += Number(r.count);
    e.sumConf += Number(r.sumConf ?? 0);
    e.confCount += Number(r.confCount ?? 0);
    acc.set(r.name, e);
  }
  return [...acc.entries()].map(([scientificName, e]) => ({
    scientificName,
    detectionCount: e.detectionCount,
    avgConfidence: e.confCount > 0 ? e.sumConf / e.confCount : null,
  }));
}

/**
 * Per-species detection counts + average confidence for ONE audio deployment at
 * a given confidence threshold, using effective-species semantics.
 *
 * Mirrors `aggregateAudioBySpecies` but scoped to a single deployment and grouped
 * by species only. Two index-eligible queries (active branch on `species`,
 * corrected branch on `corrected_species`), each gated by the read-time
 * confidence filter, merged in JS. Caller joins `species` for display names.
 */
export async function aggregateAudioSpeciesForDeployment(
  deploymentId: number,
  threshold: number,
  speciesThresholds: ReadonlyMap<string, number> = EMPTY_SPECIES_THRESHOLDS
): Promise<DeploymentSpeciesAggregate[]> {
  const conf = applySpeciesConfidenceFilter(threshold, speciesThresholds);
  const confCols = {
    sumConf: sql<number | null>`SUM(${audioIdentifications.confidence})`,
    confCount: sql<number>`SUM(CASE WHEN ${audioIdentifications.confidence} IS NOT NULL THEN 1 ELSE 0 END)`,
  };

  const activeRows = await db
    .select({
      name: audioIdentifications.species,
      count: sql<number>`COUNT(*)`,
      ...confCols,
    })
    .from(audioIdentifications)
    .innerJoin(
      audioDetections,
      sql`${audioDetections.id} = ${audioIdentifications.audioDetectionId}`
    )
    .innerJoin(audioFiles, sql`${audioFiles.id} = ${audioDetections.audioFileId}`)
    .where(
      and(
        eq(audioFiles.deploymentId, deploymentId),
        activeIdentification(audioIdentifications),
        conf
      )
    )
    .groupBy(audioIdentifications.species);

  const correctedRows = await db
    .select({
      name: audioIdentifications.correctedSpecies,
      count: sql<number>`COUNT(*)`,
      ...confCols,
    })
    .from(audioIdentifications)
    .innerJoin(
      audioDetections,
      sql`${audioDetections.id} = ${audioIdentifications.audioDetectionId}`
    )
    .innerJoin(audioFiles, sql`${audioFiles.id} = ${audioDetections.audioFileId}`)
    .where(
      and(
        eq(audioFiles.deploymentId, deploymentId),
        correctedIdentification(audioIdentifications),
        conf
      )
    )
    .groupBy(audioIdentifications.correctedSpecies);

  return mergeDeploymentSpeciesRows([...activeRows, ...correctedRows]);
}
