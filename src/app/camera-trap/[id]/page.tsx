import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { requirePermission } from "@/lib/auth";
import { getDeployment, getDeploymentShareLinks } from "../actions";
import { ProcessButton } from "./process-button";
import { ShareLinksSection } from "./share-links-section";

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

  const data = await getDeployment(deploymentId);

  if (!data) {
    notFound();
  }

  const { deployment, images, jobs } = data;

  const processedImages = images.filter((img) => img.status === "processed").length;
  const failedImages = images.filter((img) => img.status === "failed").length;
  const pendingImages = images.filter((img) => img.status === "pending").length;

  const latestJob = jobs[0];
  const canProcess =
    !latestJob || ["completed", "failed", "cancelled"].includes(latestJob.status);

  // Check if user is editor+ for share links
  const isEditor =
    user.globalRole === "super_admin" ||
    user.permissions.some(
      (p) => p.projectId === "camera-trap" && (p.role === "editor" || p.role === "admin")
    );

  let shareLinks: Awaited<ReturnType<typeof getDeploymentShareLinks>> = [];
  if (isEditor) {
    try {
      shareLinks = await getDeploymentShareLinks(deploymentId);
    } catch {
      // User may not have CT project access — hide section
    }
  }

  return (
    <div className="max-w-4xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground mb-4">
        <Link href="/camera-trap" className="hover:underline">
          Cámaras Trampa
        </Link>
        <span>/</span>
        <span>{deployment.name}</span>
      </div>

      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold mb-2">{deployment.name}</h1>
          <div className="flex items-center gap-4">
            <StatusBadge status={deployment.status} type="deployment" />
            {deployment.driveFolderId ? (
              <a
                href={`https://drive.google.com/drive/folders/${deployment.driveFolderId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground text-sm hover:text-foreground"
              >
                Abrir carpeta en Drive ↗
              </a>
            ) : deployment.path ? (
              <span className="text-muted-foreground text-sm">
                {deployment.path}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex gap-2">
          {canProcess && (
            <ProcessButton deploymentId={deployment.id} />
          )}
          {latestJob && (
            <Button asChild variant="outline">
              <Link href={`/camera-trap/results/${latestJob.id}`}>
                Ver Resultados
              </Link>
            </Button>
          )}
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid gap-4 md:grid-cols-4 mb-8">
        <StatCard label="Total Imágenes" value={images.length} />
        <StatCard label="Procesadas" value={processedImages} />
        <StatCard label="Fallidas" value={failedImages} />
        <StatCard label="Pendientes" value={pendingImages} />
      </div>

      {/* Metadata */}
      {(deployment.latitude || deployment.dateStart) && (
        <Card className="mb-8">
          <CardHeader>
            <CardTitle className="text-lg">Metadatos de la Instalación</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-2">
              {deployment.latitude && deployment.longitude && (
                <div>
                  <p className="text-sm text-muted-foreground">Ubicación</p>
                  <p className="font-medium">
                    {deployment.latitude.toFixed(6)},{" "}
                    {deployment.longitude.toFixed(6)}
                  </p>
                </div>
              )}
              {deployment.dateStart && (
                <div>
                  <p className="text-sm text-muted-foreground">Rango de fechas</p>
                  <p className="font-medium">
                    {deployment.dateStart}
                    {deployment.dateEnd && ` — ${deployment.dateEnd}`}
                  </p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Processing History */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Historial de Procesamiento</CardTitle>
        </CardHeader>
        <CardContent>
          {jobs.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Sin trabajos de procesamiento. Haz clic en &ldquo;Procesar&rdquo; para iniciar.
            </p>
          ) : (
            <div className="space-y-3">
              {jobs.map((job) => (
                <div
                  key={job.id}
                  className="flex items-center justify-between p-3 bg-muted/50 rounded-lg"
                >
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        Trabajo #{job.id}
                      </span>
                      <StatusBadge status={job.status} type="job" />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {job.processedImages} / {job.totalImages} imágenes
                      {job.failedImages > 0 &&
                        ` (${job.failedImages} fallidas)`}
                      {" · "}
                      Modelo: {job.detectorModel}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {job.createdAt?.toLocaleString() || "Desconocido"}
                    </p>
                  </div>
                  <Button asChild variant="ghost" size="sm">
                    <Link href={`/camera-trap/results/${job.id}`}>
                      Resultados
                    </Link>
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Share Links — editors+ only */}
      {isEditor && (
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
