import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import {
  processingJobs,
  deployments,
  images,
  detections,
  identifications,
} from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
import { ResultsClient } from "./results-client";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function JobResultsPage({ params }: PageProps) {
  await requirePermission("camera-trap", "viewer");

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

  const [deployment] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, job.deploymentId));

  const jobImages = await db
    .select()
    .from(images)
    .where(eq(images.jobId, jobId));

  const jobDetections =
    jobImages.length > 0
      ? await db
          .select()
          .from(detections)
          .where(eq(detections.jobId, jobId))
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
    (i) => i.verificationStatus === "verified"
  ).length;
  const unverified = jobIdentifications.filter(
    (i) => i.verificationStatus === "unverified"
  ).length;

  const gridImages = jobImages.map((img) => {
    const imgDets = detectionsByImage.get(img.id) || [];
    return {
      id: img.id,
      filename: img.filename,
      path: img.path,
      status: img.status,
      thumbnailPath: img.thumbnailPath,
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
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold mb-2">
            {deployment?.name || "Despliegue desconocido"}
          </h1>
          <div className="flex items-center gap-4">
            <StatusBadge status={job.status} type="job" />
            <span className="text-muted-foreground">
              {job.processedImages} / {job.totalImages} imágenes procesadas
            </span>
            <span className="text-muted-foreground text-sm">
              Modelo: {job.detectorModel}
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          {unverified > 0 && (
            <Button asChild>
              <Link href={`/camera-trap/annotate?jobId=${job.id}`}>
                Anotar ({unverified} pendientes)
              </Link>
            </Button>
          )}
          {deployment && (
            <Button asChild variant="outline">
              <Link href={`/camera-trap/${deployment.id}`}>
                Despliegue
              </Link>
            </Button>
          )}
          <Button asChild variant="outline">
            <Link href="/camera-trap">Panel</Link>
          </Button>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-5 mb-8">
        <StatCard label="Total Imágenes" value={job.totalImages} />
        <StatCard label="Procesadas" value={job.processedImages} />
        <StatCard label="Fallidas" value={job.failedImages} />
        <StatCard label="Detecciones" value={jobDetections.length} />
        <StatCard
          label="Especies"
          value={Object.keys(speciesCount).length}
        />
      </div>

      {/* Verification Progress */}
      {jobIdentifications.length > 0 && (
        <Card className="mb-8">
          <CardHeader>
            <CardTitle className="text-lg">Progreso de Verificación</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-4 mb-2">
              <span className="text-sm">
                {verified} de {jobIdentifications.length} verificadas
              </span>
              <span className="text-xs text-muted-foreground">
                ({unverified} pendientes)
              </span>
            </div>
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-green-600 rounded-full"
                style={{
                  width: `${
                    (verified / jobIdentifications.length) * 100
                  }%`,
                }}
              />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Species Distribution */}
      {sortedSpecies.length > 0 && (
        <Card className="mb-8">
          <CardHeader>
            <CardTitle>Distribución de Especies</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {sortedSpecies.slice(0, 10).map(([species, count]) => {
                const total = Object.values(speciesCount).reduce(
                  (a, b) => a + b,
                  0
                );
                const percentage = ((count / total) * 100).toFixed(1);
                return (
                  <div key={species} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span className="font-medium">{species}</span>
                      <span className="text-muted-foreground">
                        {count} ({percentage}%)
                      </span>
                    </div>
                    <div className="h-2 bg-muted rounded-full overflow-hidden">
                      <div
                        className="h-full bg-primary rounded-full"
                        style={{ width: `${percentage}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Image Grid with Filter Sidebar */}
      <ResultsClient
        images={gridImages}
        jobId={jobId}
        speciesList={sortedSpecies}
      />
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="text-3xl font-bold">{value}</p>
      </CardContent>
    </Card>
  );
}
