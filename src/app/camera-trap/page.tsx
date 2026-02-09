import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { getDeployments, getRecentJobs, getDeploymentVerificationStats } from "./actions";
import { FolderScanner } from "./folder-scanner";

export default async function CameraTrapPage() {
  const allDeployments = await getDeployments(50);
  const recentJobs = await getRecentJobs(5);

  const processedDeployments = allDeployments.filter((d) =>
    ["processed", "verified"].includes(d.status)
  );
  const verificationStatsMap = new Map<
    number,
    { total: number; verified: number; rejected: number; corrected: number; unverified: number }
  >();
  await Promise.all(
    processedDeployments.map(async (d) => {
      const stats = await getDeploymentVerificationStats(d.id);
      verificationStatsMap.set(d.id, stats);
    })
  );

  return (
    <div className="max-w-6xl mx-auto">
      <div className="mb-8">
        <h1 className="text-3xl font-bold mb-2">Cámaras Trampa</h1>
        <p className="text-muted-foreground">
          Gestiona despliegues de cámaras trampa, procesa imágenes con ML y
          revisa identificaciones de especies.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-4 mb-8">
        <StatCard label="Despliegues" value={allDeployments.length} />
        <StatCard
          label="Total Imágenes"
          value={allDeployments.reduce(
            (sum, d) => sum + (d.totalImages || 0),
            0
          )}
        />
        <StatCard
          label="Procesados"
          value={
            allDeployments.filter((d) =>
              ["processed", "verified"].includes(d.status)
            ).length
          }
        />
        <StatCard
          label="Pendientes"
          value={
            allDeployments.filter((d) =>
              ["unscanned", "scanned"].includes(d.status)
            ).length
          }
        />
      </div>

      <div className="grid gap-8 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold">Despliegues</h2>
            <Button asChild variant="outline" size="sm">
              <Link href="/camera-trap/results">Todos los Resultados</Link>
            </Button>
          </div>

          {allDeployments.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center">
                <h3 className="text-lg font-medium mb-2">
                  Sin despliegues registrados
                </h3>
                <p className="text-muted-foreground">
                  Registra una carpeta de despliegue para comenzar.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {allDeployments.map((deployment) => {
                const vStats = verificationStatsMap.get(deployment.id);
                const reviewedCount = vStats
                  ? vStats.verified + vStats.rejected + vStats.corrected
                  : 0;
                const reviewedPercent =
                  vStats && vStats.total > 0
                    ? (reviewedCount / vStats.total) * 100
                    : 0;

                return (
                  <Link
                    key={deployment.id}
                    href={`/camera-trap/${deployment.id}`}
                    className="block"
                  >
                    <Card className="hover:bg-muted/50 transition-colors">
                      <CardContent className="py-4">
                        <div className="flex items-center justify-between">
                          <div className="space-y-1 min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <span className="font-medium truncate">
                                {deployment.name}
                              </span>
                              <StatusBadge
                                status={deployment.status}
                                type="deployment"
                              />
                            </div>
                            <p className="text-sm text-muted-foreground truncate">
                              {deployment.path}
                            </p>
                            <div className="flex gap-4 text-xs text-muted-foreground">
                              <span>{deployment.totalImages || 0} imágenes</span>
                              {deployment.latitude && deployment.longitude && (
                                <span>
                                  {deployment.latitude.toFixed(4)},{" "}
                                  {deployment.longitude.toFixed(4)}
                                </span>
                              )}
                              {deployment.dateStart && (
                                <span>
                                  {deployment.dateStart}
                                  {deployment.dateEnd &&
                                    ` — ${deployment.dateEnd}`}
                                </span>
                              )}
                            </div>

                            {vStats && vStats.total > 0 && (
                              <div className="pt-1">
                                <div className="flex items-center justify-between text-xs mb-1">
                                  <span className="text-muted-foreground">
                                    Revisado: {reviewedCount}/{vStats.total}
                                  </span>
                                  <span className="font-medium">
                                    {reviewedPercent.toFixed(0)}%
                                  </span>
                                </div>
                                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                                  <div
                                    className="h-full bg-green-600 rounded-full transition-all"
                                    style={{ width: `${reviewedPercent}%` }}
                                  />
                                </div>
                              </div>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </Link>
                );
              })}
            </div>
          )}
        </div>

        <div className="space-y-6">
          <FolderScanner />

          <Card>
            <CardHeader>
              <CardTitle className="text-lg">Trabajos Recientes</CardTitle>
            </CardHeader>
            <CardContent>
              {recentJobs.length === 0 ? (
                <p className="text-muted-foreground text-sm">
                  No hay trabajos de procesamiento.
                </p>
              ) : (
                <div className="space-y-3">
                  {recentJobs.map((job) => (
                    <div
                      key={job.id}
                      className="flex items-center justify-between p-3 bg-muted/50 rounded-lg"
                    >
                      <div className="space-y-1 min-w-0 flex-1">
                        <p className="font-medium text-sm truncate">
                          {job.deployment?.name || "Desconocido"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {job.processedImages} / {job.totalImages} imágenes
                        </p>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <StatusBadge status={job.status} type="job" />
                        <Button asChild variant="ghost" size="sm">
                          <Link href={`/camera-trap/results/${job.id}`}>
                            Ver
                          </Link>
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
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
