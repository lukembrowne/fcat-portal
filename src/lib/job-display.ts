import "server-only";

import { db } from "@/db";
import {
  processingJobs,
  deployments,
  cameraTrapProjects,
  type ProcessingJob,
} from "@/db/schema";
import { inArray } from "drizzle-orm";

/**
 * Unified job-row projection used by `/api/active-jobs` (HTTP polling for the
 * floating widget) and `/admin/jobs` (admin page). Keeps the two in lockstep
 * — labels, fallbacks, and field shape live here.
 */
export type JobDisplayRow = {
  jobId: number;
  deploymentId: number | null;
  deploymentName: string;
  cameraTrapProjectId: number | null;
  cameraTrapProjectName: string | null;
  displayName: string;
  status: string;
  jobType: string;
  totalImages: number;
  processedImages: number;
  failedImages: number;
  statusMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  createdBy: string | null;
  errorMessage: string | null;
  downloadedImages: number;
  downloadTotal: number;
  cachedImages: number;
  canCancel: boolean;
};

function fallbackDisplayName(jobType: string): string {
  switch (jobType) {
    case "drive_sync":
      return "Sincronización con Drive";
    case "audio_sync":
      return "Sincronización de audio";
    case "acoustic_indices":
      return "Índices acústicos";
    case "audio_analysis":
      return "Análisis acústico";
    case "audio_compression":
      return "Compresión de audio (FLAC)";
    case "revert_audio_compression":
      return "Reversión de compresión de audio";
    default:
      return "Trabajo";
  }
}

/**
 * Project a set of `processing_jobs` rows into the display shape used by the
 * UI. Performs a single batched lookup for deployment + camera-trap project
 * names. Pass `canCancel` from the caller's auth context (it's the same value
 * for all rows in a request).
 */
export async function projectJobsForDisplay(
  jobs: ProcessingJob[],
  canCancel: boolean,
): Promise<JobDisplayRow[]> {
  if (jobs.length === 0) return [];

  const deploymentIds = [
    ...new Set(
      jobs.map((j) => j.deploymentId).filter((id): id is number => id != null),
    ),
  ];
  const ctProjectIds = [
    ...new Set(
      jobs
        .map((j) => j.cameraTrapProjectId)
        .filter((id): id is number => id != null),
    ),
  ];

  const [deploymentRows, ctProjectRows] = await Promise.all([
    deploymentIds.length
      ? db
          .select({ id: deployments.id, name: deployments.name })
          .from(deployments)
          .where(inArray(deployments.id, deploymentIds))
      : Promise.resolve([]),
    ctProjectIds.length
      ? db
          .select({ id: cameraTrapProjects.id, name: cameraTrapProjects.name })
          .from(cameraTrapProjects)
          .where(inArray(cameraTrapProjects.id, ctProjectIds))
      : Promise.resolve([]),
  ]);

  const deploymentMap = new Map(deploymentRows.map((d) => [d.id, d.name]));
  const ctProjectMap = new Map(ctProjectRows.map((p) => [p.id, p.name]));

  return jobs.map((job) => {
    const deploymentName =
      job.deploymentId != null
        ? deploymentMap.get(job.deploymentId) ?? null
        : null;
    const ctProjectName =
      job.cameraTrapProjectId != null
        ? ctProjectMap.get(job.cameraTrapProjectId) ?? null
        : null;

    const displayName =
      deploymentName ?? ctProjectName ?? fallbackDisplayName(job.jobType);

    return {
      jobId: job.id,
      deploymentId: job.deploymentId,
      deploymentName: deploymentName ?? "Desconocida",
      cameraTrapProjectId: job.cameraTrapProjectId,
      cameraTrapProjectName: ctProjectName,
      displayName,
      status: job.status,
      jobType: job.jobType,
      totalImages: job.totalImages,
      processedImages: job.processedImages,
      failedImages: job.failedImages,
      statusMessage: job.statusMessage,
      startedAt: job.startedAt?.toISOString() ?? null,
      completedAt: job.completedAt?.toISOString() ?? null,
      createdAt: job.createdAt.toISOString(),
      createdBy: job.createdBy ?? null,
      errorMessage: job.errorMessage ?? null,
      downloadedImages: job.downloadedImages ?? 0,
      downloadTotal: job.downloadTotal ?? 0,
      cachedImages: job.cachedImages ?? 0,
      canCancel,
    };
  });
}

/** Fetch + project active jobs (pending or processing). */
export async function listActiveJobsForDisplay(
  canCancel: boolean,
): Promise<JobDisplayRow[]> {
  const rows = await db
    .select()
    .from(processingJobs)
    .where(inArray(processingJobs.status, ["pending", "processing"]));
  return projectJobsForDisplay(rows, canCancel);
}
