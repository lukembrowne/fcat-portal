import { requirePermission } from "@/lib/auth";
import { requireDeploymentAccess } from "@/lib/camera-trap-auth";
import { db } from "@/db";
import {
  deployments,
  cameraTrapProjects,
  processingJobs,
  audioDetections,
  audioIdentifications,
  audioFiles,
  species,
} from "@/db/schema";
import { aggregateAudioSpeciesForDeployment } from "@/db/effective-species";
import type { SpeciesTableRow } from "./species-detection-table";
import { eq, and, sql, desc, inArray, count as drizzleCount } from "drizzle-orm";
import { notFound } from "next/navigation";
import { fetchAudioFiles } from "../actions";
import { RecordingsShell } from "./recordings-shell";
import {
  applyConfidenceFilter,
  parseThresholdParam,
} from "@/lib/audio-confidence";

export default async function AudioDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ conf?: string }>;
}) {
  const user = await requirePermission("grabaciones", "viewer");

  const { id } = await params;
  const deploymentId = parseInt(id, 10);
  if (isNaN(deploymentId)) notFound();

  const { conf } = await searchParams;
  const threshold = parseThresholdParam(conf);

  await requireDeploymentAccess(user, deploymentId);

  const isEditor =
    user.globalRole === "super_admin" ||
    user.permissions.some(
      (p) =>
        p.projectId === "grabaciones" &&
        (p.role === "editor" || p.role === "admin")
    );

  const isAdmin =
    user.globalRole === "super_admin" ||
    user.permissions.some(
      (p) => p.projectId === "grabaciones" && p.role === "admin",
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

  const filesResult = await fetchAudioFiles(deploymentId, { threshold });

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

  // Check for active combined audio-analysis job
  const [activeAudioAnalysisJob] = await db
    .select({ id: processingJobs.id })
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.deploymentId, deploymentId),
        eq(processingJobs.jobType, "audio_analysis"),
        inArray(processingJobs.status, ["pending", "processing"])
      )
    )
    .limit(1);

  // Check for active compression / revert job (drives menu-item disabled state)
  const [activeCompressionJob] = await db
    .select({ id: processingJobs.id })
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.deploymentId, deploymentId),
        inArray(processingJobs.jobType, [
          "audio_compression",
          "revert_audio_compression",
        ]),
        inArray(processingJobs.status, ["pending", "processing"]),
      ),
    )
    .limit(1);

  // Aggregate WAV / revertible counts so the menu can hide actions that
  // would no-op. Matches the per-row aggregation in `fetchAudioDeployments`.
  const [uncompressedRow] = await db
    .select({ cnt: drizzleCount() })
    .from(audioFiles)
    .where(
      and(
        eq(audioFiles.deploymentId, deploymentId),
        eq(audioFiles.compressed, false),
        sql`${audioFiles.driveFileId} IS NOT NULL`,
        sql`lower(${audioFiles.filename}) LIKE '%.wav'`,
      ),
    );
  const uncompressedFileCount = uncompressedRow?.cnt ?? 0;

  const [revertibleRow] = await db
    .select({ cnt: drizzleCount() })
    .from(audioFiles)
    .where(
      and(
        eq(audioFiles.deploymentId, deploymentId),
        eq(audioFiles.compressed, true),
        sql`${audioFiles.driveFileId} IS NOT NULL`,
        sql`${audioFiles.originalDriveRevisionId} IS NOT NULL`,
      ),
    );
  const revertibleFileCount = revertibleRow?.cnt ?? 0;

  // Get last completed BirdNET job stats. BirdNET detections are produced by
  // either a standalone `birdnet` job or the combined `audio_analysis` job —
  // both call runBirdNETAnalysis(jobId, …) and stamp detections with their own
  // job id. Match both (mirrors the canonical query in audio/actions.ts) so
  // deployments analyzed via the combined job are not treated as "unanalyzed".
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
        inArray(processingJobs.jobType, ["birdnet", "audio_analysis"]),
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
    const visible = applyConfidenceFilter(threshold);
    const [detStats] = await db
      .select({
        totalDetections: sql<number>`COUNT(DISTINCT ${audioDetections.id})`,
        totalSpecies: sql<number>`COUNT(DISTINCT ${audioIdentifications.species})`,
        verified: sql<number>`SUM(CASE WHEN ${audioIdentifications.verificationStatus} = 'verified' THEN 1 ELSE 0 END)`,
        pending: sql<number>`SUM(CASE WHEN ${audioIdentifications.verificationStatus} = 'unverified' AND (${audioIdentifications.confidence} IS NULL OR ${audioIdentifications.confidence} >= ${threshold}) THEN 1 ELSE 0 END)`,
      })
      .from(audioDetections)
      .innerJoin(
        audioIdentifications,
        eq(audioIdentifications.audioDetectionId, audioDetections.id)
      )
      .where(and(eq(audioDetections.jobId, lastBirdnetJob.id), visible));

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
  } else if (activeBirdnetJob || activeAudioAnalysisJob) {
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

  // Per-species roster for the table below the raster. Honors the same ?conf=
  // threshold so it updates with the confidence slider. Display names are joined
  // from the species table (mirrors src/app/audio/species/actions.ts).
  let speciesTableRows: SpeciesTableRow[] = [];
  if (lastBirdnetJob) {
    const aggregates = await aggregateAudioSpeciesForDeployment(
      deploymentId,
      threshold,
    );
    const names = aggregates.map((a) => a.scientificName);
    const speciesRows = names.length
      ? await db
          .select()
          .from(species)
          .where(inArray(species.scientificName, names))
      : [];
    const byName = new Map(speciesRows.map((s) => [s.scientificName, s]));
    speciesTableRows = aggregates.map((a) => {
      const sp = byName.get(a.scientificName);
      return {
        scientificName: a.scientificName,
        spanishName: sp?.spanishName ?? null,
        commonName: sp?.commonName ?? null,
        detectionCount: a.detectionCount,
        avgConfidence: a.avgConfidence,
      };
    });
  }

  return (
    <RecordingsShell
      deployment={deployment}
      files={files}
      isEditor={isEditor}
      isAdmin={isAdmin}
      displayStatus={displayStatus}
      isBirdnetProcessing={!!activeBirdnetJob}
      birdnetStats={birdnetStats}
      hasBirdnetDetections={hasBirdnetDetections}
      isAcousticIndicesProcessing={!!activeIndicesJob}
      isAudioAnalysisProcessing={!!activeAudioAnalysisJob}
      isAudioCompressionProcessing={!!activeCompressionJob}
      uncompressedFileCount={uncompressedFileCount}
      revertibleFileCount={revertibleFileCount}
      reviewStats={reviewStats}
      speciesRows={speciesTableRows}
      speciesAnalyzed={!!lastBirdnetJob}
    />
  );
}
