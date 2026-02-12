import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { getRecentJobs } from "../actions";

export default async function ResultsPage() {
  const jobs = await getRecentJobs(50);

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold mb-2">Resultados de Procesamiento</h1>
            <p className="text-muted-foreground">
              Todos los trabajos de procesamiento y sus resultados.
            </p>
          </div>
          <Button asChild>
            <Link href="/camera-trap">Panel</Link>
          </Button>
        </div>
      </div>

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
        <div className="space-y-4">
          {jobs.map((job) => (
            <Card key={job.id}>
              <CardContent className="py-4">
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">
                        {job.deployment?.name || "Instalación desconocida"}
                      </span>
                      <StatusBadge status={job.status} type="job" />
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {job.processedImages} de {job.totalImages} imágenes procesadas
                      {job.failedImages > 0 && ` (${job.failedImages} fallidas)`}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Modelo: {job.detectorModel} · Creado:{" "}
                      {job.createdAt?.toLocaleString() || "Desconocido"}
                    </p>
                  </div>
                  <Button asChild>
                    <Link href={`/camera-trap/results/${job.id}`}>
                      Ver Resultados
                    </Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
