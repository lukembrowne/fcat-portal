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
} from "@/db/schema";
import { recordEvent } from "@/lib/system-events";
import { eq, and, sql, inArray, isNull, or, desc } from "drizzle-orm";
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
    return { ok: false, error: "Proyecto BioChoco no encontrado" };
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
          or(eq(deployments.excluded, false), isNull(deployments.excluded))
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

  return {
    token: row.token,
    url: buildSiteShareUrl(row.token),
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    label: row.label,
  };
}

// ---------------------------------------------------------------------------
// Public site detail (token-gated, no requirePermission)
// ---------------------------------------------------------------------------
//
// Wrapped in React cache() so the public page and generateMetadata share
// a single DB hit per request.

export interface PublicSiteDetailExtras {
  siteId: string;
  heroImageId: number | null;
  deploymentIds: number[];
}

// The public payload exposes only a landowner-safe projection of `site` — no
// landowner name/phone, no GPS. See toPublicSiteInfo.
export type PublicSiteDetail = Omit<SiteDetail, "site"> &
  PublicSiteDetailExtras & { site: PublicSiteInfo | null };

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

    return {
      // Landowner-safe projection only — strips name/phone/GPS from the client payload.
      site: toPublicSiteInfo(site),
      siteId: tokenRow.biochocoSiteId,
      heroImageId: tokenRow.heroImageId,
      deploymentIds: depIds,
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
