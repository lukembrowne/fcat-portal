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

import { sql, and, inArray, type SQL } from "drizzle-orm";
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
