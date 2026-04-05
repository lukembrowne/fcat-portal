import { requirePermission } from "@/lib/auth";
import { fetchBiochocoData } from "./actions";
import { DashboardShell } from "./dashboard-shell";

export default async function BiochocoOverviewPage() {
  const user = await requirePermission("biochoco", "viewer");

  const result = await fetchBiochocoData();

  if (!result.success) {
    return (
      <div className="container mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold mb-4">Panel BioChoco</h1>
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-6">
          <p className="text-destructive font-medium">
            Error al cargar datos
          </p>
          <p className="text-sm text-muted-foreground mt-2">{result.error}</p>
        </div>
      </div>
    );
  }

  const canEditNotes =
    user.globalRole === "super_admin" ||
    user.permissions.some(
      (p) => p.projectId === "biochoco" && (p.role === "editor" || p.role === "admin")
    );

  return <DashboardShell data={result.data} canEditNotes={canEditNotes} />;
}
