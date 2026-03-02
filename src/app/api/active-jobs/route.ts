/**
 * Lightweight endpoint returning any active (pending/processing) jobs.
 * Polled by the FloatingJobProgress component every 3s.
 */

import { db } from "@/db";
import { processingJobs, deployments } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
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
  }));

  return Response.json(result);
}
