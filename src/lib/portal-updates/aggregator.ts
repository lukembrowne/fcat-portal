import "server-only";
import { and, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  audioDetections,
  audioFiles,
  audioIdentifications,
  deployments,
  detections,
  identifications,
  images,
  processingJobs,
  projects,
} from "@/db/schema";
import { JOB_TYPES, type JobType } from "@/lib/job-types";
import { JOB_LABELS } from "@/lib/system-events";
import type {
  JobDetail,
  LeaderboardRow,
  PortalUpdatesPayload,
  ProjectActivity,
} from "./types";

const AUDIO_JOB_TYPES = new Set<JobType>([
  JOB_TYPES.BIRDNET,
  JOB_TYPES.ACOUSTIC_INDICES,
  JOB_TYPES.AUDIO_ANALYSIS,
  JOB_TYPES.AUDIO_SYNC,
  JOB_TYPES.AUDIO_COMPRESSION,
  JOB_TYPES.REVERT_AUDIO_COMPRESSION,
]);

const VERIFIED_STATUSES = ["verified", "corrected"] as const;

const TOP_VERIFICADORES_LIMIT = 3;

type JobRow = {
  jobId: number;
  projectId: string;
  deploymentName: string;
  siteName: string | null;
  jobType: string;
  status: "completed" | "failed";
  totalImages: number;
  processedImages: number;
  failedImages: number;
  totalVideos: number;
  extractedFrames: number;
  startedAt: Date | null;
  completedAt: Date | null;
  detectorModel: string | null;
  classifierModel: string | null;
  errorMessage: string | null;
};

type VerifyRow = {
  projectId: string;
  verifiedBy: string;
  distinctTargets: number;
};

type ProjectTotalRow = {
  projectId: string;
  distinctTargets: number;
};

type ProjectRow = {
  id: string;
  name: string;
};

export async function buildPortalUpdatesPayload(
  windowStart: Date,
  windowEnd: Date,
): Promise<PortalUpdatesPayload> {
  const [
    jobRows,
    ctVerifyByUser,
    ctVerifyByProject,
    audioVerifyByUser,
    audioVerifyByProject,
    projectRows,
  ] = await Promise.all([
    queryJobActivity(windowStart, windowEnd),
    queryCtVerifyByUser(windowStart, windowEnd),
    queryCtVerifyByProject(windowStart, windowEnd),
    queryAudioVerifyByUser(windowStart, windowEnd),
    queryAudioVerifyByProject(windowStart, windowEnd),
    queryProjects(),
  ]);

  const projectsById = new Map(projectRows.map((p) => [p.id, p.name] as const));

  const ctJobsByProject = bucketJobs(jobRows, (jt) => !AUDIO_JOB_TYPES.has(jt));
  const audioJobsByProject = bucketJobs(jobRows, (jt) => AUDIO_JOB_TYPES.has(jt));

  const ctVerifiedByProject = sumByProject(ctVerifyByProject);
  const audioVerifiedByProject = sumByProject(audioVerifyByProject);

  const ctLeaderboardByProject = leaderboardByProject(ctVerifyByUser);
  const audioLeaderboardByProject = leaderboardByProject(audioVerifyByUser);

  const projectIds = new Set<string>([
    ...ctJobsByProject.keys(),
    ...audioJobsByProject.keys(),
    ...ctVerifiedByProject.keys(),
    ...audioVerifiedByProject.keys(),
  ]);

  const activeProjects: ProjectActivity[] = [];
  for (const projectId of projectIds) {
    const projectName = projectsById.get(projectId);
    if (!projectName) continue; // orphan project_id (shouldn't happen — FK)

    activeProjects.push({
      projectId,
      projectName,
      ctJobs: ctJobsByProject.get(projectId) ?? [],
      audioJobs: audioJobsByProject.get(projectId) ?? [],
      ctVerifiedImages: ctVerifiedByProject.get(projectId) ?? 0,
      ctTopVerificadores: ctLeaderboardByProject.get(projectId) ?? [],
      audioVerifiedFiles: audioVerifiedByProject.get(projectId) ?? 0,
      audioTopVerificadores: audioLeaderboardByProject.get(projectId) ?? [],
    });
  }

  activeProjects.sort((a, b) => a.projectName.localeCompare(b.projectName));

  const totalCtJobs = sumBucketCounts(ctJobsByProject);
  const totalAudioJobs = sumBucketCounts(audioJobsByProject);
  const totalCtVerifiedImages = sumValues(ctVerifiedByProject);
  const totalAudioVerifiedFiles = sumValues(audioVerifiedByProject);

  return {
    windowStart,
    windowEnd,
    projects: activeProjects,
    totalCtJobs,
    totalAudioJobs,
    totalCtVerifiedImages,
    totalAudioVerifiedFiles,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

async function queryJobActivity(
  windowStart: Date,
  windowEnd: Date,
): Promise<JobRow[]> {
  // One row per job (no aggregation) so the email can show per-job detail:
  // deployment, images/videos processed, duration, model, status.
  //
  // Rows with NULL deployment_id are skipped (no project to attribute them to).
  // Project-level jobs (cameraTrapProjectId, no deployment) are rare and only
  // exist for cross-deployment ML reruns; we accept the small undercount in v1.
  const rows = await db
    .select({
      jobId: processingJobs.id,
      projectId: deployments.projectId,
      deploymentName: deployments.name,
      siteName: deployments.siteName,
      jobType: processingJobs.jobType,
      status: processingJobs.status,
      totalImages: processingJobs.totalImages,
      processedImages: processingJobs.processedImages,
      failedImages: processingJobs.failedImages,
      totalVideos: processingJobs.totalVideos,
      extractedFrames: processingJobs.extractedFrames,
      startedAt: processingJobs.startedAt,
      completedAt: processingJobs.completedAt,
      detectorModel: processingJobs.detectorModel,
      classifierModel: processingJobs.classifierModel,
      errorMessage: processingJobs.errorMessage,
    })
    .from(processingJobs)
    .innerJoin(deployments, eq(processingJobs.deploymentId, deployments.id))
    .where(
      and(
        gte(processingJobs.completedAt, windowStart),
        lt(processingJobs.completedAt, windowEnd),
        inArray(processingJobs.status, ["completed", "failed"]),
      ),
    )
    .all();

  const out: JobRow[] = [];
  for (const r of rows) {
    if (r.projectId === null) continue;
    if (r.status !== "completed" && r.status !== "failed") continue;
    out.push({
      jobId: r.jobId,
      projectId: r.projectId,
      deploymentName: r.deploymentName,
      siteName: r.siteName,
      jobType: r.jobType,
      status: r.status,
      totalImages: r.totalImages ?? 0,
      processedImages: r.processedImages ?? 0,
      failedImages: r.failedImages ?? 0,
      totalVideos: r.totalVideos ?? 0,
      extractedFrames: r.extractedFrames ?? 0,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      detectorModel: r.detectorModel,
      classifierModel: r.classifierModel,
      errorMessage: r.errorMessage,
    });
  }
  return out;
}

async function queryCtVerifyByUser(
  windowStart: Date,
  windowEnd: Date,
): Promise<VerifyRow[]> {
  const rows = await db
    .select({
      projectId: deployments.projectId,
      verifiedBy: identifications.verifiedBy,
      distinctTargets: sql<number>`COUNT(DISTINCT ${images.id})`,
    })
    .from(identifications)
    .innerJoin(detections, eq(identifications.detectionId, detections.id))
    .innerJoin(images, eq(detections.imageId, images.id))
    .innerJoin(deployments, eq(images.deploymentId, deployments.id))
    .where(
      and(
        gte(identifications.verifiedAt, windowStart),
        lt(identifications.verifiedAt, windowEnd),
        inArray(identifications.verificationStatus, [...VERIFIED_STATUSES]),
        isNotNull(identifications.verifiedBy),
      ),
    )
    .groupBy(deployments.projectId, identifications.verifiedBy)
    .all();

  const out: VerifyRow[] = [];
  for (const r of rows) {
    if (r.projectId === null || r.verifiedBy === null) continue;
    out.push({
      projectId: r.projectId,
      verifiedBy: r.verifiedBy,
      distinctTargets: r.distinctTargets,
    });
  }
  return out;
}

async function queryCtVerifyByProject(
  windowStart: Date,
  windowEnd: Date,
): Promise<ProjectTotalRow[]> {
  const rows = await db
    .select({
      projectId: deployments.projectId,
      distinctTargets: sql<number>`COUNT(DISTINCT ${images.id})`,
    })
    .from(identifications)
    .innerJoin(detections, eq(identifications.detectionId, detections.id))
    .innerJoin(images, eq(detections.imageId, images.id))
    .innerJoin(deployments, eq(images.deploymentId, deployments.id))
    .where(
      and(
        gte(identifications.verifiedAt, windowStart),
        lt(identifications.verifiedAt, windowEnd),
        inArray(identifications.verificationStatus, [...VERIFIED_STATUSES]),
      ),
    )
    .groupBy(deployments.projectId)
    .all();

  return narrowProjectTotalRows(rows);
}

async function queryAudioVerifyByUser(
  windowStart: Date,
  windowEnd: Date,
): Promise<VerifyRow[]> {
  const rows = await db
    .select({
      projectId: deployments.projectId,
      verifiedBy: audioIdentifications.verifiedBy,
      distinctTargets: sql<number>`COUNT(DISTINCT ${audioFiles.id})`,
    })
    .from(audioIdentifications)
    .innerJoin(
      audioDetections,
      eq(audioIdentifications.audioDetectionId, audioDetections.id),
    )
    .innerJoin(audioFiles, eq(audioDetections.audioFileId, audioFiles.id))
    .innerJoin(deployments, eq(audioFiles.deploymentId, deployments.id))
    .where(
      and(
        gte(audioIdentifications.verifiedAt, windowStart),
        lt(audioIdentifications.verifiedAt, windowEnd),
        inArray(audioIdentifications.verificationStatus, [...VERIFIED_STATUSES]),
        isNotNull(audioIdentifications.verifiedBy),
      ),
    )
    .groupBy(deployments.projectId, audioIdentifications.verifiedBy)
    .all();

  const out: VerifyRow[] = [];
  for (const r of rows) {
    if (r.projectId === null || r.verifiedBy === null) continue;
    out.push({
      projectId: r.projectId,
      verifiedBy: r.verifiedBy,
      distinctTargets: r.distinctTargets,
    });
  }
  return out;
}

async function queryAudioVerifyByProject(
  windowStart: Date,
  windowEnd: Date,
): Promise<ProjectTotalRow[]> {
  const rows = await db
    .select({
      projectId: deployments.projectId,
      distinctTargets: sql<number>`COUNT(DISTINCT ${audioFiles.id})`,
    })
    .from(audioIdentifications)
    .innerJoin(
      audioDetections,
      eq(audioIdentifications.audioDetectionId, audioDetections.id),
    )
    .innerJoin(audioFiles, eq(audioDetections.audioFileId, audioFiles.id))
    .innerJoin(deployments, eq(audioFiles.deploymentId, deployments.id))
    .where(
      and(
        gte(audioIdentifications.verifiedAt, windowStart),
        lt(audioIdentifications.verifiedAt, windowEnd),
        inArray(audioIdentifications.verificationStatus, [...VERIFIED_STATUSES]),
      ),
    )
    .groupBy(deployments.projectId)
    .all();

  return narrowProjectTotalRows(rows);
}

function narrowProjectTotalRows(
  rows: Array<{ projectId: string | null; distinctTargets: number }>,
): ProjectTotalRow[] {
  const out: ProjectTotalRow[] = [];
  for (const r of rows) {
    if (r.projectId === null) continue;
    out.push({ projectId: r.projectId, distinctTargets: r.distinctTargets });
  }
  return out;
}

async function queryProjects(): Promise<ProjectRow[]> {
  return db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .all();
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

function bucketJobs(
  rows: JobRow[],
  predicate: (jt: JobType) => boolean,
): Map<string, JobDetail[]> {
  const byProject = new Map<string, JobDetail[]>();

  for (const row of rows) {
    const jt = row.jobType as JobType;
    if (!predicate(jt)) continue;
    if (!row.projectId) continue;

    const durationMs =
      row.startedAt && row.completedAt
        ? row.completedAt.getTime() - row.startedAt.getTime()
        : null;

    const detail: JobDetail = {
      jobId: row.jobId,
      deploymentName: row.deploymentName,
      siteName: row.siteName,
      jobType: jt,
      label: JOB_LABELS[jt] ?? jt,
      status: row.status,
      totalImages: row.totalImages,
      processedImages: row.processedImages,
      failedImages: row.failedImages,
      totalVideos: row.totalVideos,
      extractedFrames: row.extractedFrames,
      durationMs,
      detectorModel: row.detectorModel,
      classifierModel: row.classifierModel,
      errorMessage: row.errorMessage,
    };

    const list = byProject.get(row.projectId) ?? [];
    list.push(detail);
    byProject.set(row.projectId, list);
  }

  // Stable order within a project: label, then deployment, then jobId.
  for (const [projectId, list] of byProject) {
    list.sort((a, b) => {
      const byLabel = a.label.localeCompare(b.label);
      if (byLabel !== 0) return byLabel;
      const byDeployment = a.deploymentName.localeCompare(b.deploymentName);
      if (byDeployment !== 0) return byDeployment;
      return a.jobId - b.jobId;
    });
    byProject.set(projectId, list);
  }

  return byProject;
}

function sumByProject(rows: ProjectTotalRow[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    out.set(r.projectId, (out.get(r.projectId) ?? 0) + r.distinctTargets);
  }
  return out;
}

function leaderboardByProject(
  rows: VerifyRow[],
): Map<string, LeaderboardRow[]> {
  const byProject = new Map<string, LeaderboardRow[]>();

  for (const row of rows) {
    if (!row.projectId || !row.verifiedBy) continue;
    const list = byProject.get(row.projectId) ?? [];
    list.push({ actorEmail: row.verifiedBy, count: row.distinctTargets });
    byProject.set(row.projectId, list);
  }

  for (const [projectId, list] of byProject) {
    list.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.actorEmail.localeCompare(b.actorEmail);
    });
    byProject.set(projectId, list.slice(0, TOP_VERIFICADORES_LIMIT));
  }

  return byProject;
}

function sumBucketCounts(byProject: Map<string, JobDetail[]>): number {
  let total = 0;
  for (const jobs of byProject.values()) {
    total += jobs.length;
  }
  return total;
}

function sumValues(map: Map<string, number>): number {
  let total = 0;
  for (const v of map.values()) total += v;
  return total;
}
