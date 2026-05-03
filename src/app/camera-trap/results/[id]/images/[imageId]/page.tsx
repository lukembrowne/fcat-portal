import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth";
import { getImageWithDetections, getJobImageIds, getSpeciesList, getFrequentSpecies, getDeploymentVerificationStats } from "@/app/camera-trap/actions";
import { db } from "@/db";
import { videos } from "@/db/schema";
import { eq } from "drizzle-orm";
import { ImageAnnotationClient } from "./image-annotation-client";

interface PageProps {
  params: Promise<{ id: string; imageId: string }>;
}

export default async function ImageDetailPage({ params }: PageProps) {
  const user = await requirePermission("camera-trap", "viewer");
  const canEdit = user.globalRole === "super_admin" ||
    user.permissions.some(
      (p) => p.projectId === "camera-trap" && (p.role === "editor" || p.role === "admin")
    );
  const { id, imageId } = await params;
  const jobId = parseInt(id, 10);
  const imgId = parseInt(imageId, 10);

  if (isNaN(jobId) || isNaN(imgId)) notFound();

  const data = await getImageWithDetections(imgId);
  if (!data) notFound();

  const { image, deploymentName, detections: rawDetections } = data;

  // Format timestamp for display
  const rawTimestamp = image.exifTimestamp
    ? new Date(image.exifTimestamp)
    : image.fileModified
      ? new Date(image.fileModified)
      : null;
  const timestamp =
    rawTimestamp && !isNaN(rawTimestamp.getTime())
      ? rawTimestamp.toLocaleDateString("es-EC", {
          day: "numeric",
          month: "short",
          year: "numeric",
        }) +
        ", " +
        rawTimestamp.toLocaleTimeString("es-EC", {
          hour: "2-digit",
          minute: "2-digit",
        })
      : null;

  // Verification stats are deployment-scoped, not per-job — the "X/Y revisadas"
  // header reflects review progress on the entire deployment so an incremental
  // ML run doesn't shrink the count to "0/2 revisadas".
  // Pass `null` for project-wide top-9 aggregated across all camera-trap
  // annotations. These drive the stable frecuentes hotkey slots (1-9) for
  // this page load; they do not reshuffle as the user annotates. Slot 0 is
  // reserved for "repeat last assigned species" (session-local).
  const [imageIds, speciesList, hotkeySlotsResult, verificationStats] = await Promise.all([
    getJobImageIds(jobId),
    getSpeciesList(),
    getFrequentSpecies(null, 9),
    getDeploymentVerificationStats(image.deploymentId),
  ]);
  const hotkeySlots = hotkeySlotsResult.success ? hotkeySlotsResult.data : [];
  const currentIndex = imageIds.indexOf(imgId);
  const prevImageId = currentIndex > 0 ? imageIds[currentIndex - 1] : null;
  const nextImageId =
    currentIndex < imageIds.length - 1 ? imageIds[currentIndex + 1] : null;

  const fullImageUrl = `/api/ct-images/${image.id}?size=full`;

  const boxes = rawDetections.map((det) => ({
    id: det.id,
    x: det.bboxX,
    y: det.bboxY,
    width: det.bboxWidth,
    height: det.bboxHeight,
    detectionConfidence: det.detectionConfidence,
    detectionClass: det.detectionClass,
    species: det.identification?.correctedSpecies || det.identification?.species || null,
    speciesConfidence: det.identification?.confidence || null,
    verificationStatus: det.identification?.verificationStatus || "unverified",
  }));

  const annotationDetections = rawDetections.map((det) => ({
    id: det.id,
    detectionClass: det.detectionClass,
    detectionConfidence: det.detectionConfidence,
    bboxX: det.bboxX,
    bboxY: det.bboxY,
    bboxWidth: det.bboxWidth,
    bboxHeight: det.bboxHeight,
    identification: det.identification
      ? {
          id: det.identification.id,
          species: det.identification.species,
          confidence: det.identification.confidence,
          verificationStatus: det.identification.verificationStatus,
          correctedSpecies: det.identification.correctedSpecies,
        }
      : null,
  }));

  return (
    <div className="max-w-7xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground mb-4">
        <Link href="/camera-trap" className="hover:underline">
          Cámaras Trampa
        </Link>
        <span>/</span>
        <Link href={`/camera-trap/results/${jobId}`} className="hover:underline">
          Trabajo #{jobId}
        </Link>
        <span>/</span>
        <span>{image.filename}</span>
      </div>

      {/* Header with navigation */}
      <div className="flex items-center justify-between mb-4">
        <div className="min-w-0">
          {deploymentName && (
            <p className="text-sm text-muted-foreground truncate">{deploymentName}</p>
          )}
          <h1 className="text-xl font-bold truncate">{image.filename}</h1>
          {timestamp && (
            <p className="text-sm text-muted-foreground">{timestamp}</p>
          )}
          {image.videoId && (
            <VideoFrameLabel videoId={image.videoId} frameIndex={image.frameIndex} />
          )}
        </div>
        <div className="flex items-center gap-4">
          {/* Verification progress */}
          {verificationStats.total > 0 && (
            <VerificationProgress
              reviewed={verificationStats.total - verificationStats.unverified}
              total={verificationStats.total}
            />
          )}
          <span className="text-sm text-muted-foreground tabular-nums">
            Imagen {currentIndex + 1} de {imageIds.length}
          </span>
          <Button asChild variant="outline" size="sm" disabled={!prevImageId}>
            {prevImageId ? (
              <Link href={`/camera-trap/results/${jobId}/images/${prevImageId}`}>
                Anterior
              </Link>
            ) : (
              <span>Anterior</span>
            )}
          </Button>
          <Button asChild variant="outline" size="sm" disabled={!nextImageId}>
            {nextImageId ? (
              <Link href={`/camera-trap/results/${jobId}/images/${nextImageId}`}>
                Siguiente
              </Link>
            ) : (
              <span>Siguiente</span>
            )}
          </Button>
        </div>
      </div>

      <ImageAnnotationClient
        src={fullImageUrl}
        alt={image.filename}
        boxes={boxes}
        detections={annotationDetections}
        speciesList={speciesList}
        hotkeySlots={hotkeySlots}
        jobId={jobId}
        imageId={imgId}
        prevImageId={prevImageId}
        nextImageId={nextImageId}
        canEdit={canEdit}
        confirmedBlank={image.confirmedBlank}
        starred={image.starred}
        starredBy={image.starredBy}
        setupTag={image.setupTag as "deployment" | "retrieval" | null}
      />
    </div>
  );
}

function VerificationProgress({ reviewed, total }: { reviewed: number; total: number }) {
  const pct = Math.round((reviewed / total) * 100);
  const isComplete = reviewed === total;

  return (
    <div className="flex items-center gap-2">
      <div className="w-24 h-1.5 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${isComplete ? "bg-emerald-500" : "bg-blue-500"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`text-xs tabular-nums ${isComplete ? "text-emerald-600 font-medium" : "text-muted-foreground"}`}>
        {reviewed}/{total} revisadas
      </span>
    </div>
  );
}

async function VideoFrameLabel({ videoId, frameIndex }: { videoId: number; frameIndex: number | null }) {
  const [video] = await db
    .select({ filename: videos.filename })
    .from(videos)
    .where(eq(videos.id, videoId));

  if (!video) return null;

  return (
    <p className="text-sm text-muted-foreground mt-0.5">
      Cuadro {(frameIndex ?? 0) + 1} de{" "}
      <span className="font-medium">{video.filename}</span>
    </p>
  );
}
