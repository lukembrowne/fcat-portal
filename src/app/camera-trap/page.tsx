import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { getDeploymentsWithStats, getDistinctProjects } from "./actions";
import { DeploymentsTable } from "./deployments-table";
import { requirePermission } from "@/lib/auth";
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

  const [allDeployments, distinctProjects] = await Promise.all([
    getDeploymentsWithStats(),
    getDistinctProjects(),
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

      {/* Summary Cards */}
      {allDeployments.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <SummaryCard
            label="Por Procesar"
            value={counts.porProcesar}
            className="text-blue-700"
          />
          <SummaryCard
            label="Procesando"
            value={counts.procesando}
            className="text-yellow-600"
          />
          <SummaryCard
            label="Por Revisar"
            value={counts.porRevisar}
            className="text-orange-600"
          />
          <SummaryCard
            label="Verificadas"
            value={counts.verificadas}
            className="text-emerald-700"
          />
        </div>
      )}

      {/* Table */}
      <DeploymentsTable
        groups={groups}
        deployments={allDeployments}
        distinctProjects={distinctProjects}
        canEdit={canEdit}
        isAdmin={isAdmin}
      />
    </div>
  );
}

function SummaryCard({
  label,
  value,
  className,
}: {
  label: string;
  value: number;
  className?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-4 pb-3 px-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={`text-2xl font-bold tabular-nums ${className ?? ""}`}>
          {value}
        </p>
      </CardContent>
    </Card>
  );
}
