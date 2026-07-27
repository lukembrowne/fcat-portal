"use server";

import { cache } from "react";
import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import {
  deployments,
  images,
  detections,
  identifications,
  species,
  ibuttonUploads,
  ibuttonReadings,
  cameraTrapProjects,
  siteShareTokens,
  audioFiles,
  processingJobs,
} from "@/db/schema";
import { recordEvent } from "@/lib/system-events";
import { eq, and, sql, inArray, isNull, isNotNull, or, desc } from "drizzle-orm";
import { fetchEntities, fetchSubmissions } from "@/lib/odk-client";
import {
  BIOCHOCO_PROJECT_ID,
  BIOCHOCO_DATASET_SITES,
  BIOCHOCO_FORM_HABITAT,
} from "@/lib/odk-constants";
import type { OdkSiteEntity } from "@/lib/odk-types";
import type { ActionResult } from "@/lib/types";
import { log } from "@/lib/log";
import type { SiteInfo } from "../overview/types";
import {
  toPublicSiteInfo,
  type PublicSiteInfo,
} from "@/lib/landowner/public-site-info";
import {
  parsePageConfig,
  serializePageConfig,
  defaultConfigFromLegacy,
  enforceFeaturedPhotosSingleton,
  validateFeaturedPhotoIds,
  type PageConfig,
} from "@/lib/landowner/page-config";
import { PROJECT_CONTEXT_BLURB } from "@/lib/landowner/copy";
import {
  resolveSpeciesGallery,
  type GalleryCandidate,
  type GalleryMode,
} from "@/lib/landowner/species-gallery";
import type { HabitatAssessment } from "../habitat/types";
import type {
  ResultadosData,
  SiteWithReadiness,
  SiteReadiness,
  SiteDetail,
  SiteSpecies,
  DeploymentTemperature,
} from "./types";
import { isValidShareToken } from "@/lib/public-tokens";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract site_id from deployment name, e.g., "SEC-006_V1" → "SEC-006". */
function extractSiteId(deploymentName: string): string | null {
  const match = deploymentName.match(/^(.+?)_V\d+$/i);
  return match ? match[1] : null;
}

/** Transform ODK site entities to SiteInfo. */
function transformSites(rawSites: OdkSiteEntity[]): SiteInfo[] {
  return rawSites.map((s) => ({
    uuid: s.uuid,
    siteId: s.site_id ?? s.label ?? "",
    siteName: s.label ?? s.site_name ?? "",
    habitatType: s.habitat_type ?? "",
    lat: s.latitude ? parseFloat(String(s.latitude)) : null,
    lng: s.longitude ? parseFloat(String(s.longitude)) : null,
    habitatAssessed: (s.habitat_assessed as string) ?? "",
    landownerName: s.landowner_name ?? "",
    landownerPhone: s.landowner_phone ?? "",
    notes: s.notes ?? "",
  }));
}

/** Get the BioChoco ct_project ID. */
async function getBiochocoProjectId(): Promise<number | null> {
  const [row] = await db
    .select({ id: cameraTrapProjects.id })
    .from(cameraTrapProjects)
    .where(eq(cameraTrapProjects.name, "BioChoco"));
  return row?.id ?? null;
}

/** Map a deployment to a site ID using siteName or name pattern. */
function deploymentToSiteId(
  dep: { siteName: string | null; name: string },
  siteIdSet: Set<string>
): string | null {
  // Priority 1: siteName field matches a known site
  if (dep.siteName && siteIdSet.has(dep.siteName)) return dep.siteName;
  // Priority 2: extract from name pattern
  const extracted = extractSiteId(dep.name);
  if (extracted && siteIdSet.has(extracted)) return extracted;
  // Priority 3: siteName even if not in ODK sites set
  if (dep.siteName) return dep.siteName;
  return extracted;
}

// ---------------------------------------------------------------------------
// Landing page data
// ---------------------------------------------------------------------------

export async function fetchResultadosData(): Promise<ActionResult<ResultadosData>> {
  try {
    await requirePermission("biochoco", "viewer");

    const ctProjectId = await getBiochocoProjectId();
    if (!ctProjectId) {
      return { success: true, data: { sites: [] } };
    }

    // Parallel: ODK sites, deployments, iButton uploads, habitat assessments,
    // audio-bearing deployments, and BirdNET-analyzed deployments.
    const [
      rawSites,
      allDeps,
      allUploads,
      rawHabitatSubs,
      audioDepRows,
      birdnetDepRows,
      exclusionRows,
    ] = await Promise.all([
      fetchEntities<OdkSiteEntity>(BIOCHOCO_PROJECT_ID, BIOCHOCO_DATASET_SITES),
      db
        .select({
          id: deployments.id,
          name: deployments.name,
          siteName: deployments.siteName,
          status: deployments.status,
          excluded: deployments.excludedCamera,
        })
        .from(deployments)
        .where(
          and(
            eq(deployments.cameraTrapProjectId, ctProjectId),
            or(eq(deployments.excludedCamera, false), isNull(deployments.excludedCamera))
          )
        ),
      db
        .select({
          deploymentId: ibuttonUploads.deploymentId,
        })
        .from(ibuttonUploads),
      fetchSubmissions<Record<string, unknown>>(
        BIOCHOCO_PROJECT_ID,
        BIOCHOCO_FORM_HABITAT,
        { flatten: true }
      ),
      // Deployments that have any audio files at all.
      db
        .selectDistinct({ deploymentId: audioFiles.deploymentId })
        .from(audioFiles),
      // Deployments with a completed BirdNET analysis job (analyzed, even if
      // no annotation has been manually reviewed yet — "por revisar").
      db
        .selectDistinct({ deploymentId: processingJobs.deploymentId })
        .from(processingJobs)
        .where(
          and(
            eq(processingJobs.jobType, "birdnet"),
            eq(processingJobs.status, "completed"),
            isNotNull(processingJobs.deploymentId)
          )
        ),
      // ALL deployments with their per-stream exclusion flags (NOT filtered by
      // exclusion, unlike allDeps above) — used only to flag site cells whose
      // camera/audio data is entirely excluded, so an all-excluded site shows a
      // ✕ instead of vanishing from the readiness pool.
      db
        .select({
          id: deployments.id,
          name: deployments.name,
          siteName: deployments.siteName,
          excludedCamera: deployments.excludedCamera,
          excludedAudio: deployments.excludedAudio,
        })
        .from(deployments)
        .where(eq(deployments.cameraTrapProjectId, ctProjectId)),
    ]);

    const sites = transformSites(rawSites);
    const siteIdSet = new Set(sites.map((s) => s.siteId));
    const ibuttonDeploymentIds = new Set(allUploads.map((u) => u.deploymentId));
    const audioDeploymentIds = new Set(audioDepRows.map((r) => r.deploymentId));
    const birdnetDeploymentIds = new Set(
      birdnetDepRows.map((r) => r.deploymentId)
    );

    // Group the full (unfiltered) deployment set by site for the exclusion flags.
    const siteExclusionDeps = new Map<string, typeof exclusionRows>();
    for (const dep of exclusionRows) {
      const sid = deploymentToSiteId(dep, siteIdSet);
      if (!sid) continue;
      const list = siteExclusionDeps.get(sid) ?? [];
      list.push(dep);
      siteExclusionDeps.set(sid, list);
    }

    // Extract assessed site IDs from habitat submissions
    const assessedSiteIds = new Set<string>();
    for (const sub of rawHabitatSubs) {
      const siteId = String(sub.site_selection_site_id ?? "");
      if (siteId) assessedSiteIds.add(siteId);
    }

    // Check which deployments have verified/corrected identifications
    const processedStatuses = new Set(["processed", "verified"]);
    const processedDepIds = allDeps
      .filter((d) => processedStatuses.has(d.status))
      .map((d) => d.id);

    let depsWithVerifiedIds = new Set<number>();
    if (processedDepIds.length > 0) {
      const rows = await db
        .select({ depId: images.deploymentId })
        .from(identifications)
        .innerJoin(detections, eq(identifications.detectionId, detections.id))
        .innerJoin(images, eq(detections.imageId, images.id))
        .where(
          and(
            inArray(images.deploymentId, processedDepIds),
            inArray(identifications.verificationStatus, ["verified", "corrected"])
          )
        )
        .groupBy(images.deploymentId);
      depsWithVerifiedIds = new Set(rows.map((r) => r.depId));
    }

    // Group deployments by site
    const siteDeployments = new Map<string, typeof allDeps>();
    for (const dep of allDeps) {
      const siteId = deploymentToSiteId(dep, siteIdSet);
      if (!siteId) continue;
      const list = siteDeployments.get(siteId) ?? [];
      list.push(dep);
      siteDeployments.set(siteId, list);
    }

    // Build readiness per site
    const result: SiteWithReadiness[] = sites.map((site) => {
      const deps = siteDeployments.get(site.siteId) ?? [];
      const depIds = deps.map((d) => d.id);

      // Cameras
      let cameras: SiteReadiness["cameras"] = "none";
      if (deps.some((d) => depsWithVerifiedIds.has(d.id))) {
        cameras = "complete";
      } else if (deps.some((d) => processedStatuses.has(d.status))) {
        cameras = "in_progress";
      } else if (deps.length > 0) {
        cameras = "in_progress";
      }

      // Temperature
      const temperature: SiteReadiness["temperature"] = depIds.some((id) =>
        ibuttonDeploymentIds.has(id)
      )
        ? "complete"
        : "none";

      // Habitat
      const habitat: SiteReadiness["habitat"] = assessedSiteIds.has(site.siteId)
        ? "complete"
        : "none";

      // Audio (BirdNET): green once any deployment has a completed BirdNET run
      // (we don't manually verify these), amber when audio exists but hasn't
      // been analyzed yet, none when the site has no audio at all.
      let audio: SiteReadiness["audio"] = "none";
      if (depIds.some((id) => birdnetDeploymentIds.has(id))) {
        audio = "complete";
      } else if (depIds.some((id) => audioDeploymentIds.has(id))) {
        audio = "in_progress";
      }

      // Per-stream exclusion (red ✕): the site has deployments of that stream
      // but every one is excluded for it. Camera uses all site deployments;
      // audio uses only the audio-bearing ones (a site with no audio stays a
      // gray "none", not ✕).
      const exclDeps = siteExclusionDeps.get(site.siteId) ?? [];
      const camerasExcluded =
        exclDeps.length > 0 && exclDeps.every((d) => d.excludedCamera);
      const audioBearing = exclDeps.filter((d) => audioDeploymentIds.has(d.id));
      const audioExcluded =
        audioBearing.length > 0 && audioBearing.every((d) => d.excludedAudio);

      return {
        ...site,
        readiness: { cameras, temperature, habitat, audio, camerasExcluded, audioExcluded },
        deploymentCount: deps.length,
      };
    });

    return { success: true, data: { sites: result } };
  } catch (err) {
    log.error({ err }, "Failed to fetch resultados data");
    return {
      success: false,
      error: err instanceof Error ? err.message : "Error al cargar datos de resultados",
    };
  }
}

// ---------------------------------------------------------------------------
// Site detail page data
// ---------------------------------------------------------------------------

export async function fetchSiteDetail(
  siteId: string
): Promise<ActionResult<SiteDetail>> {
  try {
    await requirePermission("biochoco", "viewer");

    const ctProjectId = await getBiochocoProjectId();
    if (!ctProjectId) {
      return {
        success: true,
        data: {
          site: null,
          deploymentCount: 0,
          totalCameraTrapDays: 0,
          dateRange: { start: null, end: null },
          species: [],
          temperature: [],
          temperatureStats: null,
          habitat: null,
          habitatAssessmentCount: 0,
        },
      };
    }

    // Fetch sites, deployments, habitat in parallel
    const [rawSites, allDeps, rawHabitatSubs] = await Promise.all([
      fetchEntities<OdkSiteEntity>(BIOCHOCO_PROJECT_ID, BIOCHOCO_DATASET_SITES),
      db
        .select({
          id: deployments.id,
          name: deployments.name,
          siteName: deployments.siteName,
          status: deployments.status,
          dateStart: deployments.dateStart,
          dateEnd: deployments.dateEnd,
          validStart: deployments.validStart,
          validEnd: deployments.validEnd,
        })
        .from(deployments)
        .where(
          and(
            eq(deployments.cameraTrapProjectId, ctProjectId),
            or(eq(deployments.excludedCamera, false), isNull(deployments.excludedCamera))
          )
        ),
      fetchSubmissions<Record<string, unknown>>(
        BIOCHOCO_PROJECT_ID,
        BIOCHOCO_FORM_HABITAT,
        { flatten: true }
      ),
    ]);

    const sites = transformSites(rawSites);
    const siteIdSet = new Set(sites.map((s) => s.siteId));
    const site = sites.find((s) => s.siteId === siteId) ?? null;

    // Filter deployments for this site
    const siteDeps = allDeps.filter((dep) => {
      const mapped = deploymentToSiteId(dep, siteIdSet);
      return mapped === siteId;
    });

    const depIds = siteDeps.map((d) => d.id);

    // Calculate camera trap days and date range. Prefer the QA-validated window
    // (valid_* ?? date_*) so a camera that died early counts its real sampling
    // span, not the full install→retrieve interval — otherwise effort is
    // over-reported. Matches the trim used in the CSV export and occupancy.
    let totalCameraTrapDays = 0;
    let earliestStart: string | null = null;
    let latestEnd: string | null = null;
    for (const dep of siteDeps) {
      const depStart = dep.validStart ?? dep.dateStart;
      const depEnd = dep.validEnd ?? dep.dateEnd;
      if (depStart && depEnd) {
        const start = new Date(depStart);
        const end = new Date(depEnd);
        const days = Math.ceil(
          (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)
        );
        if (days > 0) totalCameraTrapDays += days;
      }
      if (depStart && (!earliestStart || depStart < earliestStart)) {
        earliestStart = depStart;
      }
      if (depEnd && (!latestEnd || depEnd > latestEnd)) {
        latestEnd = depEnd;
      }
    }

    // Fetch species and temperature in parallel
    const [speciesData, temperatureData, habitatResult] = await Promise.all([
      fetchSpeciesForDeployments(depIds),
      fetchTemperatureForDeployments(depIds, siteDeps),
      processHabitatForSite(siteId, rawHabitatSubs),
    ]);

    // Overall temperature stats
    let temperatureStats: SiteDetail["temperatureStats"] = null;
    if (temperatureData.length > 0) {
      const allStats = temperatureData
        .filter((t) => t.stats !== null)
        .map((t) => t.stats!);
      if (allStats.length > 0) {
        temperatureStats = {
          min: Math.min(...allStats.map((s) => s.min)),
          max: Math.max(...allStats.map((s) => s.max)),
          mean:
            Math.round(
              (allStats.reduce((sum, s) => sum + s.mean * s.count, 0) /
                allStats.reduce((sum, s) => sum + s.count, 0)) *
                100
            ) / 100,
        };
      }
    }

    return {
      success: true,
      data: {
        site,
        deploymentCount: siteDeps.length,
        totalCameraTrapDays,
        dateRange: { start: earliestStart, end: latestEnd },
        species: speciesData,
        temperature: temperatureData,
        temperatureStats,
        habitat: habitatResult.assessment,
        habitatAssessmentCount: habitatResult.totalCount,
      },
    };
  } catch (err) {
    log.error({ err }, "Failed to fetch site detail");
    return {
      success: false,
      error: err instanceof Error ? err.message : "Error al cargar detalle del sitio",
    };
  }
}

// ---------------------------------------------------------------------------
// Species aggregation
// ---------------------------------------------------------------------------

async function fetchSpeciesForDeployments(
  depIds: number[]
): Promise<SiteSpecies[]> {
  if (depIds.length === 0) return [];

  // Aggregate species across all deployments
  const rows = await db
    .select({
      speciesName: sql<string>`coalesce(${identifications.correctedSpecies}, ${identifications.species})`,
      spanishName: species.spanishName,
      commonName: species.commonName,
      taxonomicType: species.type,
      iucnStatus: species.iucnStatus,
      publicContent: species.publicContent,
      detectionCount: sql<number>`count(*)`,
      avgConfidence: sql<number>`round(avg(${identifications.confidence}), 3)`,
    })
    .from(identifications)
    .innerJoin(detections, eq(identifications.detectionId, detections.id))
    .innerJoin(images, eq(detections.imageId, images.id))
    .leftJoin(
      species,
      sql`${species.scientificName} = coalesce(${identifications.correctedSpecies}, ${identifications.species})`
    )
    .where(
      and(
        inArray(images.deploymentId, depIds),
        inArray(identifications.verificationStatus, ["verified", "corrected"])
      )
    )
    .groupBy(
      sql`coalesce(${identifications.correctedSpecies}, ${identifications.species})`
    )
    .orderBy(sql`count(*) DESC`);

  // For each species, resolve its gallery set (star-first / auto-capped) once.
  // The hero is the first resolved image; the full resolved id list drives the
  // public showcase's one-click swipe lightbox. Same per-species query count as
  // the old best-photo lookup, but now the policy lives in one place.
  const result: SiteSpecies[] = [];
  for (const row of rows) {
    const candidates = await fetchSpeciesCandidates(depIds, row.speciesName);
    const galleryImageIds = resolveSpeciesGallery(candidates).images.map(
      (c) => c.id
    );

    result.push({
      speciesName: row.speciesName,
      spanishName: row.spanishName,
      commonName: row.commonName,
      taxonomicType: row.taxonomicType,
      iucnStatus: row.iucnStatus,
      publicContent: row.publicContent,
      detectionCount: row.detectionCount,
      avgConfidence: row.avgConfidence,
      photoImageId: galleryImageIds[0] ?? null,
      galleryImageIds,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// Temperature data
// ---------------------------------------------------------------------------

async function fetchTemperatureForDeployments(
  depIds: number[],
  siteDeps: { id: number; name: string }[]
): Promise<DeploymentTemperature[]> {
  if (depIds.length === 0) return [];

  // Check which deployments have iButton data
  const uploads = await db
    .select({
      deploymentId: ibuttonUploads.deploymentId,
      dateRangeStart: ibuttonUploads.dateRangeStart,
      dateRangeEnd: ibuttonUploads.dateRangeEnd,
    })
    .from(ibuttonUploads)
    .where(inArray(ibuttonUploads.deploymentId, depIds));

  if (uploads.length === 0) return [];

  const uploadDepIds = uploads.map((u) => u.deploymentId);
  const uploadMap = new Map(uploads.map((u) => [u.deploymentId, u]));

  // Fetch all readings for these deployments
  const allReadings = await db
    .select({
      deploymentId: ibuttonReadings.deploymentId,
      timestamp: ibuttonReadings.timestamp,
      temperatureC: ibuttonReadings.temperatureC,
    })
    .from(ibuttonReadings)
    .where(inArray(ibuttonReadings.deploymentId, uploadDepIds))
    .orderBy(ibuttonReadings.deploymentId, ibuttonReadings.timestamp);

  // Count total readings to decide if we need to downsample
  const totalReadings = allReadings.length;
  const shouldDownsample = totalReadings > 5000;

  // Group by deployment
  const byDeployment = new Map<number, typeof allReadings>();
  for (const r of allReadings) {
    const list = byDeployment.get(r.deploymentId) ?? [];
    list.push(r);
    byDeployment.set(r.deploymentId, list);
  }

  const depNameMap = new Map(siteDeps.map((d) => [d.id, d.name]));

  const result: DeploymentTemperature[] = [];
  for (const depId of uploadDepIds) {
    const readings = byDeployment.get(depId) ?? [];
    const upload = uploadMap.get(depId);

    // Compute stats from full data
    let stats: DeploymentTemperature["stats"] = null;
    if (readings.length > 0) {
      const temps = readings.map((r) => r.temperatureC);
      const sum = temps.reduce((a, b) => a + b, 0);
      stats = {
        min: Math.min(...temps),
        max: Math.max(...temps),
        mean: Math.round((sum / temps.length) * 100) / 100,
        count: readings.length,
      };
    }

    // Downsample to daily aggregates if needed
    let chartReadings: { timestamp: string; temperatureC: number }[];
    if (shouldDownsample && readings.length > 0) {
      chartReadings = downsampleToDaily(readings);
    } else {
      chartReadings = readings.map((r) => ({
        timestamp: r.timestamp,
        temperatureC: r.temperatureC,
      }));
    }

    result.push({
      deploymentId: depId,
      deploymentName: depNameMap.get(depId) ?? `Deployment ${depId}`,
      dateRangeStart: upload?.dateRangeStart ?? null,
      dateRangeEnd: upload?.dateRangeEnd ?? null,
      readings: chartReadings,
      stats,
    });
  }

  return result;
}

/** Downsample temperature readings to daily mean values. */
function downsampleToDaily(
  readings: { timestamp: string; temperatureC: number }[]
): { timestamp: string; temperatureC: number }[] {
  const byDay = new Map<string, number[]>();
  for (const r of readings) {
    const day = r.timestamp.slice(0, 10); // "YYYY-MM-DD"
    const list = byDay.get(day) ?? [];
    list.push(r.temperatureC);
    byDay.set(day, list);
  }

  return Array.from(byDay.entries()).map(([day, temps]) => ({
    timestamp: `${day} 12:00:00`,
    temperatureC:
      Math.round((temps.reduce((a, b) => a + b, 0) / temps.length) * 100) / 100,
  }));
}

// ---------------------------------------------------------------------------
// Habitat
// ---------------------------------------------------------------------------

function processHabitatForSite(
  siteId: string,
  rawSubmissions: Record<string, unknown>[]
): { assessment: HabitatAssessment | null; totalCount: number } {
  const str = (sub: Record<string, unknown>, key: string) =>
    String(sub[key] ?? "");
  const num = (sub: Record<string, unknown>, key: string) => {
    const v = sub[key];
    return typeof v === "number" ? v : parseFloat(String(v ?? "0")) || 0;
  };

  const matching = rawSubmissions
    .filter((sub) => {
      const subSiteId = String(sub.site_selection_site_id ?? "");
      return subSiteId === siteId;
    })
    .map((sub) => ({
      instanceId: String(sub.__id ?? sub["__id"] ?? ""),
      siteId: str(sub, "site_selection_site_id"),
      siteName: str(sub, "site_selection_site_name"),
      habitatType: str(sub, "site_selection_habitat_type"),
      assessmentDate: str(sub, "site_selection_assessment_date"),
      canopyCoverPercent: num(sub, "canopy_section_canopy_cover_percent"),
      canopyHeightClass: str(sub, "height_section_canopy_height_class"),
      treesMedium: num(sub, "tree_section_trees_medium"),
      treesLarge: num(sub, "tree_section_trees_large"),
      understoryDensity: str(sub, "understory_section_understory_density"),
      slopeCategory: str(sub, "slope_section_slope_category"),
      distanceToEdgeM: num(sub, "edge_section_distance_to_edge_m"),
      adjacentHabitat: str(sub, "edge_section_adjacent_habitat"),
      disturbanceSigns: str(sub, "disturbance_signs"),
      habitatNotes: str(sub, "habitat_notes"),
      photoNorth: str(sub, "photo_section_photo_north"),
      photoEast: str(sub, "photo_section_photo_east"),
      photoSouth: str(sub, "photo_section_photo_south"),
      photoWest: str(sub, "photo_section_photo_west"),
      photoCanopy: str(sub, "photo_section_photo_canopy"),
    }))
    .sort((a, b) => b.assessmentDate.localeCompare(a.assessmentDate));

  return {
    assessment: matching[0] ?? null,
    totalCount: matching.length,
  };
}

// ---------------------------------------------------------------------------
// Site share links (public landowner-facing URLs)
// ---------------------------------------------------------------------------
//
// One active token per site (enforced by the unique partial index in
// schema.ts). Creation materializes the current deployment list as JSON
// because the deployment→site mapping has a name-pattern fallback that
// pure SQL can't reproduce, and we want a stable snapshot for the
// public image API to validate against.

const PUBLIC_BASE_URL =
  process.env.NEXT_PUBLIC_BASE_URL || "https://portal.fcat-ecuador.org";

/** Build the public URL for a site share token. */
function buildSiteShareUrl(token: string): string {
  return `${PUBLIC_BASE_URL}/public/biochoco/${token}`;
}

/** Resolve the deployments + hero image for a site. Used at token creation. */
async function resolveSiteSnapshot(siteId: string): Promise<{
  ok: true;
  deploymentIds: number[];
  heroImageId: number | null;
} | {
  ok: false;
  error: string;
}> {
  const ctProjectId = await getBiochocoProjectId();
  if (!ctProjectId) {
    return { ok: false, error: "Proyecto BioChocó no encontrado" };
  }

  const [rawSites, allDeps] = await Promise.all([
    fetchEntities<OdkSiteEntity>(BIOCHOCO_PROJECT_ID, BIOCHOCO_DATASET_SITES),
    db
      .select({
        id: deployments.id,
        name: deployments.name,
        siteName: deployments.siteName,
      })
      .from(deployments)
      .where(
        and(
          eq(deployments.cameraTrapProjectId, ctProjectId),
          or(eq(deployments.excludedCamera, false), isNull(deployments.excludedCamera))
        )
      ),
  ]);

  const sites = transformSites(rawSites);
  const siteIdSet = new Set(sites.map((s) => s.siteId));

  if (!siteIdSet.has(siteId)) {
    return { ok: false, error: `Sitio "${siteId}" no encontrado` };
  }

  const siteDeps = allDeps.filter(
    (dep) => deploymentToSiteId(dep, siteIdSet) === siteId
  );
  const depIds = siteDeps.map((d) => d.id);

  if (depIds.length === 0) {
    return {
      ok: false,
      error: "Aún no hay despliegues para este sitio",
    };
  }

  // Hero image: highest-confidence verified detection across the site's
  // deployments. Falls back to any image if no verified detections exist.
  const [bestDetection] = await db
    .select({ imageId: images.id })
    .from(identifications)
    .innerJoin(detections, eq(identifications.detectionId, detections.id))
    .innerJoin(images, eq(detections.imageId, images.id))
    .where(
      and(
        inArray(images.deploymentId, depIds),
        inArray(identifications.verificationStatus, ["verified", "corrected"])
      )
    )
    .orderBy(desc(identifications.confidence))
    .limit(1);

  let heroImageId = bestDetection?.imageId ?? null;
  if (heroImageId === null) {
    const [anyImage] = await db
      .select({ id: images.id })
      .from(images)
      .where(inArray(images.deploymentId, depIds))
      .limit(1);
    heroImageId = anyImage?.id ?? null;
  }

  return { ok: true, deploymentIds: depIds, heroImageId };
}

export async function createSiteShareLink(
  siteId: string,
  label?: string
): Promise<ActionResult<{ token: string; url: string }>> {
  const user = await requirePermission("biochoco", "editor");

  try {
    const snapshot = await resolveSiteSnapshot(siteId);
    if (!snapshot.ok) {
      return { success: false, error: snapshot.error };
    }

    const token = crypto.randomUUID();
    const cleanLabel = label?.trim() || null;
    const deploymentIdsJson = JSON.stringify(snapshot.deploymentIds);

    // Atomic revoke-then-insert. Sync transaction (no async helpers
    // inside — all values are pre-resolved).
    const [inserted] = db.transaction((tx) => {
      tx.update(siteShareTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(siteShareTokens.biochocoSiteId, siteId),
            isNull(siteShareTokens.revokedAt)
          )
        )
        .run();

      return tx
        .insert(siteShareTokens)
        .values({
          token,
          biochocoSiteId: siteId,
          deploymentIds: deploymentIdsJson,
          heroImageId: snapshot.heroImageId,
          createdBy: user.email,
          label: cleanLabel,
        })
        .returning()
        .all();
    });

    await recordEvent({
      source: "biochoco-resultados",
      eventType: "create_site_share_link",
      summary: `Enlace público creado para sitio ${siteId}`,
      actorEmail: user.email,
      projectId: "biochoco",
      targetType: "biochoco_site",
      targetId: siteId,
      details: {
        tokenId: inserted.id,
        label: cleanLabel,
        deploymentCount: snapshot.deploymentIds.length,
      },
    });

    revalidatePath(`/biochoco/resultados/${siteId}`);

    return {
      success: true,
      data: { token, url: buildSiteShareUrl(token) },
    };
  } catch (err) {
    log.error({ err }, "Failed to create site share link");
    return {
      success: false,
      error: err instanceof Error ? err.message : "Error al crear enlace",
    };
  }
}

export async function revokeSiteShareLink(
  siteId: string
): Promise<ActionResult<void>> {
  const user = await requirePermission("biochoco", "editor");

  try {
    const result = await db
      .update(siteShareTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(siteShareTokens.biochocoSiteId, siteId),
          isNull(siteShareTokens.revokedAt)
        )
      )
      .returning({ id: siteShareTokens.id });

    if (result.length === 0) {
      return { success: false, error: "No hay enlaces activos para revocar" };
    }

    await recordEvent({
      source: "biochoco-resultados",
      eventType: "revoke_site_share_link",
      summary: `Enlace público revocado para sitio ${siteId} (${result.length} token${result.length === 1 ? "" : "s"})`,
      actorEmail: user.email,
      projectId: "biochoco",
      targetType: "biochoco_site",
      targetId: siteId,
      details: { revokedTokenIds: result.map((r) => r.id) },
    });

    revalidatePath(`/biochoco/resultados/${siteId}`);
    return { success: true, data: undefined };
  } catch (err) {
    log.error({ err }, "Failed to revoke site share link");
    return {
      success: false,
      error: err instanceof Error ? err.message : "Error al revocar enlace",
    };
  }
}

/**
 * Look up the active share link for a site. Used by the internal results
 * page to populate the share button. Returns null if no active link.
 */
export async function getSiteShareLink(siteId: string): Promise<{
  token: string;
  url: string;
  createdAt: Date;
  createdBy: string;
  label: string | null;
  /** Effective page-builder config (stored config, else derived from legacy). */
  pageConfig: PageConfig;
  /** Lightweight view tracking for the share panel. */
  viewCount: number;
  firstViewedAt: Date | null;
  lastViewedAt: Date | null;
} | null> {
  const [row] = await db
    .select()
    .from(siteShareTokens)
    .where(
      and(
        eq(siteShareTokens.biochocoSiteId, siteId),
        isNull(siteShareTokens.revokedAt)
      )
    )
    .orderBy(desc(siteShareTokens.createdAt))
    .limit(1);

  if (!row) return null;

  const pageConfig =
    parsePageConfig(row.pageConfig) ??
    defaultConfigFromLegacy({
      heroImageId: row.heroImageId,
      landownerNote: row.landownerNote,
      featuredAudioId: row.featuredAudioId,
    });

  return {
    token: row.token,
    url: buildSiteShareUrl(row.token),
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    label: row.label,
    pageConfig,
    viewCount: row.viewCount ?? 0,
    firstViewedAt: row.firstViewedAt ?? null,
    lastViewedAt: row.lastViewedAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// Active-token helper
// ---------------------------------------------------------------------------

/** Resolve the deployment-id snapshot of a site's active share token ([] if none). */
async function activeTokenDepIds(siteId: string): Promise<number[]> {
  const [row] = await db
    .select({ deploymentIds: siteShareTokens.deploymentIds })
    .from(siteShareTokens)
    .where(
      and(
        eq(siteShareTokens.biochocoSiteId, siteId),
        isNull(siteShareTokens.revokedAt)
      )
    )
    .orderBy(desc(siteShareTokens.createdAt))
    .limit(1);
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.deploymentIds);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id) => typeof id === "number" && Number.isInteger(id));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Page builder — media pickers + config save
// ---------------------------------------------------------------------------
//
// The builder composes the public page's `page_config` on the site's active
// share token. Media pickers are scoped to the token snapshot, and the save
// action re-validates every media id against that snapshot so a token can only
// ever surface its own site's photos and recordings.

/** An audio clip the team can feature as the site's "example recording". */
export interface SiteAudioOption {
  id: number;
  filename: string;
  durationSeconds: number | null;
}

/** A candidate photo (one representative per species) for the featured grid. */
export interface SitePhotoOption {
  imageId: number;
  label: string;
}

/**
 * List the audio clips available to feature for a site — every playable
 * Drive-backed recording whose deployment is in the active token's snapshot.
 * Returns [] if there is no active link or no audio. Editor-only.
 */
export async function fetchSiteAudioOptions(
  siteId: string
): Promise<SiteAudioOption[]> {
  await requirePermission("biochoco", "editor");

  const depIds = await activeTokenDepIds(siteId);
  if (depIds.length === 0) return [];

  const rows = await db
    .select({
      id: audioFiles.id,
      filename: audioFiles.filename,
      duration: audioFiles.duration,
    })
    .from(audioFiles)
    .where(
      and(
        inArray(audioFiles.deploymentId, depIds),
        eq(audioFiles.playable, true),
        isNotNull(audioFiles.driveFileId)
      )
    )
    .orderBy(audioFiles.filename)
    .limit(500);

  return rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    durationSeconds: r.duration ?? null,
  }));
}

/**
 * List candidate photos for the featured-photos picker: the best (representative)
 * photo per species detected at the site. Editor-only; [] if no active link.
 */
export async function fetchSitePhotoOptions(
  siteId: string
): Promise<SitePhotoOption[]> {
  await requirePermission("biochoco", "editor");

  const depIds = await activeTokenDepIds(siteId);
  if (depIds.length === 0) return [];

  const speciesList = await fetchSpeciesForDeployments(depIds);
  const options: SitePhotoOption[] = [];
  for (const s of speciesList) {
    if (s.photoImageId == null) continue;
    options.push({
      imageId: s.photoImageId,
      label: s.spanishName || s.commonName || s.speciesName,
    });
  }
  return options;
}

/**
 * List the site's STARRED photos for the featured-photos picker — every image
 * flagged `starred = true` whose deployment is in the active token's snapshot,
 * ordered by when it was starred. These are the photos the team curated by
 * hand, and the picker's default source. Same gating as fetchSitePhotoOptions
 * (editor-only + token-snapshot scoped); returns [] if no active link or no
 * starred photos, which is the builder's cue to fall back to "Todas".
 */
export async function fetchSiteStarredPhotoOptions(
  siteId: string
): Promise<SitePhotoOption[]> {
  await requirePermission("biochoco", "editor");

  const depIds = await activeTokenDepIds(siteId);
  if (depIds.length === 0) return [];

  const rows = await db
    .select({
      imageId: images.id,
      filename: images.filename,
    })
    .from(images)
    .where(
      and(
        eq(images.starred, true),
        inArray(images.deploymentId, depIds)
      )
    )
    .orderBy(images.starredAt, images.id)
    .limit(200);

  return rows.map((r) => ({ imageId: r.imageId, label: r.filename }));
}

// ---------------------------------------------------------------------------
// Per-species photo curation (builder) — star/unstar the photos that lead each
// species' public gallery. Reuses biochoco_images.starred (the same flag the
// featured-photos picker uses); the public gallery (fetchSpeciesGalleryImages)
// shows starred photos first. Biochoco-editor gated + token-snapshot scoped.
// ---------------------------------------------------------------------------

/** A species at the site, with how many of its photos are currently starred. */
export interface CurationSpecies {
  speciesName: string;
  label: string;
  detectionCount: number;
  starredCount: number;
  previewImageId: number | null;
}

/** One photo of a species, with its current starred state, for the curator grid. */
export interface CurationPhoto {
  id: number;
  filename: string;
  starred: boolean;
  confidence: number;
}

/** Species observed at the site + their starred-photo counts, for the curator list. */
export async function fetchCurationSpecies(
  siteId: string
): Promise<CurationSpecies[]> {
  await requirePermission("biochoco", "editor");

  const depIds = await activeTokenDepIds(siteId);
  if (depIds.length === 0) return [];

  const speciesList = await fetchSpeciesForDeployments(depIds);

  const starredRows = await db
    .select({
      name: sql<string>`coalesce(${identifications.correctedSpecies}, ${identifications.species})`,
      count: sql<number>`count(distinct ${images.id})`,
    })
    .from(identifications)
    .innerJoin(detections, eq(identifications.detectionId, detections.id))
    .innerJoin(images, eq(detections.imageId, images.id))
    .where(
      and(
        inArray(images.deploymentId, depIds),
        eq(images.starred, true),
        inArray(identifications.verificationStatus, ["verified", "corrected"])
      )
    )
    .groupBy(
      sql`coalesce(${identifications.correctedSpecies}, ${identifications.species})`
    );

  const starredMap = new Map(starredRows.map((r) => [r.name, Number(r.count)]));

  return speciesList.map((s) => ({
    speciesName: s.speciesName,
    label: s.spanishName || s.commonName || s.speciesName,
    detectionCount: s.detectionCount,
    starredCount: starredMap.get(s.speciesName) ?? 0,
    previewImageId: s.photoImageId,
  }));
}

/** All photos of a species at the site (capped), for the curator grid. */
export async function fetchSpeciesPhotosForCuration(
  siteId: string,
  speciesName: string
): Promise<CurationPhoto[]> {
  await requirePermission("biochoco", "editor");

  const depIds = await activeTokenDepIds(siteId);
  if (depIds.length === 0) return [];

  const speciesMatch = sql`coalesce(${identifications.correctedSpecies}, ${identifications.species}) = ${speciesName}`;

  const rows = await db
    .select({
      id: images.id,
      filename: images.filename,
      starred: images.starred,
      confidence: sql<number>`max(${identifications.confidence})`,
    })
    .from(identifications)
    .innerJoin(detections, eq(identifications.detectionId, detections.id))
    .innerJoin(images, eq(detections.imageId, images.id))
    .where(
      and(
        inArray(images.deploymentId, depIds),
        inArray(identifications.verificationStatus, ["verified", "corrected"]),
        speciesMatch
      )
    )
    .groupBy(images.id, images.filename, images.starred)
    .orderBy(sql`coalesce(${images.exifTimestamp}, ${images.fileModified}) DESC`)
    .limit(500);

  return rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    starred: !!r.starred,
    confidence: r.confidence ?? 0,
  }));
}

/**
 * Star/unstar one photo from the finca-page builder. Biochoco-editor gated (a
 * separate role from camera-trap, so this does NOT reuse toggleStarred). The
 * image must belong to the site's active token snapshot — the same cross-site
 * guard the image proxy enforces — so a builder can only curate their own
 * site's photos.
 */
export async function toggleSpeciesPhotoStar(
  siteId: string,
  imageId: number
): Promise<ActionResult<{ starred: boolean }>> {
  const user = await requirePermission("biochoco", "editor");

  try {
    const depIds = await activeTokenDepIds(siteId);
    if (depIds.length === 0) {
      return { success: false, error: "No hay un enlace activo para este sitio" };
    }

    const [image] = await db
      .select({
        id: images.id,
        deploymentId: images.deploymentId,
        starred: images.starred,
      })
      .from(images)
      .where(eq(images.id, imageId));

    if (!image || !depIds.includes(image.deploymentId)) {
      return { success: false, error: "Imagen no encontrada en este sitio" };
    }

    const newValue = !image.starred;
    await db
      .update(images)
      .set({
        starred: newValue,
        starredBy: newValue ? user.email : null,
        starredAt: newValue ? new Date() : null,
      })
      .where(eq(images.id, imageId));

    return { success: true, data: { starred: newValue } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al actualizar",
    };
  }
}

/**
 * Persist the page-builder config on a site's active share token. The incoming
 * config is re-validated for shape (parsePageConfig) and every media id is
 * checked against the site's snapshot — invalid ids are stripped rather than
 * trusted, so a token can never surface another site's media. Editor-only.
 */
export async function updateSitePageConfig(
  siteId: string,
  config: PageConfig
): Promise<ActionResult<void>> {
  const user = await requirePermission("biochoco", "editor");

  try {
    const [row] = await db
      .select({
        id: siteShareTokens.id,
        deploymentIds: siteShareTokens.deploymentIds,
      })
      .from(siteShareTokens)
      .where(
        and(
          eq(siteShareTokens.biochocoSiteId, siteId),
          isNull(siteShareTokens.revokedAt)
        )
      )
      .orderBy(desc(siteShareTokens.createdAt))
      .limit(1);

    if (!row) {
      return { success: false, error: "No hay un enlace activo para este sitio" };
    }

    // Never trust the client object — re-parse through the shape validator,
    // then collapse to a single "Fotos destacadas" block (singleton, KTD-2).
    const parsed = parsePageConfig(JSON.stringify(config));
    if (!parsed) {
      return { success: false, error: "Configuración inválida" };
    }
    const clean = enforceFeaturedPhotosSingleton(parsed);

    let depIds: number[] = [];
    try {
      const parsed = JSON.parse(row.deploymentIds);
      if (Array.isArray(parsed)) {
        depIds = parsed.filter(
          (id) => typeof id === "number" && Number.isInteger(id)
        );
      }
    } catch {
      depIds = [];
    }

    // Collect the media ids the config references so we can validate in two queries.
    const imageIds = new Set<number>();
    const audioIds = new Set<number>();
    for (const b of clean.blocks) {
      if (b.type === "hero" && b.imageId != null) imageIds.add(b.imageId);
      if (b.type === "featuredPhotos") b.imageIds.forEach((id) => imageIds.add(id));
      if (b.type === "featuredAudio" && b.audioId != null) audioIds.add(b.audioId);
    }

    let validImages = new Set<number>();
    if (imageIds.size > 0 && depIds.length > 0) {
      const rows = await db
        .select({ id: images.id })
        .from(images)
        .where(
          and(
            inArray(images.id, [...imageIds]),
            inArray(images.deploymentId, depIds)
          )
        );
      validImages = new Set(rows.map((r) => r.id));
    }

    let validAudio = new Set<number>();
    if (audioIds.size > 0 && depIds.length > 0) {
      const rows = await db
        .select({ id: audioFiles.id })
        .from(audioFiles)
        .where(
          and(
            inArray(audioFiles.id, [...audioIds]),
            inArray(audioFiles.deploymentId, depIds),
            isNotNull(audioFiles.driveFileId)
          )
        );
      validAudio = new Set(rows.map((r) => r.id));
    }

    // Rebuild sanitized blocks: strip invalid media ids, drop now-empty blocks.
    const blocks: PageConfig["blocks"] = [];
    for (const b of clean.blocks) {
      switch (b.type) {
        case "hero":
          blocks.push({
            type: "hero",
            imageId:
              b.imageId != null && validImages.has(b.imageId) ? b.imageId : null,
          });
          break;
        case "featuredPhotos": {
          const kept = validateFeaturedPhotoIds(b.imageIds, validImages);
          if (kept.length > 0) blocks.push({ type: "featuredPhotos", imageIds: kept });
          break;
        }
        case "featuredAudio":
          blocks.push({
            type: "featuredAudio",
            audioId:
              b.audioId != null && validAudio.has(b.audioId) ? b.audioId : null,
          });
          break;
        default:
          blocks.push(b);
      }
    }

    const sanitized: PageConfig = { version: clean.version, blocks };

    await db
      .update(siteShareTokens)
      .set({ pageConfig: serializePageConfig(sanitized) })
      .where(eq(siteShareTokens.id, row.id));

    await recordEvent({
      source: "biochoco-resultados",
      eventType: "update_site_page_config",
      summary: `Página pública personalizada para sitio ${siteId}`,
      actorEmail: user.email,
      projectId: "biochoco",
      targetType: "biochoco_site",
      targetId: siteId,
      details: {
        tokenId: row.id,
        blockTypes: sanitized.blocks.map((b) => b.type),
      },
    });

    revalidatePath(`/biochoco/resultados/${siteId}`);
    return { success: true, data: undefined };
  } catch (err) {
    log.error({ err }, "Failed to update site page config");
    return {
      success: false,
      error: err instanceof Error ? err.message : "Error al guardar",
    };
  }
}

// ---------------------------------------------------------------------------
// Public site detail (token-gated, no requirePermission)
// ---------------------------------------------------------------------------
//
// Wrapped in React cache() so the public page and generateMetadata share
// a single DB hit per request.

/** A curated "example recording" surfaced on the public landowner page. */
export interface PublicFeaturedAudio {
  id: number;
  filename: string;
  durationSeconds: number | null;
}

/**
 * A page-config block resolved for the public client: media ids validated
 * against the site's snapshot and metadata attached. Rendered in order by the
 * public shell. `hero` is carried separately as `heroImageId`.
 */
export type ResolvedContentBlock =
  | { type: "summary"; text: string }
  | { type: "note"; text: string }
  | { type: "featuredPhotos"; imageIds: number[] }
  | { type: "featuredAudio"; audio: PublicFeaturedAudio }
  | { type: "projectContext"; blurb: string; siteCount: number | null };

export interface PublicSiteDetailExtras {
  siteId: string;
  /** Effective hero image (config hero block, else the token's heroImageId). */
  heroImageId: number | null;
  deploymentIds: number[];
  /** Ordered, resolved content blocks driving the public page body. */
  contentBlocks: ResolvedContentBlock[];
}

// The public payload exposes only a landowner-safe projection of `site` — no
// landowner name/phone, no GPS. See toPublicSiteInfo.
export type PublicSiteDetail = Omit<SiteDetail, "site"> &
  PublicSiteDetailExtras & { site: PublicSiteInfo | null };

/**
 * Resolve one featured audio clip to public metadata, guarding that its
 * deployment is still in the token's snapshot AND it still has a Drive file, so
 * a stale pick renders no player rather than a broken one.
 */
async function resolveFeaturedAudio(
  audioId: number,
  depIds: number[]
): Promise<PublicFeaturedAudio | null> {
  const [af] = await db
    .select({
      id: audioFiles.id,
      filename: audioFiles.filename,
      duration: audioFiles.duration,
      deploymentId: audioFiles.deploymentId,
      driveFileId: audioFiles.driveFileId,
    })
    .from(audioFiles)
    .where(eq(audioFiles.id, audioId));
  if (af && af.driveFileId && depIds.includes(af.deploymentId)) {
    return { id: af.id, filename: af.filename, durationSeconds: af.duration ?? null };
  }
  return null;
}

/**
 * Resolve a validated PageConfig into the ordered, client-safe content blocks
 * the public shell renders. Every block degrades to nothing when its media is
 * missing/stale or its text is empty; photo ids are validated against the
 * site's snapshot so a token can only surface its own media. The `hero` block
 * is handled by the caller (carried as heroImageId). Exactly one
 * `projectContext` block is always appended as the final element (any
 * config-sourced projectContext blocks are ignored), so the public page always
 * ends with the "Sobre el proyecto BioChoco" card and never shows two.
 */
async function resolveContentBlocks(
  rawConfig: PageConfig,
  depIds: number[],
  projectContext: { blurb: string; siteCount: number | null }
): Promise<ResolvedContentBlock[]> {
  // "Fotos destacadas" is a singleton: never emit two, even from a legacy
  // config that stored duplicates (KTD-2).
  const config = enforceFeaturedPhotosSingleton(rawConfig);
  // One query for every featured-photo id across all such blocks.
  const wantedPhotoIds = new Set<number>();
  for (const b of config.blocks) {
    if (b.type === "featuredPhotos") {
      for (const id of b.imageIds) wantedPhotoIds.add(id);
    }
  }
  let validPhotoIds = new Set<number>();
  if (wantedPhotoIds.size > 0 && depIds.length > 0) {
    const rows = await db
      .select({ id: images.id })
      .from(images)
      .where(
        and(
          inArray(images.id, [...wantedPhotoIds]),
          inArray(images.deploymentId, depIds)
        )
      );
    validPhotoIds = new Set(rows.map((r) => r.id));
  }

  const out: ResolvedContentBlock[] = [];
  for (const b of config.blocks) {
    switch (b.type) {
      case "summary": {
        const text = b.text.trim();
        if (text) out.push({ type: "summary", text });
        break;
      }
      case "note": {
        const text = b.text.trim();
        if (text) out.push({ type: "note", text });
        break;
      }
      case "featuredPhotos": {
        const imageIds = validateFeaturedPhotoIds(b.imageIds, validPhotoIds);
        if (imageIds.length > 0) out.push({ type: "featuredPhotos", imageIds });
        break;
      }
      case "featuredAudio": {
        if (b.audioId != null) {
          const audio = await resolveFeaturedAudio(b.audioId, depIds);
          if (audio) out.push({ type: "featuredAudio", audio });
        }
        break;
      }
      case "projectContext": {
        // Ignore config-sourced projectContext blocks entirely; exactly one is
        // always appended below so the "Sobre el proyecto BioChoco" card is
        // guaranteed present and never duplicated.
        break;
      }
      // "hero" is carried as heroImageId.
      default:
        break;
    }
  }

  // Always end with exactly one projectContext block, regardless of config.
  out.push({
    type: "projectContext",
    blurb: projectContext.blurb,
    siteCount: projectContext.siteCount,
  });
  return out;
}

export const fetchSiteDetailByToken = cache(
  async (token: string): Promise<PublicSiteDetail | null> => {
    if (!isValidShareToken(token)) return null;

    const [tokenRow] = await db
      .select()
      .from(siteShareTokens)
      .where(
        and(
          eq(siteShareTokens.token, token),
          isNull(siteShareTokens.revokedAt)
        )
      );

    if (!tokenRow) return null;

    let depIds: number[];
    try {
      const parsed = JSON.parse(tokenRow.deploymentIds);
      if (
        !Array.isArray(parsed) ||
        !parsed.every((id) => typeof id === "number" && Number.isInteger(id))
      ) {
        return null;
      }
      depIds = parsed;
    } catch {
      return null;
    }

    if (depIds.length === 0) {
      return null;
    }

    // Resolve site metadata + the heavy data slices in parallel.
    const [rawSites, siteDeps, rawHabitatSubs] = await Promise.all([
      fetchEntities<OdkSiteEntity>(BIOCHOCO_PROJECT_ID, BIOCHOCO_DATASET_SITES),
      db
        .select({
          id: deployments.id,
          name: deployments.name,
          siteName: deployments.siteName,
          status: deployments.status,
          dateStart: deployments.dateStart,
          dateEnd: deployments.dateEnd,
          validStart: deployments.validStart,
          validEnd: deployments.validEnd,
        })
        .from(deployments)
        .where(inArray(deployments.id, depIds)),
      fetchSubmissions<Record<string, unknown>>(
        BIOCHOCO_PROJECT_ID,
        BIOCHOCO_FORM_HABITAT,
        { flatten: true }
      ),
    ]);

    const sites = transformSites(rawSites);
    const site =
      sites.find((s) => s.siteId === tokenRow.biochocoSiteId) ?? null;

    // Prefer the QA-validated window (valid_* ?? date_*) so early-death cameras
    // count real sampling span, not the full install→retrieve interval. Keep in
    // sync with the per-site dashboard copy of this loop above.
    let totalCameraTrapDays = 0;
    let earliestStart: string | null = null;
    let latestEnd: string | null = null;
    for (const dep of siteDeps) {
      const depStart = dep.validStart ?? dep.dateStart;
      const depEnd = dep.validEnd ?? dep.dateEnd;
      if (depStart && depEnd) {
        const start = new Date(depStart);
        const end = new Date(depEnd);
        const days = Math.ceil(
          (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)
        );
        if (days > 0) totalCameraTrapDays += days;
      }
      if (depStart && (!earliestStart || depStart < earliestStart)) {
        earliestStart = depStart;
      }
      if (depEnd && (!latestEnd || depEnd > latestEnd)) {
        latestEnd = depEnd;
      }
    }

    const [speciesData, temperatureData, habitatResult] = await Promise.all([
      fetchSpeciesForDeployments(depIds),
      fetchTemperatureForDeployments(depIds, siteDeps),
      processHabitatForSite(tokenRow.biochocoSiteId, rawHabitatSubs),
    ]);

    let temperatureStats: SiteDetail["temperatureStats"] = null;
    if (temperatureData.length > 0) {
      const allStats = temperatureData
        .filter((t) => t.stats !== null)
        .map((t) => t.stats!);
      if (allStats.length > 0) {
        temperatureStats = {
          min: Math.min(...allStats.map((s) => s.min)),
          max: Math.max(...allStats.map((s) => s.max)),
          mean:
            Math.round(
              (allStats.reduce((sum, s) => sum + s.mean * s.count, 0) /
                allStats.reduce((sum, s) => sum + s.count, 0)) *
                100
            ) / 100,
        };
      }
    }

    // Config-first: parse the stored page config, else derive the default from
    // the legacy columns so an un-built token renders exactly as before.
    const config =
      parsePageConfig(tokenRow.pageConfig) ??
      defaultConfigFromLegacy({
        heroImageId: tokenRow.heroImageId,
        landownerNote: tokenRow.landownerNote,
        featuredAudioId: tokenRow.featuredAudioId,
      });
    const heroBlock = config.blocks.find((b) => b.type === "hero");
    const effectiveHeroId =
      (heroBlock?.type === "hero" ? heroBlock.imageId : null) ??
      tokenRow.heroImageId;
    const contentBlocks = await resolveContentBlocks(config, depIds, {
      // Landowner-scoped copy (Spanish, audience-specific) — NOT the shared
      // overview intro (English), which feeds the divulgation overview page.
      blurb: PROJECT_CONTEXT_BLURB,
      siteCount: sites.length > 0 ? sites.length : null,
    });

    return {
      // Landowner-safe projection only — strips name/phone/GPS from the client payload.
      site: toPublicSiteInfo(site),
      siteId: tokenRow.biochocoSiteId,
      heroImageId: effectiveHeroId,
      deploymentIds: depIds,
      contentBlocks,
      deploymentCount: siteDeps.length,
      totalCameraTrapDays,
      dateRange: { start: earliestStart, end: latestEnd },
      species: speciesData,
      temperature: temperatureData,
      temperatureStats,
      habitat: habitatResult.assessment,
      habitatAssessmentCount: habitatResult.totalCount,
    };
  }
);

// ---------------------------------------------------------------------------
// Per-species image listing (used by both internal + public species views)
// ---------------------------------------------------------------------------

export interface SpeciesImageRow {
  id: number;
  filename: string;
  exifTimestamp: string | null;
  confidence: number;
}

export interface SpeciesImagesResult {
  images: SpeciesImageRow[];
  totalCount: number;
  page: number;
  pageSize: number;
}

export async function fetchSpeciesImagesForDeployments(
  depIds: number[],
  speciesName: string,
  page: number,
  pageSize: number
): Promise<SpeciesImagesResult> {
  if (depIds.length === 0 || pageSize <= 0) {
    return { images: [], totalCount: 0, page, pageSize };
  }

  const safePage = Math.max(1, Math.floor(page));
  const offset = (safePage - 1) * pageSize;

  const speciesMatch = sql`coalesce(${identifications.correctedSpecies}, ${identifications.species}) = ${speciesName}`;

  const [{ totalCount }] = await db
    .select({
      totalCount: sql<number>`count(distinct ${images.id})`,
    })
    .from(identifications)
    .innerJoin(detections, eq(identifications.detectionId, detections.id))
    .innerJoin(images, eq(detections.imageId, images.id))
    .where(
      and(
        inArray(images.deploymentId, depIds),
        inArray(identifications.verificationStatus, ["verified", "corrected"]),
        speciesMatch
      )
    );

  const rows = await db
    .select({
      id: images.id,
      filename: images.filename,
      exifTimestamp: images.exifTimestamp,
      confidence: sql<number>`max(${identifications.confidence})`,
    })
    .from(identifications)
    .innerJoin(detections, eq(identifications.detectionId, detections.id))
    .innerJoin(images, eq(detections.imageId, images.id))
    .where(
      and(
        inArray(images.deploymentId, depIds),
        inArray(identifications.verificationStatus, ["verified", "corrected"]),
        speciesMatch
      )
    )
    .groupBy(images.id, images.filename, images.exifTimestamp)
    .orderBy(sql`coalesce(${images.exifTimestamp}, ${images.fileModified}) DESC`)
    .limit(pageSize)
    .offset(offset);

  return {
    images: rows.map((r) => ({
      id: r.id,
      filename: r.filename,
      exifTimestamp: r.exifTimestamp,
      confidence: r.confidence ?? 0,
    })),
    totalCount: Number(totalCount ?? 0),
    page: safePage,
    pageSize,
  };
}

export interface SpeciesGalleryResult {
  images: SpeciesImageRow[];
  /** Images shown after curation/capping (total across all pages of the resolved set). */
  totalCount: number;
  /** Verified images available for the species BEFORE curation/capping (for context copy). */
  totalAvailable: number;
  /** How the shown set was chosen — see resolveSpeciesGallery. */
  mode: GalleryMode;
  page: number;
  pageSize: number;
}

/**
 * Resolve which of a species' photos to show on the public finca gallery, then
 * paginate. Unlike fetchSpeciesImagesForDeployments (which returns every
 * verified image), this applies the star-first / auto-cap policy in
 * resolveSpeciesGallery so landowners see a curated, non-overwhelming set:
 *   - starred photos win (the team's "destacadas");
 *   - else all photos when there are few;
 *   - else the highest-confidence sample when there are many.
 * The decision runs in JS over the species' candidate images (bounded per
 * species per site); pagination then slices the resolved set.
 */
/**
 * Load every verified/corrected image of a species (within the deployments),
 * newest-first, with the fields `resolveSpeciesGallery` needs to pick the shown
 * set. Single source of truth for the candidate query — used by both the public
 * per-species page and the showcase's per-species gallery-id resolution.
 */
async function fetchSpeciesCandidates(
  depIds: number[],
  speciesName: string
): Promise<GalleryCandidate[]> {
  if (depIds.length === 0) return [];

  const speciesMatch = sql`coalesce(${identifications.correctedSpecies}, ${identifications.species}) = ${speciesName}`;

  const rows = await db
    .select({
      id: images.id,
      filename: images.filename,
      exifTimestamp: images.exifTimestamp,
      starred: images.starred,
      starredAt: images.starredAt,
      confidence: sql<number>`max(${identifications.confidence})`,
    })
    .from(identifications)
    .innerJoin(detections, eq(identifications.detectionId, detections.id))
    .innerJoin(images, eq(detections.imageId, images.id))
    .where(
      and(
        inArray(images.deploymentId, depIds),
        inArray(identifications.verificationStatus, ["verified", "corrected"]),
        speciesMatch
      )
    )
    .groupBy(
      images.id,
      images.filename,
      images.exifTimestamp,
      images.starred,
      images.starredAt
    )
    .orderBy(sql`coalesce(${images.exifTimestamp}, ${images.fileModified}) DESC`);

  return rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    exifTimestamp: r.exifTimestamp,
    confidence: r.confidence ?? 0,
    starred: !!r.starred,
    starredAt: r.starredAt ? r.starredAt.getTime() : null,
  }));
}

export async function fetchSpeciesGalleryImages(
  depIds: number[],
  speciesName: string,
  page: number,
  pageSize: number
): Promise<SpeciesGalleryResult> {
  if (depIds.length === 0 || pageSize <= 0) {
    return {
      images: [],
      totalCount: 0,
      totalAvailable: 0,
      mode: "all",
      page: Math.max(1, Math.floor(page)),
      pageSize,
    };
  }

  const candidates = await fetchSpeciesCandidates(depIds, speciesName);
  const resolved = resolveSpeciesGallery(candidates);

  const safePage = Math.max(1, Math.floor(page));
  const offset = (safePage - 1) * pageSize;
  const pageItems = resolved.images.slice(offset, offset + pageSize);

  return {
    images: pageItems.map((c) => ({
      id: c.id,
      filename: c.filename,
      exifTimestamp: c.exifTimestamp,
      confidence: c.confidence,
    })),
    totalCount: resolved.images.length,
    totalAvailable: resolved.totalAvailable,
    mode: resolved.mode,
    page: safePage,
    pageSize,
  };
}

/**
 * Token-gated wrapper for the species image listing — used by the public
 * sub-route. Returns null if the token is invalid or revoked.
 */
export async function fetchSpeciesImagesByToken(
  token: string,
  speciesName: string,
  page: number,
  pageSize: number
): Promise<SpeciesImagesResult | null> {
  const data = await fetchSiteDetailByToken(token);
  if (!data) return null;
  return fetchSpeciesImagesForDeployments(
    data.deploymentIds,
    speciesName,
    page,
    pageSize
  );
}

/**
 * Fire-and-forget view tracking for the public landowner page. Called once
 * from the public page component body (NOT generateMetadata, NOT inside the
 * cached fetchSiteDetailByToken) so the cached fetch stays side-effect free.
 *
 * Not permission-gated: the public route's auth is the unguessable active
 * token itself. A single UPDATE stamps last_viewed_at + increments the count
 * and seeds first_viewed_at via COALESCE(..., unixepoch()) — unixepoch()
 * yields Unix seconds, matching the mode:"timestamp" column encoding.
 *
 * Any failure is swallowed: a tracking write must never break the render.
 */
export async function recordSiteView(token: string): Promise<void> {
  if (!isValidShareToken(token)) return;

  try {
    await db
      .update(siteShareTokens)
      .set({
        lastViewedAt: new Date(),
        viewCount: sql`${siteShareTokens.viewCount} + 1`,
        firstViewedAt: sql`COALESCE(${siteShareTokens.firstViewedAt}, unixepoch())`,
      })
      .where(
        and(
          eq(siteShareTokens.token, token),
          isNull(siteShareTokens.revokedAt)
        )
      );
  } catch (err) {
    log.warn({ err }, "Failed to record site view (swallowed)");
  }
}
