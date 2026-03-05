import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth";
import { getImageWithDetections, getJobImageIds, getSpeciesList, getFrequentSpecies } from "@/app/camera-trap/actions";
import { db } from "@/db";
import { videos } from "@/db/schema";
import { eq } from "drizzle-orm";
import { ImageAnnotationClient } from "./image-annotation-client";

interface PageProps {
  params: Promise<{ id: string; imageId: string }>;
}

export default async function ImageDetailPage({ params }: PageProps) {
  await requirePermission("camera-trap", "viewer");
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

  const [imageIds, speciesList, frequentSpeciesResult] = await Promise.all([
    getJobImageIds(jobId),
    getSpeciesList(),
    getFrequentSpecies(image.deploymentId),
  ]);
  const frequentSpecies = frequentSpeciesResult.success ? frequentSpeciesResult.data : [];
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
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {currentIndex + 1} de {imageIds.length}
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
        frequentSpecies={frequentSpecies}
        jobId={jobId}
        imageId={imgId}
        prevImageId={prevImageId}
        nextImageId={nextImageId}
        confirmedBlank={image.confirmedBlank}
        starred={image.starred}
        starredBy={image.starredBy}
        setupTag={image.setupTag as "deployment" | "retrieval" | null}
      />
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
