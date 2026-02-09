import { requirePermission } from "@/lib/auth";
import { fetchTreeData } from "./actions";
import { DashboardShell } from "./dashboard-shell";

export default async function TreePlantingPage() {
  await requirePermission("giz", "viewer");

  const result = await fetchTreeData();

  if (!result.success) {
    return (
      <div className="container mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold mb-4">Siembra de Árboles</h1>
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-6">
          <p className="text-destructive font-medium">
            Error al cargar datos de ODK Central
          </p>
          <p className="text-sm text-muted-foreground mt-2">{result.error}</p>
        </div>
      </div>
    );
  }

  return <DashboardShell trees={result.data.trees} />;
}
