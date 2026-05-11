import { requirePermission } from "@/lib/auth";
import { requireDeploymentAccess } from "@/lib/camera-trap-auth";
import { db } from "@/db";
import {
  deployments,
  cameraTrapProjects,
  processingJobs,
  audioDetections,
  audioIdentifications,
} from "@/db/schema";
import { eq, and, sql, desc, inArray } from "drizzle-orm";
import { notFound } from "next/navigation";
import { fetchAudioFiles } from "../actions";
import { AudioFilesShell } from "./audio-files-shell";

export default async function AudioDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await requirePermission("grabaciones", "viewer");

  const { id } = await params;
  const deploymentId = parseInt(id, 10);
  if (isNaN(deploymentId)) notFound();

  await requireDeploymentAccess(user, deploymentId);

  const isEditor =
    user.globalRole === "super_admin" ||
    user.permissions.some(
      (p) =>
        p.projectId === "grabaciones" &&
        (p.role === "editor" || p.role === "admin")
    );

  const [deployment] = await db
    .select({
      id: deployments.id,
      name: deployments.name,
      siteName: deployments.siteName,
      dateStart: deployments.dateStart,
      dateEnd: deployments.dateEnd,
      latitude: deployments.latitude,
      longitude: deployments.longitude,
      ctProjectName: cameraTrapProjects.name,
      excluded: deployments.excluded,
      qaNotes: deployments.qaNotes,
      fieldNotes: deployments.fieldNotes,
      uploadAudioFolderId: deployments.uploadAudioFolderId,
    })
    .from(deployments)
    .leftJoin(
      cameraTrapProjects,
      eq(deployments.cameraTrapProjectId, cameraTrapProjects.id)
    )
    .where(eq(deployments.id, deploymentId));

  if (!deployment) notFound();

  const filesResult = await fetchAudioFiles(deploymentId);

  // Check for active BirdNET job
  const [activeBirdnetJob] = await db
    .select({ id: processingJobs.id })
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.deploymentId, deploymentId),
        eq(processingJobs.jobType, "birdnet"),
        inArray(processingJobs.status, ["pending", "processing"])
      )
    )
    .limit(1);

  // Check for active acoustic-indices job
  const [activeIndicesJob] = await db
    .select({ id: processingJobs.id })
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.deploymentId, deploymentId),
        eq(processingJobs.jobType, "acoustic_indices"),
        inArray(processingJobs.status, ["pending", "processing"])
      )
    )
    .limit(1);

  // Get last completed BirdNET job stats
  const [lastBirdnetJob] = await db
    .select({
      id: processingJobs.id,
      completedAt: processingJobs.completedAt,
      statusMessage: processingJobs.statusMessage,
    })
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.deploymentId, deploymentId),
        eq(processingJobs.jobType, "birdnet"),
        eq(processingJobs.status, "completed")
      )
    )
    .orderBy(desc(processingJobs.completedAt))
    .limit(1);

  // Count BirdNET detections and verification status
  let birdnetStats: {
    totalDetections: number;
    totalSpecies: number;
    verified: number;
    pending: number;
  } | null = null;

  if (lastBirdnetJob) {
    const [detStats] = await db
      .select({
        totalDetections: sql<number>`COUNT(DISTINCT ${audioDetections.id})`,
        totalSpecies: sql<number>`COUNT(DISTINCT ${audioIdentifications.species})`,
        verified: sql<number>`SUM(CASE WHEN ${audioIdentifications.verificationStatus} = 'verified' THEN 1 ELSE 0 END)`,
        pending: sql<number>`SUM(CASE WHEN ${audioIdentifications.verificationStatus} = 'unverified' THEN 1 ELSE 0 END)`,
      })
      .from(audioDetections)
      .innerJoin(
        audioIdentifications,
        eq(audioIdentifications.audioDetectionId, audioDetections.id)
      )
      .where(eq(audioDetections.jobId, lastBirdnetJob.id));

    if (detStats) {
      birdnetStats = {
        totalDetections: detStats.totalDetections ?? 0,
        totalSpecies: detStats.totalSpecies ?? 0,
        verified: detStats.verified ?? 0,
        pending: detStats.pending ?? 0,
      };
    }
  }

  // Check if there are existing BirdNET detections (for re-run warning)
  const hasBirdnetDetections = birdnetStats !== null && birdnetStats.totalDetections > 0;
  const files = filesResult.success ? filesResult.data : [];
  const fileCount = files.length;

  // Compute audio deployment display status
  let displayStatus: string;
  if (fileCount === 0) {
    displayStatus = "unscanned";
  } else if (activeBirdnetJob) {
    displayStatus = "birdnet_processing";
  } else if (birdnetStats && birdnetStats.totalDetections > 0) {
    if (birdnetStats.pending === 0 && birdnetStats.verified > 0) {
      displayStatus = "reviewed";
    } else {
      displayStatus = "analyzed";
    }
  } else {
    displayStatus = "scanned";
  }

  const reviewStats = birdnetStats
    ? { verified: birdnetStats.verified, total: birdnetStats.verified + birdnetStats.pending }
    : null;

  return (
    <AudioFilesShell
      deployment={deployment}
      files={files}
      isEditor={isEditor}
      displayStatus={displayStatus}
      isBirdnetProcessing={!!activeBirdnetJob}
      birdnetStats={birdnetStats}
      hasBirdnetDetections={hasBirdnetDetections}
      isAcousticIndicesProcessing={!!activeIndicesJob}
      reviewStats={reviewStats}
    />
  );
}
