import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getDeploymentsWithStats, getDistinctProjects } from "./actions";
import { DeploymentsTable } from "./deployments-table";
import { requirePermission } from "@/lib/auth";

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

      {/* Table */}
      <DeploymentsTable
        deployments={allDeployments}
        distinctProjects={distinctProjects}
        canEdit={canEdit}
        isAdmin={isAdmin}
      />
    </div>
  );
}
