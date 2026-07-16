"use server";

import { db } from "@/db";
import {
  deployments,
  images,
  detections,
  identifications,
  species,
  audioFiles,
  audioDetections,
  audioIdentifications,
  cameraTrapProjects,
} from "@/db/schema";
import { and, eq, inArray, isNull, isNotNull, or, sql, ne } from "drizzle-orm";
import { requirePermission } from "@/lib/auth";
import type { ActionResult } from "@/lib/types";
import {
  loadSiteHabitatMap,
  resolveHabitatForDeployment,
  UNKNOWN_HABITAT_KEY,
} from "@/lib/habitat-lookup";
import { HABITAT_COLORS } from "@/app/biochoco/habitat/types";
import { getHabitatName } from "@/app/biochoco/overview/types";
import {
  getAcousticIndicesForProject,
  type AcousticIndicesData,
  type AcousticIndicesGroup,
} from "@/app/audio/actions";
import { fetchTemperatureDistributions } from "@/app/biochoco/ibutton/actions";
import type { DeploymentStatPoint } from "@/app/biochoco/ibutton/types";
import type { SiteAudioData, SiteAudioSpecies } from "./types";

const UNKNOWN_HABITAT_COLOR = "#94a3b8"; // slate-400 — matches box plot neutral
const UNKNOWN_HABITAT_LABEL = "Sin clasificar";

/** A species-richness rollup for one habitat bucket. */
export interface HabitatSpeciesRollup {
  habitatKey: string;
  habitatLabel: string;
  color: string;
  /** Deployments in this habitat whose verification work is complete. */
  verifiedDeploymentCount: number;
  /** All deployments tagged with this habitat (including unverified). */
  totalDeploymentCount: number;
  /** Distinct species observed across verified deployments. */
  speciesCount: number;
  /** Total verified detections summed across the habitat's deployments. */
  detectionCount: number;
  /** Top 5 species by detection count for the collapsible drill-down. */
  topSpecies: Array<{
    speciesName: string;
    spanishName: string | null;
    commonName: string | null;
    detectionCount: number;
  }>;
}

/** Bundle returned to the "Por hábitat" view. */
export interface HabitatDashboardData {
  cameraSpecies: HabitatSpeciesRollup[];
  audioSpecies: HabitatSpeciesRollup[];
  acousticIndices: AcousticIndicesData;
  temperature: { points: DeploymentStatPoint[] };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface DeploymentRow {
  id: number;
  name: string;
  siteName: string | null;
  status: string;
}

async function getBiochocoCameraTrapProjectId(): Promise<number | null> {
  const [row] = await db
    .select({ id: cameraTrapProjects.id })
    .from(cameraTrapProjects)
    .where(eq(cameraTrapProjects.name, "BioChoco"));
  return row?.id ?? null;
}

function buildLabel(habitatKey: string): string {
  return habitatKey === UNKNOWN_HABITAT_KEY
    ? UNKNOWN_HABITAT_LABEL
    : getHabitatName(habitatKey);
}

function colorForHabitat(habitatKey: string): string {
  return HABITAT_COLORS[habitatKey] ?? UNKNOWN_HABITAT_COLOR;
}

/**
 * Sort: classified habitats by label, unknown last. Keeps "Sin clasificar"
 * out of the way of the legend ordering.
 */
function sortRollups(rollups: HabitatSpeciesRollup[]): HabitatSpeciesRollup[] {
  return [...rollups].sort((a, b) => {
    if (a.habitatKey === UNKNOWN_HABITAT_KEY) return 1;
    if (b.habitatKey === UNKNOWN_HABITAT_KEY) return -1;
    return a.habitatLabel.localeCompare(b.habitatLabel);
  });
}

/**
 * Group BioChoco deployments into habitat buckets. Excludes deployments
 * marked `excluded_camera=true`. Returns a map habitatKey → deployment rows + a
 * lookup deploymentId → habitatKey for downstream joins.
 */
async function loadDeploymentsByHabitat(
  ctProjectId: number,
): Promise<{
  byHabitat: Map<string, DeploymentRow[]>;
  depToHabitat: Map<number, string>;
}> {
  const habitatMap = await loadSiteHabitatMap();

  const rows = await db
    .select({
      id: deployments.id,
      name: deployments.name,
      siteName: deployments.siteName,
      status: deployments.status,
    })
    .from(deployments)
    .where(
      and(
        eq(deployments.cameraTrapProjectId, ctProjectId),
        or(eq(deployments.excludedCamera, false), isNull(deployments.excludedCamera)),
      ),
    );

  const byHabitat = new Map<string, DeploymentRow[]>();
  const depToHabitat = new Map<number, string>();
  for (const r of rows) {
    const habitatKey = resolveHabitatForDeployment(
      { siteName: r.siteName, deploymentName: r.name },
      habitatMap,
    );
    depToHabitat.set(r.id, habitatKey);
    const list = byHabitat.get(habitatKey) ?? [];
    list.push(r);
    byHabitat.set(habitatKey, list);
  }
  return { byHabitat, depToHabitat };
}

// ---------------------------------------------------------------------------
// Camera trap aggregator
// ---------------------------------------------------------------------------

const CAMERA_VERIFIED_STATUSES = ["verified", "verified_empty"] as const;
const VERIFIED_ID_STATUSES = ["verified", "corrected"] as const;

export async function fetchCameraSpeciesByHabitat(): Promise<
  ActionResult<HabitatSpeciesRollup[]>
> {
  await requirePermission("biochoco", "viewer");
  try {
    const ctProjectId = await getBiochocoCameraTrapProjectId();
    if (!ctProjectId) return { success: true, data: [] };

    const { byHabitat, depToHabitat } = await loadDeploymentsByHabitat(
      ctProjectId,
    );
    if (byHabitat.size === 0) return { success: true, data: [] };

    // Deployments that count as "verified work done". This includes
    // verified_empty — the human reviewed the deployment and confirmed no
    // animals, so it's verification effort even though species count is 0.
    const verifiedDepIds: number[] = [];
    for (const list of byHabitat.values()) {
      for (const d of list) {
        if (
          (CAMERA_VERIFIED_STATUSES as readonly string[]).includes(d.status)
        ) {
          verifiedDepIds.push(d.id);
        }
      }
    }

    // Per-deployment × species rows. Aggregated by habitat in memory below.
    type SpeciesRow = {
      deploymentId: number;
      speciesName: string;
      spanishName: string | null;
      commonName: string | null;
      detectionCount: number;
    };
    let perDepSpecies: SpeciesRow[] = [];
    if (verifiedDepIds.length > 0) {
      perDepSpecies = await db
        .select({
          deploymentId: images.deploymentId,
          speciesName: sql<string>`coalesce(${identifications.correctedSpecies}, ${identifications.species})`,
          spanishName: species.spanishName,
          commonName: species.commonName,
          detectionCount: sql<number>`count(*)`,
        })
        .from(identifications)
        .innerJoin(detections, eq(identifications.detectionId, detections.id))
        .innerJoin(images, eq(detections.imageId, images.id))
        .leftJoin(
          species,
          sql`${species.scientificName} = coalesce(${identifications.correctedSpecies}, ${identifications.species})`,
        )
        .where(
          and(
            inArray(images.deploymentId, verifiedDepIds),
            inArray(identifications.verificationStatus, [
              ...VERIFIED_ID_STATUSES,
            ]),
          ),
        )
        .groupBy(
          images.deploymentId,
          sql`coalesce(${identifications.correctedSpecies}, ${identifications.species})`,
        );
    }

    const rollups = buildRollups(byHabitat, depToHabitat, perDepSpecies);
    return { success: true, data: rollups };
  } catch (err) {
    return {
      success: false,
      error:
        err instanceof Error
          ? err.message
          : "Error al cargar especies por hábitat",
    };
  }
}

// ---------------------------------------------------------------------------
// Audio (BirdNET) aggregator
// ---------------------------------------------------------------------------

export async function fetchAudioSpeciesByHabitat(): Promise<
  ActionResult<HabitatSpeciesRollup[]>
> {
  await requirePermission("biochoco", "viewer");
  try {
    const ctProjectId = await getBiochocoCameraTrapProjectId();
    if (!ctProjectId) return { success: true, data: [] };

    const { byHabitat, depToHabitat } = await loadDeploymentsByHabitat(
      ctProjectId,
    );
    if (byHabitat.size === 0) return { success: true, data: [] };

    // A deployment is "audio-verified" if at least one of its annotations has
    // been reviewed (status != "unverified"). Identifications with status
    // 'verified' or 'corrected' contribute to the species lists; 'rejected'
    // counts as verification effort but contributes no species.
    const audioReviewedRows = await db
      .selectDistinct({ deploymentId: audioFiles.deploymentId })
      .from(audioIdentifications)
      .innerJoin(
        audioDetections,
        eq(audioDetections.id, audioIdentifications.audioDetectionId),
      )
      .innerJoin(audioFiles, eq(audioFiles.id, audioDetections.audioFileId))
      .where(ne(audioIdentifications.verificationStatus, "unverified"));
    const verifiedDepIds = audioReviewedRows
      .map((r) => r.deploymentId)
      .filter((id) => byHabitat.has(depToHabitat.get(id) ?? ""));

    type SpeciesRow = {
      deploymentId: number;
      speciesName: string;
      spanishName: string | null;
      commonName: string | null;
      detectionCount: number;
    };
    let perDepSpecies: SpeciesRow[] = [];
    if (verifiedDepIds.length > 0) {
      perDepSpecies = await db
        .select({
          deploymentId: audioFiles.deploymentId,
          speciesName: sql<string>`coalesce(${audioIdentifications.correctedSpecies}, ${audioIdentifications.species})`,
          spanishName: species.spanishName,
          commonName: species.commonName,
          detectionCount: sql<number>`count(*)`,
        })
        .from(audioIdentifications)
        .innerJoin(
          audioDetections,
          eq(audioDetections.id, audioIdentifications.audioDetectionId),
        )
        .innerJoin(audioFiles, eq(audioFiles.id, audioDetections.audioFileId))
        .leftJoin(
          species,
          sql`${species.scientificName} = coalesce(${audioIdentifications.correctedSpecies}, ${audioIdentifications.species})`,
        )
        .where(
          and(
            inArray(audioFiles.deploymentId, verifiedDepIds),
            inArray(audioIdentifications.verificationStatus, [
              ...VERIFIED_ID_STATUSES,
            ]),
          ),
        )
        .groupBy(
          audioFiles.deploymentId,
          sql`coalesce(${audioIdentifications.correctedSpecies}, ${audioIdentifications.species})`,
        );
    }

    // For the verified-deployment denominator on the audio side, override the
    // deployment status with the set of reviewed deployments.
    const reviewedDepIdSet = new Set(verifiedDepIds);
    const audioByHabitat = new Map<string, DeploymentRow[]>();
    // Only include habitats that have *any* audio activity — drop habitats
    // with no audio files at all from the audio section.
    const audioDepIds = await getDeploymentsWithAudio(ctProjectId);
    for (const [habitatKey, deps] of byHabitat) {
      const filtered = deps.filter((d) => audioDepIds.has(d.id));
      if (filtered.length > 0) audioByHabitat.set(habitatKey, filtered);
    }

    const rollups = buildRollups(
      audioByHabitat,
      depToHabitat,
      perDepSpecies,
      (dep) => reviewedDepIdSet.has(dep.id),
    );
    return { success: true, data: rollups };
  } catch (err) {
    return {
      success: false,
      error:
        err instanceof Error
          ? err.message
          : "Error al cargar especies de audio por hábitat",
    };
  }
}

async function getDeploymentsWithAudio(
  ctProjectId: number,
): Promise<Set<number>> {
  const rows = await db
    .selectDistinct({ deploymentId: audioFiles.deploymentId })
    .from(audioFiles)
    .innerJoin(deployments, eq(deployments.id, audioFiles.deploymentId))
    .where(
      and(
        eq(deployments.cameraTrapProjectId, ctProjectId),
        isNotNull(audioFiles.deploymentId),
      ),
    );
  return new Set(rows.map((r) => r.deploymentId));
}

// ---------------------------------------------------------------------------
// Shared rollup builder
// ---------------------------------------------------------------------------

interface SpeciesRow {
  deploymentId: number;
  speciesName: string;
  spanishName: string | null;
  commonName: string | null;
  detectionCount: number;
}

function buildRollups(
  byHabitat: Map<string, DeploymentRow[]>,
  depToHabitat: Map<number, string>,
  perDepSpecies: SpeciesRow[],
  isVerified: (dep: DeploymentRow) => boolean = (d) =>
    (CAMERA_VERIFIED_STATUSES as readonly string[]).includes(d.status),
): HabitatSpeciesRollup[] {
  // Aggregate species rows per habitat.
  type HabitatAgg = {
    speciesNames: Map<
      string,
      {
        spanishName: string | null;
        commonName: string | null;
        detectionCount: number;
      }
    >;
    detectionCount: number;
  };
  const aggByHabitat = new Map<string, HabitatAgg>();
  for (const row of perDepSpecies) {
    const habitatKey = depToHabitat.get(row.deploymentId);
    if (!habitatKey) continue;
    if (!row.speciesName) continue;
    const agg = aggByHabitat.get(habitatKey) ?? {
      speciesNames: new Map(),
      detectionCount: 0,
    };
    const existing = agg.speciesNames.get(row.speciesName);
    if (existing) {
      existing.detectionCount += row.detectionCount;
    } else {
      agg.speciesNames.set(row.speciesName, {
        spanishName: row.spanishName,
        commonName: row.commonName,
        detectionCount: row.detectionCount,
      });
    }
    agg.detectionCount += row.detectionCount;
    aggByHabitat.set(habitatKey, agg);
  }

  const rollups: HabitatSpeciesRollup[] = [];
  for (const [habitatKey, deps] of byHabitat) {
    const verifiedCount = deps.filter(isVerified).length;
    const agg = aggByHabitat.get(habitatKey);
    const topSpecies = agg
      ? Array.from(agg.speciesNames.entries())
          .map(([speciesName, info]) => ({ speciesName, ...info }))
          .sort((a, b) => b.detectionCount - a.detectionCount)
          .slice(0, 5)
      : [];
    rollups.push({
      habitatKey,
      habitatLabel: buildLabel(habitatKey),
      color: colorForHabitat(habitatKey),
      verifiedDeploymentCount: verifiedCount,
      totalDeploymentCount: deps.length,
      speciesCount: agg ? agg.speciesNames.size : 0,
      detectionCount: agg ? agg.detectionCount : 0,
      topSpecies,
    });
  }
  return sortRollups(rollups);
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

/**
 * Aggregates all data for the "Por hábitat" tab in a single call. Runs the
 * four section fetchers in parallel; the shared `loadSiteHabitatMap` is
 * memoized via React.cache so they share one ODK round-trip.
 */
export async function fetchHabitatDashboardData(): Promise<
  ActionResult<HabitatDashboardData>
> {
  await requirePermission("biochoco", "viewer");
  try {
    const ctProjectId = await getBiochocoCameraTrapProjectId();
    if (!ctProjectId) {
      return {
        success: true,
        data: {
          cameraSpecies: [],
          audioSpecies: [],
          acousticIndices: { groups: [], totalDeployments: 0 },
          temperature: { points: [] },
        },
      };
    }

    const [cameraSpecies, audioSpecies, acousticIndicesResult, temperatureResult] =
      await Promise.all([
        fetchCameraSpeciesByHabitat(),
        fetchAudioSpeciesByHabitat(),
        getAcousticIndicesForProject(ctProjectId),
        fetchTemperatureDistributions(),
      ]);

    return {
      success: true,
      data: {
        cameraSpecies: cameraSpecies.success ? cameraSpecies.data : [],
        audioSpecies: audioSpecies.success ? audioSpecies.data : [],
        acousticIndices: acousticIndicesResult.success
          ? acousticIndicesResult.data
          : { groups: [], totalDeployments: 0 },
        temperature: temperatureResult.success
          ? temperatureResult.data
          : { points: [] },
      },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Error al cargar el panel",
    };
  }
}

// ---------------------------------------------------------------------------
// Per-site audio data (used by the site detail drill-down)
// ---------------------------------------------------------------------------

/**
 * Returns acoustic indices + verified BirdNET species for the supplied
 * deployment IDs. Used by /biochoco/resultados/[siteId] to render the audio
 * panels under Fauna. Public-share variant skips this entirely.
 */
export async function fetchSiteAudio(
  deploymentIds: number[],
): Promise<ActionResult<SiteAudioData>> {
  await requirePermission("biochoco", "viewer");
  try {
    if (deploymentIds.length === 0) {
      return {
        success: true,
        data: {
          hasAudio: false,
          indices: [],
          species: [],
          reviewedDeploymentCount: 0,
          totalAudioDeploymentCount: 0,
        },
      };
    }

    const ctProjectId = await getBiochocoCameraTrapProjectId();
    if (!ctProjectId) {
      return {
        success: true,
        data: {
          hasAudio: false,
          indices: [],
          species: [],
          reviewedDeploymentCount: 0,
          totalAudioDeploymentCount: 0,
        },
      };
    }

    const depIdSet = new Set(deploymentIds);

    // Deployments at this site that actually have audio files.
    const audioDepRows = await db
      .selectDistinct({ deploymentId: audioFiles.deploymentId })
      .from(audioFiles)
      .where(inArray(audioFiles.deploymentId, deploymentIds));
    const audioDepIds = audioDepRows.map((r) => r.deploymentId);

    if (audioDepIds.length === 0) {
      return {
        success: true,
        data: {
          hasAudio: false,
          indices: [],
          species: [],
          reviewedDeploymentCount: 0,
          totalAudioDeploymentCount: 0,
        },
      };
    }

    // Deployments where at least one annotation has been reviewed.
    const reviewedRows = await db
      .selectDistinct({ deploymentId: audioFiles.deploymentId })
      .from(audioIdentifications)
      .innerJoin(
        audioDetections,
        eq(audioDetections.id, audioIdentifications.audioDetectionId),
      )
      .innerJoin(audioFiles, eq(audioFiles.id, audioDetections.audioFileId))
      .where(
        and(
          inArray(audioFiles.deploymentId, audioDepIds),
          ne(audioIdentifications.verificationStatus, "unverified"),
        ),
      );
    const reviewedDeploymentCount = reviewedRows.length;

    // Verified species, aggregated.
    const speciesRows = await db
      .select({
        speciesName: sql<string>`coalesce(${audioIdentifications.correctedSpecies}, ${audioIdentifications.species})`,
        spanishName: species.spanishName,
        commonName: species.commonName,
        detectionCount: sql<number>`count(*)`,
        avgConfidence: sql<number>`round(avg(${audioIdentifications.confidence}), 3)`,
      })
      .from(audioIdentifications)
      .innerJoin(
        audioDetections,
        eq(audioDetections.id, audioIdentifications.audioDetectionId),
      )
      .innerJoin(audioFiles, eq(audioFiles.id, audioDetections.audioFileId))
      .leftJoin(
        species,
        sql`${species.scientificName} = coalesce(${audioIdentifications.correctedSpecies}, ${audioIdentifications.species})`,
      )
      .where(
        and(
          inArray(audioFiles.deploymentId, audioDepIds),
          inArray(audioIdentifications.verificationStatus, [
            ...VERIFIED_ID_STATUSES,
          ]),
        ),
      )
      .groupBy(
        sql`coalesce(${audioIdentifications.correctedSpecies}, ${audioIdentifications.species})`,
      )
      .orderBy(sql`count(*) DESC`);

    const audioSpecies: SiteAudioSpecies[] = speciesRows
      .filter((r) => Boolean(r.speciesName))
      .map((r) => ({
        speciesName: r.speciesName,
        spanishName: r.spanishName,
        commonName: r.commonName,
        detectionCount: r.detectionCount,
        avgConfidence: r.avgConfidence,
      }));

    // Acoustic indices: reuse the project-wide aggregator and filter to this
    // site's deployments. The result is small enough that re-grouping in
    // memory is fine; saves us a parallel query path.
    const projectIndices = await getAcousticIndicesForProject(ctProjectId);
    const siteIndices: AcousticIndicesGroup[] = projectIndices.success
      ? projectIndices.data.groups
          .map((g) => ({
            ...g,
            points: g.points.filter((p) => depIdSet.has(p.deploymentId)),
          }))
          .filter((g) => g.points.length > 0)
      : [];

    return {
      success: true,
      data: {
        hasAudio: true,
        indices: siteIndices,
        species: audioSpecies,
        reviewedDeploymentCount,
        totalAudioDeploymentCount: audioDepIds.length,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Error al cargar audio del sitio",
    };
  }
}

// ---------------------------------------------------------------------------
// Audio deployment count summary (used by the habitat-tab header badges)
// ---------------------------------------------------------------------------

/** Quick count of BioChoco deployments by audio status (total / reviewed). */
export async function fetchAudioDeploymentReviewSummary(): Promise<
  ActionResult<{ total: number; reviewed: number }>
> {
  await requirePermission("biochoco", "viewer");
  const ctProjectId = await getBiochocoCameraTrapProjectId();
  if (!ctProjectId) return { success: true, data: { total: 0, reviewed: 0 } };

  const audioDepIds = await getDeploymentsWithAudio(ctProjectId);
  const reviewed = await db
    .selectDistinct({ deploymentId: audioFiles.deploymentId })
    .from(audioIdentifications)
    .innerJoin(
      audioDetections,
      eq(audioDetections.id, audioIdentifications.audioDetectionId),
    )
    .innerJoin(audioFiles, eq(audioFiles.id, audioDetections.audioFileId))
    .innerJoin(deployments, eq(deployments.id, audioFiles.deploymentId))
    .where(
      and(
        eq(deployments.cameraTrapProjectId, ctProjectId),
        ne(audioIdentifications.verificationStatus, "unverified"),
      ),
    );

  return {
    success: true,
    data: {
      total: audioDepIds.size,
      reviewed: reviewed.length,
    },
  };
}

