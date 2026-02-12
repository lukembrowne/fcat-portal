import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { getDeployments, getDeploymentVerificationStats } from "./actions";
import { SyncAndActivate } from "./sync-and-activate";
import type { Deployment } from "@/db/schema";
import type { VerificationStats } from "@/lib/types";

export default async function CameraTrapPage() {
  const allDeployments = await getDeployments(50);

  const pending = allDeployments.filter(
    (d) => !["processed", "verified"].includes(d.status)
  );
  const processed = allDeployments.filter((d) =>
    ["processed", "verified"].includes(d.status)
  );

  const verificationStatsMap = new Map<number, VerificationStats>();
  await Promise.all(
    processed.map(async (d) => {
      const stats = await getDeploymentVerificationStats(d.id);
      verificationStatsMap.set(d.id, stats);
    })
  );

  const totalImages = allDeployments.reduce(
    (sum, d) => sum + (d.totalImages || 0),
    0
  );

  return (
    <div className="max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold mb-2">Cámaras Trampa</h1>
          <p className="text-muted-foreground">
            Gestiona instalaciones de cámaras trampa, procesa imágenes con ML y
            revisa identificaciones de especies.
          </p>
        </div>
        <div className="flex gap-2 flex-shrink-0">
          <Button asChild variant="outline" size="sm">
            <Link href="/camera-trap/results">Todos los Resultados</Link>
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-4 md:grid-cols-4 mb-8">
        <StatCard label="Instalaciones" value={allDeployments.length} />
        <StatCard label="Total Imágenes" value={totalImages} />
        <StatCard label="Procesadas" value={processed.length} />
        <StatCard label="Pendientes" value={pending.length} />
      </div>

      {/* Sync + Discover (Client Component) */}
      <SyncAndActivate />

      {/* Pendientes */}
      <section className="mb-8">
        <h2 className="text-xl font-semibold mb-4">
          Pendientes ({pending.length})
        </h2>
        {pending.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center">
              <p className="text-muted-foreground">
                No hay instalaciones pendientes. Usa &ldquo;Sincronizar con
                Drive&rdquo; para buscar nuevas carpetas.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {pending.map((deployment) => (
              <DeploymentCard key={deployment.id} deployment={deployment} />
            ))}
          </div>
        )}
      </section>

      {/* Procesadas */}
      <section>
        <h2 className="text-xl font-semibold mb-4">
          Procesadas ({processed.length})
        </h2>
        {processed.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center">
              <p className="text-muted-foreground">
                No hay instalaciones procesadas todavía.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
            {processed.map((deployment) => {
              const vStats = verificationStatsMap.get(deployment.id);
              return (
                <DeploymentCard
                  key={deployment.id}
                  deployment={deployment}
                  verificationStats={vStats}
                />
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function DeploymentCard({
  deployment,
  verificationStats,
}: {
  deployment: Deployment;
  verificationStats?: VerificationStats;
}) {
  const reviewedCount = verificationStats
    ? verificationStats.verified +
      verificationStats.rejected +
      verificationStats.corrected
    : 0;
  const reviewedPercent =
    verificationStats && verificationStats.total > 0
      ? (reviewedCount / verificationStats.total) * 100
      : 0;

  return (
    <Link href={`/camera-trap/${deployment.id}`} className="block">
      <Card className="hover:bg-muted/50 transition-colors h-full">
        <CardContent className="py-4">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="font-medium truncate">{deployment.name}</span>
              <StatusBadge status={deployment.status} type="deployment" />
            </div>

            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
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
                  {deployment.dateEnd && ` — ${deployment.dateEnd}`}
                </span>
              )}
            </div>

            {deployment.driveFolderId && (
              <span
                className="text-xs text-muted-foreground hover:text-foreground inline-block"
              >
                <a
                  href={`https://drive.google.com/drive/folders/${deployment.driveFolderId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Abrir en Drive ↗
                </a>
              </span>
            )}

            {verificationStats && verificationStats.total > 0 && (
              <div className="pt-1">
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="text-muted-foreground">
                    Revisado: {reviewedCount}/{verificationStats.total}
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
        </CardContent>
      </Card>
    </Link>
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
