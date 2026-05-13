import Link from "next/link";
import { notFound } from "next/navigation";
import { sql } from "drizzle-orm";
import { requirePermission } from "@/lib/auth";
import { requireDeploymentAccess } from "@/lib/camera-trap-auth";
import { db } from "@/db";
import {
  audioFiles,
  audioDetections,
  audioIdentifications,
  deployments,
  species,
} from "@/db/schema";
import { eq, and, asc } from "drizzle-orm";
import { AudioAnnotationClient } from "./annotation-client";
import { parseRecordingTimestamp } from "@/lib/audio-filename";
import { getFrequentAudioSpecies } from "@/app/audio/annotation-actions";
import {
  applyConfidenceFilter,
  parseThresholdParam,
} from "@/lib/audio-confidence";

interface PageProps {
  params: Promise<{ id: string; fileId: string }>;
  searchParams: Promise<{ conf?: string; showAll?: string }>;
}

export default async function AudioAnnotatePage({ params, searchParams }: PageProps) {
  const user = await requirePermission("grabaciones", "viewer");
  const { id, fileId } = await params;
  const { conf, showAll } = await searchParams;
  const deploymentId = parseInt(id, 10);
  const audioFileId = parseInt(fileId, 10);

  if (isNaN(deploymentId) || isNaN(audioFileId)) notFound();

  const threshold = parseThresholdParam(conf);
  const showAllMode = showAll === "1";

  await requireDeploymentAccess(user, deploymentId);

  const isEditor =
    user.globalRole === "super_admin" ||
    user.permissions.some(
      (p) =>
        p.projectId === "grabaciones" &&
        (p.role === "editor" || p.role === "admin")
    );

  // Fetch audio file
  const [audioFile] = await db
    .select()
    .from(audioFiles)
    .where(
      and(
        eq(audioFiles.id, audioFileId),
        eq(audioFiles.deploymentId, deploymentId)
      )
    );

  if (!audioFile) notFound();

  // Parse recording date/time from filename
  const recordingTs = parseRecordingTimestamp(audioFile.filename);

  // Fetch deployment name
  const [deployment] = await db
    .select({ name: deployments.name })
    .from(deployments)
    .where(eq(deployments.id, deploymentId));

  // Fetch existing detections with identifications.
  //
  // When showAllMode is on, fetch every detection box (including rejected and
  // sub-threshold) so the annotator can validate borderline cases. Otherwise
  // restrict to detections whose identification passes the shared filter.
  const visible = applyConfidenceFilter(threshold);
  const detectionsRaw = showAllMode
    ? await db
        .select()
        .from(audioDetections)
        .where(eq(audioDetections.audioFileId, audioFileId))
        .orderBy(asc(audioDetections.startTime))
    : await db
        .select()
        .from(audioDetections)
        .where(
          and(
            eq(audioDetections.audioFileId, audioFileId),
            sql`EXISTS (
              SELECT 1 FROM audio_identifications
              WHERE audio_identifications.audio_detection_id = ${audioDetections.id}
              AND ${visible}
            )`
          )
        )
        .orderBy(asc(audioDetections.startTime));

  // Fetch identifications per detection
  const detectionsWithIds = await Promise.all(
    detectionsRaw.map(async (det) => {
      const [ident] = await db
        .select()
        .from(audioIdentifications)
        .where(eq(audioIdentifications.audioDetectionId, det.id))
        .limit(1);

      return {
        id: det.id,
        startTime: det.startTime,
        endTime: det.endTime,
        minFreq: det.minFreq,
        maxFreq: det.maxFreq,
        detectionConfidence: det.confidence,
        modelVersion: det.modelVersion,
        identification: ident
          ? {
              id: ident.id,
              species: ident.species,
              confidence: ident.confidence,
              verificationStatus: ident.verificationStatus,
              correctedSpecies: ident.correctedSpecies,
            }
          : null,
      };
    })
  );

  // Fetch all file IDs in this deployment for prev/next navigation
  const allFiles = await db
    .select({ id: audioFiles.id })
    .from(audioFiles)
    .where(eq(audioFiles.deploymentId, deploymentId))
    .orderBy(asc(audioFiles.filename));

  const fileIds = allFiles.map((f) => f.id);
  const currentIndex = fileIds.indexOf(audioFileId);
  const prevFileId = currentIndex > 0 ? fileIds[currentIndex - 1] : null;
  const nextFileId =
    currentIndex < fileIds.length - 1 ? fileIds[currentIndex + 1] : null;

  // Fetch species list
  const speciesList = await db
    .select()
    .from(species)
    .orderBy(species.commonName);

  // Frequent species (hotkey slots 1-9), scoped to this deployment.
  const frequentResult = await getFrequentAudioSpecies(deploymentId, 9);
  const frequentSpecies = frequentResult.success ? frequentResult.data : [];

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Breadcrumb + navigation */}
      <div className="flex items-center justify-between px-4 py-2 border-b shrink-0">
        <div className="flex items-center gap-2 text-sm text-muted-foreground min-w-0">
          <Link href="/audio" className="hover:underline shrink-0">
            Grabaciones
          </Link>
          <span>/</span>
          <Link
            href={`/audio/${deploymentId}`}
            className="hover:underline truncate"
          >
            {deployment?.name ?? `Instalación ${deploymentId}`}
          </Link>
          <span>/</span>
          <span className="truncate font-medium text-foreground">
            {audioFile.filename}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-sm text-muted-foreground">
            {currentIndex + 1} de {fileIds.length}
          </span>
        </div>
      </div>

      <AudioAnnotationClient
        audioFileId={audioFileId}
        deploymentId={deploymentId}
        filename={audioFile.filename}
        driveFileId={audioFile.driveFileId}
        format={audioFile.format}
        detections={detectionsWithIds}
        speciesList={speciesList}
        frequentSpecies={frequentSpecies}
        isEditor={isEditor}
        prevFileId={prevFileId}
        nextFileId={nextFileId}
        currentIndex={currentIndex}
        totalFiles={fileIds.length}
        recordingDate={recordingTs?.date ?? null}
        recordingTime={recordingTs?.time ?? null}
      />
    </div>
  );
}
