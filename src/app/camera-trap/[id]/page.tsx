import Link from "next/link";
import { notFound } from "next/navigation";
import { Sparkles, Loader2 } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { requirePermission } from "@/lib/auth";
import { getDeployment, getDeploymentShareLinks, getDistinctProjects, getJobResultsData } from "../actions";
import { ProcessButton } from "./process-button";
import { ShareLinksSection } from "./share-links-section";
import { CollapsibleSection } from "./collapsible-section";
import { MetadataSection } from "./metadata-section";
import { QaSection } from "./qa-section";
import { DeploymentDetailActions } from "./deployment-detail-actions";
import { DeploymentGalleryClient } from "./deployment-gallery-client";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function DeploymentDetailPage({ params }: PageProps) {
  const user = await requirePermission("camera-trap", "viewer");
  const { id } = await params;
  const deploymentId = parseInt(id, 10);

  if (isNaN(deploymentId)) {
    notFound();
  }

  const [data, distinctProjects] = await Promise.all([
    getDeployment(deploymentId),
    getDistinctProjects(),
  ]);

  if (!data) {
    notFound();
  }

  const { deployment, images, jobs, stats } = data;

  const latestJob = jobs[0];
  const canProcess =
    !latestJob || ["completed", "failed", "cancelled"].includes(latestJob.status);

  const isEditor =
    user.globalRole === "super_admin" ||
    user.permissions.some(
      (p) => p.projectId === "camera-trap" && (p.role === "editor" || p.role === "admin")
    );

  const isAdmin =
    user.globalRole === "super_admin" ||
    user.permissions.some(
      (p) => p.projectId === "camera-trap" && p.role === "admin"
    );

  let shareLinks: Awaited<ReturnType<typeof getDeploymentShareLinks>> = [];
  if (isEditor) {
    try {
      shareLinks = await getDeploymentShareLinks(deploymentId);
    } catch {
      // User may not have CT project access — hide section
    }
  }

  // Compute display status for badge
  const displayStatus =
    deployment.status === "processed" && stats.totalDetections === 0
      ? "processed_empty"
      : deployment.status;

  // Count images with known revertible state
  const revertibleImageCount = images.filter(
    (img) => img.compressed && img.originalFileSize != null
  ).length;

  // Fetch results data for the latest completed job (for embedded gallery)
  const resultsData = stats.latestCompletedJobId
    ? await getJobResultsData(stats.latestCompletedJobId)
    : null;

  const isProcessing = deployment.status === "processing";
  const hasResults = !!resultsData;

  return (
    <div className="max-w-7xl mx-auto space-y-3">
      {/* Status Banner — compact single-row layout */}
      <div className="rounded-lg border bg-card px-4 py-2.5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0 flex-wrap">
            <h1 className="text-lg font-bold shrink-0">{deployment.name}</h1>
            <StatusBadge status={displayStatus} type="deployment" />
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              {deployment.totalImages != null && deployment.totalImages > 0 && (
                <span>
                  {deployment.totalImages.toLocaleString()} imágenes
                  {deployment.totalVideos != null && deployment.totalVideos > 0 &&
                    ` · ${deployment.totalVideos.toLocaleString()} videos`}
                </span>
              )}
              {stats.totalDetections > 0 && (
                <span>
                  · {stats.totalDetections.toLocaleString()} detecciones · {stats.distinctSpeciesCount} especies
                </span>
              )}
              {stats.totalIdentifications > 0 && (
                <span className={stats.reviewedCount === stats.totalIdentifications ? "text-emerald-600 font-medium" : ""}>
                  · {stats.reviewedCount}/{stats.totalIdentifications} revisadas
                </span>
              )}
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 shrink-0">
            {canProcess && !isProcessing && !hasResults && (
              <ProcessButton deploymentId={deployment.id} />
            )}
            {isProcessing && latestJob && (
              <Link
                href={`/camera-trap/process?jobId=${latestJob.id}`}
                className="text-sm text-muted-foreground hover:text-foreground"
              >
                Procesando...
              </Link>
            )}
            {isEditor && (
              <DeploymentDetailActions
                deploymentId={deployment.id}
                deploymentName={deployment.name}
                status={deployment.status}
                totalDetections={stats.totalDetections}
                revertibleImageCount={revertibleImageCount}
                totalImages={deployment.totalImages ?? 0}
                hasImages={(deployment.totalImages ?? 0) > 0}
                hasResults={hasResults}
                driveFolderId={deployment.driveFolderId}
                canEdit={isEditor}
                isAdmin={isAdmin}
                lastCompletedJobId={stats.latestCompletedJobId ?? null}
              />
            )}
          </div>
        </div>

        {/* Collapsible details */}
        <div className="mt-2 border-t pt-2">
          <CollapsibleSection title="Detalles" defaultOpen={false}>
            {deployment.fieldNotes && (
              <div className="rounded-md border bg-amber-50 dark:bg-amber-950/20 px-3 py-2 mb-4">
                <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide mb-0.5">
                  Notas de campo
                </p>
                <p className="text-sm whitespace-pre-wrap">{deployment.fieldNotes}</p>
              </div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <MetadataSection
                deployment={{
                  id: deployment.id,
                  name: deployment.name,
                  cameraTrapProjectId: deployment.cameraTrapProjectId,
                  siteName: deployment.siteName,
                  latitude: deployment.latitude,
                  longitude: deployment.longitude,
                  dateStart: deployment.dateStart,
                  dateEnd: deployment.dateEnd,
                  totalImages: deployment.totalImages,
                  totalVideos: deployment.totalVideos,
                  metadataSource: deployment.metadataSource,
                }}
                distinctProjects={distinctProjects}
                canEdit={isEditor}
              />
              <QaSection
                deploymentId={deployment.id}
                canEdit={isEditor}
                excluded={deployment.excluded ?? false}
                validStart={deployment.validStart}
                validEnd={deployment.validEnd}
                qaNotes={deployment.qaNotes}
              />
            </div>
          </CollapsibleSection>
        </div>
      </div>

      {/* Image Gallery (embedded from results) or Empty State */}
      {hasResults ? (
        <DeploymentGalleryClient
          images={resultsData.gridImages}
          jobId={stats.latestCompletedJobId!}
          speciesList={resultsData.speciesList}
          deploymentName={deployment.name}
        />
      ) : (
        <div className="rounded-lg border bg-card px-6 py-10">
          {isProcessing ? (
            <div className="flex flex-col items-center gap-3 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-yellow-100 text-yellow-600">
                <Loader2 className="h-6 w-6 animate-spin" />
              </div>
              <h3 className="text-base font-semibold">Procesando con ML</h3>
              <p className="text-sm text-muted-foreground max-w-md">
                Esta instalación está siendo analizada. El progreso aparece en
                el widget flotante.
              </p>
              {latestJob && (
                <Link
                  href={`/camera-trap/process?jobId=${latestJob.id}`}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  Ver progreso →
                </Link>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 text-center">
              <div className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-emerald-700">
                <Sparkles className="h-6 w-6" />
              </div>
              <h3 className="text-base font-semibold">Lista para procesar</h3>
              <p className="text-sm text-muted-foreground max-w-md">
                {deployment.totalImages != null && deployment.totalImages > 0
                  ? `Hay ${deployment.totalImages.toLocaleString()} imágenes listas para analizar con ML.`
                  : "Sincroniza con Drive para buscar imágenes en esta instalación."}
              </p>
              {canProcess && isEditor && (
                <div className="pt-1">
                  <ProcessButton deploymentId={deployment.id} />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Share Links — editors+ only */}
      {isEditor && shareLinks.length > 0 && (
        <ShareLinksSection
          deploymentId={deploymentId}
          shareLinks={shareLinks.map((link) => ({
            id: link.id,
            token: link.token,
            label: link.label,
            createdBy: link.createdBy,
            createdAt: link.createdAt?.toISOString() ?? null,
          }))}
        />
      )}
    </div>
  );
}
