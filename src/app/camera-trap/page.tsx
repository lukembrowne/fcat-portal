import Link from "next/link";
import { Button } from "@/components/ui/button";
import { getDeploymentsWithStats, getDistinctProjects } from "./actions";
import { DeploymentsTable } from "./deployments-table";
import { getCurrentUser } from "@/lib/auth";

export default async function CameraTrapPage() {
  const [allDeployments, distinctProjects, user] = await Promise.all([
    getDeploymentsWithStats(),
    getDistinctProjects(),
    getCurrentUser(),
  ]);

  // Determine if user has editor permissions for camera-trap
  const canEdit =
    user?.globalRole === "super_admin" ||
    user?.permissions.some(
      (p) => p.projectId === "camera-trap" && (p.role === "editor" || p.role === "admin")
    ) === true;

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
      />
    </div>
  );
}
