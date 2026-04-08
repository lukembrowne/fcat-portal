import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { requirePermission } from "@/lib/auth";
import { getRecentJobs, getResultsStats } from "../actions";
import { ResultsTable, type ResultsJob } from "./results-table";

export default async function ResultsPage() {
  const user = await requirePermission("camera-trap", "editor");
  const [jobs, stats] = await Promise.all([
    getRecentJobs(50),
    getResultsStats(),
  ]);

  // Check if user can delete (editor or above)
  const cameraTrapPerm = user.permissions.find(
    (p) => p.projectId === "camera-trap"
  );
  const canDelete =
    user.globalRole === "super_admin" ||
    (cameraTrapPerm?.role === "editor" || cameraTrapPerm?.role === "admin");

  // Serialize dates for client component
  const serializedJobs: ResultsJob[] = jobs.map((job) => ({
    id: job.id,
    status: job.status,
    totalImages: job.totalImages,
    processedImages: job.processedImages,
    failedImages: job.failedImages,
    detectorModel: job.detectorModel,
    classifierModel: job.classifierModel,
    createdAt: job.createdAt?.toISOString() || null,
    startedAt: job.startedAt?.toISOString() || null,
    completedAt: job.completedAt?.toISOString() || null,
    deployment: job.deployment
      ? { id: job.deployment.id, name: job.deployment.name, siteName: job.deployment.siteName }
      : null,
    detectionsCount: job.detectionsCount,
    speciesCount: job.speciesCount,
    verifiedCount: job.verifiedCount,
    errorMessage: job.errorMessage ?? null,
  }));

  return (
    <div className="max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Trabajos de ML</h1>
          <p className="text-sm text-muted-foreground">
            Historial de trabajos de procesamiento con modelos de ML.
          </p>
        </div>
        <Button asChild variant="outline">
          <Link href="/camera-trap">Panel</Link>
        </Button>
      </div>

      {/* Summary Stats */}
      <div className="grid gap-4 md:grid-cols-4 mb-6">
        <StatCard label="Trabajos" value={stats.totalJobs} />
        <StatCard
          label="Imágenes Procesadas"
          value={stats.totalImagesProcessed}
        />
        <StatCard label="Detecciones" value={stats.totalDetections} />
        <StatCard label="Especies" value={stats.uniqueSpecies} />
      </div>

      {/* Table or Empty State */}
      {jobs.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <h3 className="text-lg font-medium mb-2">Sin trabajos</h3>
            <p className="text-muted-foreground mb-4">
              Comienza escaneando una carpeta de imágenes de cámaras trampa.
            </p>
            <Button asChild>
              <Link href="/camera-trap">Comenzar</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <ResultsTable jobs={serializedJobs} canDelete={canDelete} />
      )}
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="text-3xl font-bold">{value.toLocaleString()}</p>
      </CardContent>
    </Card>
  );
}
