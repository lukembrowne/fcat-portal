import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getDeploymentsWithStats, getDistinctProjects } from "./actions";
import { DeploymentsTable } from "./deployments-table";
import { requirePermission } from "@/lib/auth";
import { getAppStateTimestamp } from "@/lib/app-state";
import { CAMERA_TRAP_DRIVE_LAST_SYNC_KEY } from "@/lib/app-state-keys";
import type { DeploymentRow } from "./actions";

/** A project group with its deployments, pre-sorted by project name */
export interface ProjectGroup {
  projectLabel: string;
  deployments: DeploymentRow[];
  /** Summary counts for the group header */
  actionableCount: number;
  totalCount: number;
}

function groupByProject(deployments: DeploymentRow[]): ProjectGroup[] {
  const groups = new Map<string, DeploymentRow[]>();

  for (const d of deployments) {
    const key = d.projectLabel || "Sin Proyecto";
    const existing = groups.get(key);
    if (existing) {
      existing.push(d);
    } else {
      groups.set(key, [d]);
    }
  }

  return Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([projectLabel, deps]) => ({
      projectLabel,
      deployments: deps,
      totalCount: deps.length,
      actionableCount: deps.filter((d) =>
        ["unscanned", "scanned", "processing", "processed"].includes(d.status)
      ).length,
    }));
}

function computeStatusCounts(deployments: DeploymentRow[]) {
  let porProcesar = 0;
  let procesando = 0;
  let porRevisar = 0;
  let verificadas = 0;

  for (const d of deployments) {
    switch (d.status) {
      case "unscanned":
      case "scanned":
        porProcesar++;
        break;
      case "processing":
        procesando++;
        break;
      case "processed":
        porRevisar++;
        break;
      case "verified":
      case "verified_empty":
        verificadas++;
        break;
    }
  }

  return { porProcesar, procesando, porRevisar, verificadas };
}

export default async function CameraTrapPage() {
  const user = await requirePermission("camera-trap", "viewer");

  const [allDeployments, distinctProjects, lastDriveSyncAt] = await Promise.all([
    getDeploymentsWithStats(),
    getDistinctProjects(),
    getAppStateTimestamp(CAMERA_TRAP_DRIVE_LAST_SYNC_KEY),
  ]);

  // Determine if user has editor permissions for camera-trap
  const canEdit =
    user.globalRole === "super_admin" ||
    user.permissions.some(
      (p) => p.projectId === "camera-trap" && (p.role === "editor" || p.role === "admin")
    );

  const isAdmin =
    user.globalRole === "super_admin" ||
    user.permissions.some(
      (p) => p.projectId === "camera-trap" && p.role === "admin"
    );

  const groups = groupByProject(allDeployments);
  const counts = computeStatusCounts(allDeployments);

  return (
    <div className="max-w-7xl mx-auto min-w-0">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-3xl font-bold mb-1">Cámaras Trampa</h1>
          <p className="text-muted-foreground text-sm">
            Gestiona instalaciones, procesa imágenes con ML y revisa
            identificaciones.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link href="/camera-trap/results">Todos los Resultados</Link>
        </Button>
      </div>

      {/* Summary strip */}
      {allDeployments.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-md border bg-card px-4 py-2.5 text-sm">
          <SummaryStat label="Por Procesar" value={counts.porProcesar} dotClass="bg-blue-600" valueClass="text-blue-700" />
          <span className="h-4 w-px bg-border" aria-hidden />
          <SummaryStat label="Procesando" value={counts.procesando} dotClass="bg-yellow-500" valueClass="text-yellow-600" />
          <span className="h-4 w-px bg-border" aria-hidden />
          <SummaryStat label="Por Revisar" value={counts.porRevisar} dotClass="bg-orange-500" valueClass="text-orange-600" />
          <span className="h-4 w-px bg-border" aria-hidden />
          <SummaryStat label="Verificadas" value={counts.verificadas} dotClass="bg-emerald-600" valueClass="text-emerald-700" />
          <span className="ml-auto text-xs text-muted-foreground">
            {allDeployments.length} instalaciones en total
          </span>
        </div>
      )}

      {/* Table */}
      <DeploymentsTable
        groups={groups}
        deployments={allDeployments}
        distinctProjects={distinctProjects}
        canEdit={canEdit}
        isAdmin={isAdmin}
        lastDriveSyncAt={lastDriveSyncAt ? lastDriveSyncAt.toISOString() : null}
      />
    </div>
  );
}

function SummaryStat({
  label,
  value,
  dotClass,
  valueClass,
}: {
  label: string;
  value: number;
  dotClass: string;
  valueClass: string;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`h-2 w-2 rounded-full ${dotClass}`} aria-hidden />
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-semibold tabular-nums ${valueClass}`}>{value}</span>
    </span>
  );
}
