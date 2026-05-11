/**
 * Lightweight endpoint returning any active (pending/processing) jobs.
 * Polled by the FloatingJobProgress component every 3s.
 *
 * Auth: requires a logged-in user with at least viewer access to the
 * "camera-trap" project. Users without access get an empty array (no leak).
 * Each job carries `canCancel` so the UI can hide the cancel button for
 * viewers (cancelJob/cancelQueue server actions also enforce editor+).
 */

import { db } from "@/db";
import { processingJobs, deployments, cameraTrapProjects } from "@/db/schema";
import { inArray } from "drizzle-orm";
import { getCurrentUser, hasProjectAccess } from "@/lib/auth";

export const dynamic = "force-dynamic";

const CAMERA_TRAP = "camera-trap";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!hasProjectAccess(user, CAMERA_TRAP)) {
    return Response.json([]);
  }

  const isSuperAdmin = user.globalRole === "super_admin";
  const role = user.permissions.find((p) => p.projectId === CAMERA_TRAP)?.role;
  const canCancel = isSuperAdmin || role === "editor" || role === "admin";

  const activeJobs = await db
    .select()
    .from(processingJobs)
    .where(inArray(processingJobs.status, ["pending", "processing"]));

  if (activeJobs.length === 0) {
    return Response.json([]);
  }

  const deploymentIds = [
    ...new Set(activeJobs.map((j) => j.deploymentId).filter((id): id is number => id != null)),
  ];
  const ctProjectIds = [
    ...new Set(
      activeJobs.map((j) => j.cameraTrapProjectId).filter((id): id is number => id != null)
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

  const result = activeJobs.map((job) => {
    const deploymentName =
      job.deploymentId != null ? deploymentMap.get(job.deploymentId) ?? null : null;
    const ctProjectName =
      job.cameraTrapProjectId != null
        ? ctProjectMap.get(job.cameraTrapProjectId) ?? null
        : null;

    const displayName =
      deploymentName ??
      ctProjectName ??
      (job.jobType === "drive_sync"
        ? "Sincronización con Drive"
        : job.jobType === "audio_sync"
          ? "Sincronización de audio"
          : job.jobType === "acoustic_indices"
            ? "Índices acústicos"
            : "Trabajo");

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
      statusMessage: job.statusMessage,
      startedAt: job.startedAt?.toISOString() ?? null,
      downloadedImages: job.downloadedImages ?? 0,
      downloadTotal: job.downloadTotal ?? 0,
      cachedImages: job.cachedImages ?? 0,
      canCancel,
    };
  });

  return Response.json(result);
}
