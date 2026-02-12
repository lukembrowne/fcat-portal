import { notFound } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  getJobWithDetails,
  getImageWithDetections,
  getJobImageIds,
  getJobSpecies,
  getJobVerificationStats,
  getNextUnverifiedImageId,
} from "../actions";
import { AnnotateClient } from "./annotate-client";

interface PageProps {
  searchParams: Promise<{ jobId?: string; imageId?: string }>;
}

export default async function AnnotatePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const jobId = params.jobId ? parseInt(params.jobId, 10) : null;

  if (!jobId || isNaN(jobId)) {
    return (
      <div className="max-w-4xl mx-auto text-center py-8">
        <h1 className="text-2xl font-bold mb-4">Cola de Anotación</h1>
        <p className="text-muted-foreground mb-4">
          No se especificó un trabajo. Selecciona uno desde la página de resultados.
        </p>
        <Button asChild>
          <Link href="/camera-trap">Ir al Panel</Link>
        </Button>
      </div>
    );
  }

  const jobDetails = await getJobWithDetails(jobId);
  if (!jobDetails) {
    notFound();
  }

  let targetImageId: number | null = params.imageId
    ? parseInt(params.imageId, 10)
    : null;

  if (!targetImageId) {
    targetImageId = await getNextUnverifiedImageId(jobId);
  }

  if (!targetImageId) {
    const stats = await getJobVerificationStats(jobId);
    return (
      <div className="max-w-4xl mx-auto text-center py-8">
        <h1 className="text-2xl font-bold mb-4">Anotación Completa</h1>
        <p className="text-muted-foreground mb-2">
          Todas las identificaciones de este trabajo han sido revisadas.
        </p>
        <div className="flex justify-center gap-8 my-6 text-sm">
          <div>
            <span className="text-2xl font-bold block">{stats.verified}</span>
            Verificadas
          </div>
          <div>
            <span className="text-2xl font-bold block">{stats.rejected}</span>
            Rechazadas
          </div>
          <div>
            <span className="text-2xl font-bold block">{stats.corrected}</span>
            Corregidas
          </div>
        </div>
        <div className="flex justify-center gap-3">
          <Button asChild variant="outline">
            <Link href={`/camera-trap/results/${jobId}`}>Ver Resultados</Link>
          </Button>
          <Button asChild>
            <Link href="/camera-trap">Panel</Link>
          </Button>
        </div>
      </div>
    );
  }

  const imageData = await getImageWithDetections(targetImageId);
  if (!imageData) {
    notFound();
  }

  const [imageIds, speciesList, stats] = await Promise.all([
    getJobImageIds(jobId),
    getJobSpecies(jobId),
    getJobVerificationStats(jobId),
  ]);

  const fullImageUrl = `/api/ct-images/${imageData.image.id}?size=full`;

  const boxes = imageData.detections.map((det) => ({
    id: det.id,
    x: det.bboxX,
    y: det.bboxY,
    width: det.bboxWidth,
    height: det.bboxHeight,
    detectionConfidence: det.detectionConfidence,
    detectionClass: det.detectionClass,
    species: det.identification?.species || null,
    speciesConfidence: det.identification?.confidence || null,
    verificationStatus: det.identification?.verificationStatus || "unverified",
  }));

  const annotationDetections = imageData.detections.map((det) => ({
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

  const currentIndex = imageIds.indexOf(targetImageId);
  const reviewed = stats.verified + stats.rejected + stats.corrected;

  return (
    <AnnotateClient
      jobId={jobId}
      deploymentName={jobDetails.deployment?.name || "Desconocido"}
      imageId={targetImageId}
      imageFilename={imageData.image.filename}
      imageSrc={fullImageUrl}
      boxes={boxes}
      detections={annotationDetections}
      speciesList={speciesList}
      imageIndex={currentIndex}
      totalImages={imageIds.length}
      reviewed={reviewed}
      totalIdentifications={stats.total}
    />
  );
}
