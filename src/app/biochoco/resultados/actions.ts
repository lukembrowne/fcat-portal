"use server";

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
} from "@/db/schema";
import { eq, and, sql, inArray, isNull, or } from "drizzle-orm";
import { fetchEntities, fetchSubmissions } from "@/lib/odk-client";
import {
  BIOCHOCO_PROJECT_ID,
  BIOCHOCO_DATASET_SITES,
  BIOCHOCO_FORM_HABITAT,
} from "@/lib/odk-constants";
import type { OdkSiteEntity } from "@/lib/odk-types";
import type { ActionResult } from "@/lib/types";
import type { SiteInfo } from "../overview/types";
import type { HabitatAssessment } from "../habitat/types";
import type {
  ResultadosData,
  SiteWithReadiness,
  SiteReadiness,
  SiteDetail,
  SiteSpecies,
  DeploymentTemperature,
} from "./types";

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
    siteId: s.site_id ?? s.label ?? "",
    siteName: s.label ?? s.site_name ?? "",
    habitatType: s.habitat_type ?? "",
    lat: s.latitude ? parseFloat(String(s.latitude)) : null,
    lng: s.longitude ? parseFloat(String(s.longitude)) : null,
    habitatAssessed: (s.habitat_assessed as string) ?? "",
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

    // Parallel: ODK sites, deployments, iButton uploads, habitat assessments
    const [rawSites, allDeps, allUploads, rawHabitatSubs] = await Promise.all([
      fetchEntities<OdkSiteEntity>(BIOCHOCO_PROJECT_ID, BIOCHOCO_DATASET_SITES),
      db
        .select({
          id: deployments.id,
          name: deployments.name,
          siteName: deployments.siteName,
          status: deployments.status,
          excluded: deployments.excluded,
        })
        .from(deployments)
        .where(
          and(
            eq(deployments.cameraTrapProjectId, ctProjectId),
            or(eq(deployments.excluded, false), isNull(deployments.excluded))
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
    ]);

    const sites = transformSites(rawSites);
    const siteIdSet = new Set(sites.map((s) => s.siteId));
    const ibuttonDeploymentIds = new Set(allUploads.map((u) => u.deploymentId));

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

      return {
        ...site,
        readiness: { cameras, temperature, habitat, audio: "none" as const },
        deploymentCount: deps.length,
      };
    });

    return { success: true, data: { sites: result } };
  } catch (err) {
    console.error("Failed to fetch resultados data:", err);
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
        })
        .from(deployments)
        .where(
          and(
            eq(deployments.cameraTrapProjectId, ctProjectId),
            or(eq(deployments.excluded, false), isNull(deployments.excluded))
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

    // Calculate camera trap days and date range
    let totalCameraTrapDays = 0;
    let earliestStart: string | null = null;
    let latestEnd: string | null = null;
    for (const dep of siteDeps) {
      if (dep.dateStart && dep.dateEnd) {
        const start = new Date(dep.dateStart);
        const end = new Date(dep.dateEnd);
        const days = Math.ceil(
          (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)
        );
        if (days > 0) totalCameraTrapDays += days;
      }
      if (dep.dateStart && (!earliestStart || dep.dateStart < earliestStart)) {
        earliestStart = dep.dateStart;
      }
      if (dep.dateEnd && (!latestEnd || dep.dateEnd > latestEnd)) {
        latestEnd = dep.dateEnd;
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
    console.error("Failed to fetch site detail:", err);
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

  // For each species, find the best photo (highest confidence verified detection)
  const result: SiteSpecies[] = [];
  for (const row of rows) {
    let photoImageId: number | null = null;
    // Find highest-confidence verified detection for this species
    const [photo] = await db
      .select({ imageId: images.id })
      .from(identifications)
      .innerJoin(detections, eq(identifications.detectionId, detections.id))
      .innerJoin(images, eq(detections.imageId, images.id))
      .where(
        and(
          inArray(images.deploymentId, depIds),
          sql`coalesce(${identifications.correctedSpecies}, ${identifications.species}) = ${row.speciesName}`,
          inArray(identifications.verificationStatus, ["verified", "corrected"])
        )
      )
      .orderBy(sql`${identifications.confidence} DESC`)
      .limit(1);
    if (photo) photoImageId = photo.imageId;

    result.push({
      speciesName: row.speciesName,
      spanishName: row.spanishName,
      commonName: row.commonName,
      taxonomicType: row.taxonomicType,
      detectionCount: row.detectionCount,
      avgConfidence: row.avgConfidence,
      photoImageId,
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
