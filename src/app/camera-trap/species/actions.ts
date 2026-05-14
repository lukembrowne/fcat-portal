/**
 * Server actions for the camera-trap species browser.
 *
 * Every public action independently calls requirePermission + getUserCameraTrapProjects
 * + ctProjectFilter — no implicit trust that a parent query has scoped access.
 *
 * URL params are whitelisted via species-search-params parsers before any
 * Drizzle query so hand-crafted URLs cannot trigger type coercion.
 */

"use server";

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  deployments,
  identifications,
  detections,
  images,
  species,
  cameraTrapProjects,
} from "@/db/schema";
import {
  aggregateCameraTrapBySpecies,
  aggregateCameraTrapSpeciesSites,
  type SpeciesAggregate,
  type SiteAggregate,
} from "@/db/effective-species";
import { requirePermission } from "@/lib/auth";
import {
  getUserCameraTrapProjects,
  ctProjectFilter,
} from "@/lib/camera-trap-auth";
import {
  parseStatuses,
  parseProjectId,
  parsePositiveInt,
  type VerificationStatus,
} from "@/lib/species-search-params";
import { resolveSpeciesFromSlug } from "@/lib/species-slug-server";
import type { ActionResult } from "@/lib/types";
import type { Species } from "@/db/schema";
import type { ImageGridItem } from "@/components/image-grid";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpeciesIndexRow {
  scientificName: string;
  commonName: string;
  spanishName: string | null;
  detectionCount: number;
  siteCount: number;
  lastSeen: number | null; // unix seconds
  projectIds: number[];
}

export interface SiteSummary {
  deploymentId: number;
  deploymentName: string;
  latitude: number | null;
  longitude: number | null;
  cameraTrapProjectId: number | null;
  detectionCount: number;
  lastSeen: number | null;
}

export interface ProjectOption {
  id: number;
  name: string;
}

export interface SpeciesDetailData {
  species: Species;
  totalCount: number;
  sites: SiteSummary[];
  sitesWithoutLocation: SiteSummary[];
  availableProjects: ProjectOption[];
}

export interface SitePageData {
  items: ImageGridItem[];
  totalPages: number;
  currentPage: number;
}

const PAGE_SIZE = 24;

// ---------------------------------------------------------------------------
// Species index
// ---------------------------------------------------------------------------

export async function getCameraTrapSpeciesIndex(): Promise<
  ActionResult<SpeciesIndexRow[]>
> {
  const user = await requirePermission("camera-trap", "viewer");
  const ctProjects = await getUserCameraTrapProjects(user);

  const aggregates = await aggregateCameraTrapBySpecies(ctProjects);
  const names = [...aggregates.keys()];
  const speciesRows = names.length
    ? await db
        .select()
        .from(species)
        .where(inArray(species.scientificName, names))
    : [];
  const byName = new Map(speciesRows.map((s) => [s.scientificName, s]));

  const rows: SpeciesIndexRow[] = [];
  for (const agg of aggregates.values()) {
    const sp = byName.get(agg.scientificName);
    rows.push({
      scientificName: agg.scientificName,
      commonName: sp?.commonName ?? agg.scientificName,
      spanishName: sp?.spanishName ?? null,
      detectionCount: agg.detectionCount,
      siteCount: agg.siteCount,
      lastSeen: agg.lastSeen,
      projectIds: agg.projectIds,
    });
  }
  rows.sort(
    (a, b) =>
      b.detectionCount - a.detectionCount ||
      a.scientificName.localeCompare(b.scientificName)
  );
  return { success: true, data: rows };
}

// ---------------------------------------------------------------------------
// Detail (header + sites + map markers + filter options)
// ---------------------------------------------------------------------------

interface DetailFilters {
  statuses: VerificationStatus[];
  projectId: number | null;
}

function readDetailFilters(
  searchParams: Record<string, string | string[] | undefined>,
  ctProjects: number[] | "all"
): DetailFilters {
  return {
    statuses: parseStatuses(searchParams.status),
    projectId: parseProjectId(searchParams.project, ctProjects),
  };
}

export async function getCameraTrapSpeciesDetail(
  slug: string,
  searchParams: Record<string, string | string[] | undefined>
): Promise<ActionResult<SpeciesDetailData | null>> {
  const user = await requirePermission("camera-trap", "viewer");
  const ctProjects = await getUserCameraTrapProjects(user);

  const target = await resolveSpeciesFromSlug(slug);
  if (!target) return { success: true, data: null };

  const filters = readDetailFilters(searchParams, ctProjects);

  // Site aggregation honors filters: project + status set.
  const filteredProjects =
    filters.projectId != null ? [filters.projectId] : ctProjects;
  const allSites = await aggregateCameraTrapSpeciesSites(
    target.scientificName,
    filteredProjects
  );

  // Apply status filter post-hoc: if statuses === default (all except rejected)
  // the aggregator already excluded rejected via effective-species predicates,
  // so a separate query is only needed when statuses is a strict subset.
  // For v1, the aggregator returns site totals across active+corrected. If a
  // user picks JUST 'verified', we re-aggregate via a tighter query.
  let sites = allSites;
  const isStrictSubset =
    filters.statuses.length < 3 ||
    !filters.statuses.includes("unverified") ||
    !filters.statuses.includes("verified") ||
    !filters.statuses.includes("corrected");
  if (isStrictSubset) {
    sites = await filteredSiteAggregation(
      target.scientificName,
      filteredProjects,
      filters.statuses
    );
  }

  const sitesWithLoc = sites.filter(
    (s) => s.latitude != null && s.longitude != null
  );
  const sitesWithoutLoc = sites.filter(
    (s) => s.latitude == null || s.longitude == null
  );
  sitesWithLoc.sort(
    (a, b) =>
      b.detectionCount - a.detectionCount ||
      a.deploymentName.localeCompare(b.deploymentName)
  );
  sitesWithoutLoc.sort(
    (a, b) =>
      b.detectionCount - a.detectionCount ||
      a.deploymentName.localeCompare(b.deploymentName)
  );

  const totalCount = sites.reduce((acc, s) => acc + s.detectionCount, 0);

  // Available projects = the user's accessible projects, with names.
  const projectFilter =
    ctProjects === "all"
      ? undefined
      : ctProjects.length === 0
        ? inArray(cameraTrapProjects.id, [-1])
        : inArray(cameraTrapProjects.id, ctProjects);
  const projectRows = await db
    .select({ id: cameraTrapProjects.id, name: cameraTrapProjects.name })
    .from(cameraTrapProjects)
    .where(projectFilter);
  const availableProjects: ProjectOption[] = projectRows
    .map((p) => ({ id: p.id, name: p.name }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    success: true,
    data: {
      species: target,
      totalCount,
      sites: sitesWithLoc,
      sitesWithoutLocation: sitesWithoutLoc,
      availableProjects,
    },
  };
}

/** Aggregate sites limited to a subset of verification statuses. */
async function filteredSiteAggregation(
  scientificName: string,
  ctProjects: number[] | "all",
  statuses: VerificationStatus[]
): Promise<SiteAggregate[]> {
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
  // 'rejected' is intentionally NOT a "this is a detection of species X" state.

  const merged = new Map<number, SiteAggregate>();

  if (acceptsActive) {
    const activeStatuses = [
      ...(statusSet.has("verified") ? (["verified"] as const) : []),
      ...(statusSet.has("unverified") ? (["unverified"] as const) : []),
    ];
    const rows = await db
      .select({
        deploymentId: deployments.id,
        deploymentName: deployments.name,
        latitude: deployments.latitude,
        longitude: deployments.longitude,
        cameraTrapProjectId: deployments.cameraTrapProjectId,
        count: sql<number>`COUNT(*)`,
        lastSeen: sql<number | null>`MAX(strftime('%s', ${images.exifTimestamp}))`,
      })
      .from(identifications)
      .innerJoin(detections, eq(detections.id, identifications.detectionId))
      .innerJoin(images, eq(images.id, detections.imageId))
      .innerJoin(deployments, eq(deployments.id, images.deploymentId))
      .where(
        and(
          inArray(identifications.verificationStatus, [...activeStatuses]),
          eq(identifications.species, scientificName),
          projectWhere
        )
      )
      .groupBy(deployments.id);

    for (const r of rows) merge(merged, r);
  }

  if (acceptsCorrected) {
    const rows = await db
      .select({
        deploymentId: deployments.id,
        deploymentName: deployments.name,
        latitude: deployments.latitude,
        longitude: deployments.longitude,
        cameraTrapProjectId: deployments.cameraTrapProjectId,
        count: sql<number>`COUNT(*)`,
        lastSeen: sql<number | null>`MAX(strftime('%s', ${images.exifTimestamp}))`,
      })
      .from(identifications)
      .innerJoin(detections, eq(detections.id, identifications.detectionId))
      .innerJoin(images, eq(images.id, detections.imageId))
      .innerJoin(deployments, eq(deployments.id, images.deploymentId))
      .where(
        and(
          eq(identifications.verificationStatus, "corrected"),
          eq(identifications.correctedSpecies, scientificName),
          projectWhere
        )
      )
      .groupBy(deployments.id);

    for (const r of rows) merge(merged, r);
  }

  return [...merged.values()];
}

function merge(
  out: Map<number, SiteAggregate>,
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

// ---------------------------------------------------------------------------
// Site page (per-deployment image grid for the species)
// ---------------------------------------------------------------------------

export async function getCameraTrapSpeciesSitePage(
  slug: string,
  deploymentId: number,
  page: number,
  searchParams: Record<string, string | string[] | undefined>
): Promise<ActionResult<SitePageData>> {
  const user = await requirePermission("camera-trap", "viewer");
  const ctProjects = await getUserCameraTrapProjects(user);

  const target = await resolveSpeciesFromSlug(slug);
  if (!target) return { success: false, error: "Especie no encontrada." };

  const filters = readDetailFilters(searchParams, ctProjects);
  const safePage = parsePositiveInt(String(page), 1);

  // Verify the user has access to this deployment via ctProjectFilter at the
  // identification-level WHERE. We never trust the URL deploymentId.
  const statusSet = new Set(filters.statuses);
  const acceptsActive =
    statusSet.has("verified") || statusSet.has("unverified");
  const acceptsCorrected = statusSet.has("corrected");

  const orConditions: ReturnType<typeof and>[] = [];
  if (acceptsActive) {
    const allowed = [
      ...(statusSet.has("verified") ? (["verified"] as const) : []),
      ...(statusSet.has("unverified") ? (["unverified"] as const) : []),
    ];
    orConditions.push(
      and(
        inArray(identifications.verificationStatus, [...allowed]),
        eq(identifications.species, target.scientificName)
      )
    );
  }
  if (acceptsCorrected) {
    orConditions.push(
      and(
        eq(identifications.verificationStatus, "corrected"),
        eq(identifications.correctedSpecies, target.scientificName)
      )
    );
  }

  if (orConditions.length === 0) {
    return { success: true, data: { items: [], totalPages: 0, currentPage: 1 } };
  }

  const speciesCondition = sql`(${sql.join(
    orConditions.filter((c): c is NonNullable<typeof c> => c != null),
    sql` OR `
  )})`;

  // Total distinct images for pagination
  const totalRow = await db
    .select({ count: sql<number>`COUNT(DISTINCT ${images.id})` })
    .from(identifications)
    .innerJoin(detections, eq(detections.id, identifications.detectionId))
    .innerJoin(images, eq(images.id, detections.imageId))
    .innerJoin(deployments, eq(deployments.id, images.deploymentId))
    .where(
      and(
        eq(images.deploymentId, deploymentId),
        ctProjectFilter(filters.projectId != null ? [filters.projectId] : ctProjects),
        speciesCondition
      )
    );
  const total = Number(totalRow[0]?.count ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const clampedPage = Math.min(safePage, totalPages);
  const offset = (clampedPage - 1) * PAGE_SIZE;

  // Distinct image IDs sorted by exif timestamp desc.
  const imageRows = await db
    .selectDistinct({
      id: images.id,
      filename: images.filename,
      path: images.path,
      status: images.status,
      thumbnailPath: images.thumbnailPath,
      videoId: images.videoId,
      frameIndex: images.frameIndex,
      confirmedBlank: images.confirmedBlank,
      starred: images.starred,
      setupTag: images.setupTag,
      exifTimestamp: images.exifTimestamp,
    })
    .from(identifications)
    .innerJoin(detections, eq(detections.id, identifications.detectionId))
    .innerJoin(images, eq(images.id, detections.imageId))
    .innerJoin(deployments, eq(deployments.id, images.deploymentId))
    .where(
      and(
        eq(images.deploymentId, deploymentId),
        ctProjectFilter(filters.projectId != null ? [filters.projectId] : ctProjects),
        speciesCondition
      )
    )
    .orderBy(desc(images.exifTimestamp), asc(images.id))
    .limit(PAGE_SIZE)
    .offset(offset);

  if (imageRows.length === 0) {
    return {
      success: true,
      data: { items: [], totalPages: 0, currentPage: 1 },
    };
  }

  // Fetch all detections for these images (so bounding boxes render).
  const imageIds = imageRows.map((r) => r.id);
  const detRows = await db
    .select({
      id: detections.id,
      imageId: detections.imageId,
      detectionConfidence: detections.detectionConfidence,
      detectionClass: detections.detectionClass,
    })
    .from(detections)
    .where(inArray(detections.imageId, imageIds));

  const identRows = await db
    .select({
      id: identifications.id,
      detectionId: identifications.detectionId,
      species: identifications.species,
      confidence: identifications.confidence,
      correctedSpecies: identifications.correctedSpecies,
      verificationStatus: identifications.verificationStatus,
    })
    .from(identifications)
    .where(
      inArray(
        identifications.detectionId,
        detRows.map((d) => d.id)
      )
    );

  const identByDet = new Map<number, (typeof identRows)[number]>();
  for (const i of identRows) identByDet.set(i.detectionId, i);

  const detsByImg = new Map<number, ImageGridItem["detections"]>();
  for (const d of detRows) {
    const ident = identByDet.get(d.id);
    const effective =
      ident?.verificationStatus === "corrected"
        ? ident.correctedSpecies
        : ident?.species ?? null;
    const arr = detsByImg.get(d.imageId) ?? [];
    arr.push({
      id: d.id,
      species: effective,
      confidence: ident?.confidence ?? null,
      detectionConfidence: d.detectionConfidence,
      detectionClass: d.detectionClass,
      verificationStatus: ident?.verificationStatus,
    });
    detsByImg.set(d.imageId, arr);
  }

  const items: ImageGridItem[] = imageRows.map((r) => ({
    id: r.id,
    filename: r.filename,
    path: r.path,
    status: r.status,
    thumbnailPath: r.thumbnailPath,
    videoId: r.videoId,
    frameIndex: r.frameIndex,
    confirmedBlank: r.confirmedBlank,
    starred: r.starred,
    setupTag: r.setupTag,
    detections: detsByImg.get(r.id) ?? [],
  }));

  return {
    success: true,
    data: { items, totalPages, currentPage: clampedPage },
  };
}

export { type SpeciesAggregate };
