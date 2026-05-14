/**
 * Server actions for the audio species browser.
 *
 * Mirrors src/app/camera-trap/species/actions.ts but uses audioIdentifications
 * and applies the read-time BirdNET confidence filter.
 */

"use server";

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  deployments,
  audioFiles,
  audioDetections,
  audioIdentifications,
  species,
  cameraTrapProjects,
} from "@/db/schema";
import {
  aggregateAudioBySpecies,
  aggregateAudioSpeciesSites,
  type AudioSiteAggregate,
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
import {
  applyConfidenceFilter,
  parseThresholdParam,
} from "@/lib/audio-confidence";
import type { ActionResult } from "@/lib/types";
import type { Species } from "@/db/schema";
import type {
  ProjectOption,
  SpeciesIndexRow,
  SiteSummary,
} from "@/app/camera-trap/species/actions";

const PAGE_SIZE = 24;

export interface AudioDetectionRow {
  detectionId: number;
  audioFileId: number;
  driveFileId: string;
  deploymentId: number;
  filename: string;
  startTime: number;
  endTime: number;
  minFreq: number;
  maxFreq: number;
  duration: number | null;
  confidence: number | null;
  verificationStatus: string;
  recordingDate: string | null;
  recordingTime: string | null;
}

export interface AudioSpeciesDetailData {
  species: Species;
  totalCount: number;
  sites: SiteSummary[];
  sitesWithoutLocation: SiteSummary[];
  availableProjects: ProjectOption[];
  threshold: number;
}

export interface AudioSitePageData {
  items: AudioDetectionRow[];
  totalPages: number;
  currentPage: number;
}

// ---------------------------------------------------------------------------
// Species index
// ---------------------------------------------------------------------------

export async function getAudioSpeciesIndex(
  searchParams: Record<string, string | string[] | undefined>
): Promise<ActionResult<SpeciesIndexRow[]>> {
  const user = await requirePermission("grabaciones", "viewer");
  const ctProjects = await getUserCameraTrapProjects(user);
  const threshold = parseThresholdParam(searchParams.conf);

  const aggregates = await aggregateAudioBySpecies(ctProjects, threshold);
  const names = [...aggregates.keys()];
  const speciesRows = names.length
    ? await db.select().from(species).where(inArray(species.scientificName, names))
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
// Detail
// ---------------------------------------------------------------------------

interface DetailFilters {
  statuses: VerificationStatus[];
  projectId: number | null;
  threshold: number;
}

function readDetailFilters(
  searchParams: Record<string, string | string[] | undefined>,
  ctProjects: number[] | "all"
): DetailFilters {
  return {
    statuses: parseStatuses(searchParams.status),
    projectId: parseProjectId(searchParams.project, ctProjects),
    threshold: parseThresholdParam(searchParams.conf),
  };
}

export async function getAudioSpeciesDetail(
  slug: string,
  searchParams: Record<string, string | string[] | undefined>
): Promise<ActionResult<AudioSpeciesDetailData | null>> {
  const user = await requirePermission("grabaciones", "viewer");
  const ctProjects = await getUserCameraTrapProjects(user);

  const target = await resolveSpeciesFromSlug(slug);
  if (!target) return { success: true, data: null };

  const filters = readDetailFilters(searchParams, ctProjects);
  const filteredProjects =
    filters.projectId != null ? [filters.projectId] : ctProjects;

  const sitesRaw = await aggregateAudioSpeciesSites(
    target.scientificName,
    filteredProjects,
    filters.threshold,
    filters.statuses
  );

  const toSummary = (s: AudioSiteAggregate): SiteSummary => ({
    deploymentId: s.deploymentId,
    deploymentName: s.deploymentName,
    latitude: s.latitude,
    longitude: s.longitude,
    cameraTrapProjectId: s.cameraTrapProjectId,
    detectionCount: s.detectionCount,
    lastSeen: s.lastSeen,
  });

  const sitesWithLoc = sitesRaw
    .filter((s) => s.latitude != null && s.longitude != null)
    .map(toSummary)
    .sort(
      (a, b) =>
        b.detectionCount - a.detectionCount ||
        a.deploymentName.localeCompare(b.deploymentName)
    );
  const sitesWithoutLoc = sitesRaw
    .filter((s) => s.latitude == null || s.longitude == null)
    .map(toSummary)
    .sort(
      (a, b) =>
        b.detectionCount - a.detectionCount ||
        a.deploymentName.localeCompare(b.deploymentName)
    );
  const totalCount = sitesRaw.reduce((acc, s) => acc + s.detectionCount, 0);

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
      threshold: filters.threshold,
    },
  };
}

// ---------------------------------------------------------------------------
// Per-site page
// ---------------------------------------------------------------------------

export async function getAudioSpeciesSitePage(
  slug: string,
  deploymentId: number,
  page: number,
  searchParams: Record<string, string | string[] | undefined>
): Promise<ActionResult<AudioSitePageData>> {
  const user = await requirePermission("grabaciones", "viewer");
  const ctProjects = await getUserCameraTrapProjects(user);

  const target = await resolveSpeciesFromSlug(slug);
  if (!target) return { success: false, error: "Especie no encontrada." };

  const filters = readDetailFilters(searchParams, ctProjects);
  const safePage = parsePositiveInt(String(page), 1);

  const statusSet = new Set(filters.statuses);
  const acceptsActive =
    statusSet.has("verified") || statusSet.has("unverified");
  const acceptsCorrected = statusSet.has("corrected");
  const conf = applyConfidenceFilter(filters.threshold);

  const orConditions: Array<ReturnType<typeof and>> = [];
  if (acceptsActive) {
    const allowed = [
      ...(statusSet.has("verified") ? (["verified"] as const) : []),
      ...(statusSet.has("unverified") ? (["unverified"] as const) : []),
    ];
    orConditions.push(
      and(
        inArray(audioIdentifications.verificationStatus, [...allowed]),
        eq(audioIdentifications.species, target.scientificName)
      )
    );
  }
  if (acceptsCorrected) {
    orConditions.push(
      and(
        eq(audioIdentifications.verificationStatus, "corrected"),
        eq(audioIdentifications.correctedSpecies, target.scientificName)
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

  const filterProjects =
    filters.projectId != null ? [filters.projectId] : ctProjects;

  // Count for pagination
  const totalRow = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(audioIdentifications)
    .innerJoin(
      audioDetections,
      eq(audioDetections.id, audioIdentifications.audioDetectionId)
    )
    .innerJoin(audioFiles, eq(audioFiles.id, audioDetections.audioFileId))
    .innerJoin(deployments, eq(deployments.id, audioFiles.deploymentId))
    .where(
      and(
        eq(audioFiles.deploymentId, deploymentId),
        ctProjectFilter(filterProjects),
        conf,
        speciesCondition
      )
    );
  const total = Number(totalRow[0]?.count ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const clampedPage = Math.min(safePage, totalPages);
  const offset = (clampedPage - 1) * PAGE_SIZE;

  const rows = await db
    .select({
      detectionId: audioDetections.id,
      audioFileId: audioFiles.id,
      driveFileId: audioFiles.driveFileId,
      deploymentId: audioFiles.deploymentId,
      filename: audioFiles.filename,
      duration: audioFiles.duration,
      startTime: audioDetections.startTime,
      endTime: audioDetections.endTime,
      minFreq: audioDetections.minFreq,
      maxFreq: audioDetections.maxFreq,
      confidence: audioIdentifications.confidence,
      verificationStatus: audioIdentifications.verificationStatus,
    })
    .from(audioIdentifications)
    .innerJoin(
      audioDetections,
      eq(audioDetections.id, audioIdentifications.audioDetectionId)
    )
    .innerJoin(audioFiles, eq(audioFiles.id, audioDetections.audioFileId))
    .innerJoin(deployments, eq(deployments.id, audioFiles.deploymentId))
    .where(
      and(
        eq(audioFiles.deploymentId, deploymentId),
        ctProjectFilter(filterProjects),
        conf,
        speciesCondition
      )
    )
    .orderBy(desc(audioFiles.modifiedAt), asc(audioDetections.startTime))
    .limit(PAGE_SIZE)
    .offset(offset);

  // Drop rows lacking a driveFileId — they cannot be streamed (the audio
  // stream API resolves files by their Google Drive ID).
  const items: AudioDetectionRow[] = rows
    .filter((r): r is typeof r & { driveFileId: string } => r.driveFileId != null)
    .map((r) => {
    const ts = parseRecordingTimestamp(r.filename);
    return {
      detectionId: r.detectionId,
      audioFileId: r.audioFileId,
      driveFileId: r.driveFileId,
      deploymentId: r.deploymentId,
      filename: r.filename,
      startTime: r.startTime,
      endTime: r.endTime,
      minFreq: r.minFreq,
      maxFreq: r.maxFreq,
      duration: r.duration,
      confidence: r.confidence,
      verificationStatus: r.verificationStatus,
      recordingDate: ts?.date ?? null,
      recordingTime: ts?.time ?? null,
    };
  });

  return {
    success: true,
    data: { items, totalPages, currentPage: clampedPage },
  };
}

// Local copy of the filename parser to keep the action file self-contained
// (avoids a cross-cutting import in a "use server" file).
function parseRecordingTimestamp(
  filename: string
): { date: string; time: string } | null {
  const match = filename.match(
    /_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\./
  );
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  return { date: `${y}-${mo}-${d}`, time: `${h}:${mi}:${s}` };
}
