import Link from "next/link";
import { notFound } from "next/navigation";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { requirePermission } from "@/lib/auth";
import { requireDeploymentAccess } from "@/lib/camera-trap-auth";
import { formatDuration } from "@/lib/format-duration";
import { getJobResultsData } from "../../actions";
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

  const data = await getJobResultsData(jobId);

  if (!data) {
    notFound();
  }

  const { job, deployment, gridImages, speciesList, detectionCount, verified, unverified, totalIdentifications } = data;

  // Verify CT project access (return 404 to avoid leaking existence)
  try {
    await requireDeploymentAccess(user, job.deploymentId);
  } catch {
    notFound();
  }

  return (
    <div className="max-w-7xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
        <Link href="/camera-trap" className="hover:underline">
          Cámaras Trampa
        </Link>
        <span>/</span>
        {deployment && (
          <>
            <Link href={`/camera-trap/${deployment.id}`} className="hover:underline">
              {deployment.name}
            </Link>
            <span>/</span>
          </>
        )}
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
        <span><strong className="text-foreground">{detectionCount}</strong> detecciones</span>
        <span>·</span>
        <span><strong className="text-foreground">{speciesList.length}</strong> especies</span>
        {totalIdentifications > 0 && (
          <>
            <span>·</span>
            <span>
              <strong className="text-foreground">{verified}</strong> de {totalIdentifications} verificadas
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
        jobStatus={job.status}
        speciesList={speciesList}
      />
    </div>
  );
}
