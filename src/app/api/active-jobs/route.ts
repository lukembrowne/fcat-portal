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
import { processingJobs, deployments } from "@/db/schema";
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

  const deploymentIds = [...new Set(activeJobs.map((j) => j.deploymentId))];
  const deploymentRows = await db
    .select({ id: deployments.id, name: deployments.name })
    .from(deployments)
    .where(inArray(deployments.id, deploymentIds));

  const deploymentMap = new Map(deploymentRows.map((d) => [d.id, d.name]));

  const result = activeJobs.map((job) => ({
    jobId: job.id,
    deploymentId: job.deploymentId,
    deploymentName: deploymentMap.get(job.deploymentId) || "Desconocida",
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
  }));

  return Response.json(result);
}
