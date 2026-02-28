import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { requirePermission } from "@/lib/auth";
import { requireDeploymentAccess } from "@/lib/camera-trap-auth";
import { formatDuration } from "@/lib/format-duration";
import { db } from "@/db";
import {
  processingJobs,
  deployments,
  images,
  videos,
  detections,
  identifications,
} from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
import { ResultsClient } from "./results-client";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function JobResultsPage({ params }: PageProps) {
  const user = await requirePermission("camera-trap", "viewer");

  const { id } = await params;
  const jobId = parseInt(id, 10);

  if (isNaN(jobId)) {
    notFound();
  }

  const [job] = await db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId));

  if (!job) {
    notFound();
  }

  // Verify CT project access (return 404 to avoid leaking existence)
  try {
    await requireDeploymentAccess(user, job.deploymentId);
  } catch {
    notFound();
  }

  const [deployment] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, job.deploymentId));

  const jobImages = await db
    .select()
    .from(images)
    .where(eq(images.jobId, jobId));

  const imageIds = jobImages.map((img) => img.id);
  const jobDetections =
    imageIds.length > 0
      ? await db
          .select()
          .from(detections)
          .where(inArray(detections.imageId, imageIds))
      : [];

  const detectionIds = jobDetections.map((d) => d.id);
  const jobIdentifications =
    detectionIds.length > 0
      ? await db
          .select()
          .from(identifications)
          .where(inArray(identifications.detectionId, detectionIds))
      : [];

  const identByDetection = new Map<
    number,
    (typeof jobIdentifications)[number]
  >();
  for (const ident of jobIdentifications) {
    identByDetection.set(ident.detectionId, ident);
  }

  const detectionsByImage = new Map<
    number,
    (typeof jobDetections)
  >();
  for (const det of jobDetections) {
    const existing = detectionsByImage.get(det.imageId) || [];
    existing.push(det);
    detectionsByImage.set(det.imageId, existing);
  }

  const speciesCount: Record<string, number> = {};
  for (const ident of jobIdentifications) {
    const species = ident.correctedSpecies || ident.species;
    speciesCount[species] = (speciesCount[species] || 0) + 1;
  }

  const sortedSpecies = Object.entries(speciesCount)
    .sort(([, a], [, b]) => b - a);

  const verified = jobIdentifications.filter(
    (i) => i.verificationStatus === "verified" || i.verificationStatus === "corrected"
  ).length;
  const unverified = jobIdentifications.filter(
    (i) => i.verificationStatus === "unverified"
  ).length;

  // Query videos for this deployment to build a name map
  const jobVideos = deployment
    ? await db
        .select()
        .from(videos)
        .where(eq(videos.deploymentId, deployment.id))
    : [];
  const videoMap = new Map(jobVideos.map((v) => [v.id, v]));

  const gridImages = jobImages.map((img) => {
    const imgDets = detectionsByImage.get(img.id) || [];
    const vid = img.videoId ? videoMap.get(img.videoId) : null;
    return {
      id: img.id,
      filename: img.filename,
      path: img.path,
      status: img.status,
      thumbnailPath: img.thumbnailPath,
      videoId: img.videoId ?? null,
      frameIndex: img.frameIndex ?? null,
      videoFilename: vid?.filename ?? null,
      confirmedBlank: img.confirmedBlank ?? false,
      starred: img.starred ?? false,
      detections: imgDets.map((det) => {
        const ident = identByDetection.get(det.id);
        return {
          id: det.id,
          species: ident?.correctedSpecies || ident?.species || null,
          confidence: ident?.confidence || null,
          detectionConfidence: det.detectionConfidence,
          verificationStatus: ident?.verificationStatus || "unverified",
        };
      }),
    };
  });

  return (
    <div className="max-w-7xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
        <Link href="/camera-trap" className="hover:underline">
          Cámaras Trampa
        </Link>
        <span>/</span>
        <Link href="/camera-trap/results" className="hover:underline">
          Resultados
        </Link>
        <span>/</span>
        <span>Trabajo #{job.id}</span>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-3xl font-bold mb-2">
            {deployment?.name || "Instalación desconocida"}
          </h1>
          {deployment?.siteName && (
            <p className="text-muted-foreground mb-1">{deployment.siteName}</p>
          )}
          <div className="flex items-center gap-4">
            <StatusBadge status={job.status} type="job" />
            {job.startedAt && job.completedAt && (
              <span className="text-muted-foreground">
                {formatDuration(new Date(job.completedAt).getTime() - new Date(job.startedAt).getTime())}
              </span>
            )}
            <span className="text-muted-foreground">
              {job.processedImages} / {job.totalImages} imágenes procesadas
            </span>
            <span className="text-muted-foreground text-sm">
              Detector: {job.detectorModel}
              {job.classifierModel && <> · Clasificador: {job.classifierModel}</>}
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          {deployment && (
            <Button asChild variant="outline">
              <Link href={`/camera-trap/${deployment.id}`}>
                Instalación
              </Link>
            </Button>
          )}
          <Button asChild variant="outline">
            <Link href="/camera-trap">Panel</Link>
          </Button>
        </div>
      </div>

      {/* Compact Summary */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground mb-4">
        <span><strong className="text-foreground">{jobDetections.length}</strong> detecciones</span>
        <span>·</span>
        <span><strong className="text-foreground">{Object.keys(speciesCount).length}</strong> especies</span>
        {jobIdentifications.length > 0 && (
          <>
            <span>·</span>
            <span>
              <strong className="text-foreground">{verified}</strong> de {jobIdentifications.length} verificadas
              {unverified > 0 && <span className="ml-1">({unverified} pendientes)</span>}
            </span>
          </>
        )}
        {job.failedImages > 0 && (
          <>
            <span>·</span>
            <span className="text-destructive">
              <strong>{job.failedImages}</strong> fallidas
            </span>
          </>
        )}
      </div>

      {/* Image Grid with Filter Sidebar */}
      <ResultsClient
        images={gridImages}
        jobId={jobId}
        speciesList={sortedSpecies}
        isAdmin={
          user.globalRole === "super_admin" ||
          user.permissions.some(
            (p) => p.projectId === "camera-trap" && p.role === "admin"
          )
        }
      />
    </div>
  );
}
