import { requirePermission } from "@/lib/auth";
import { fetchCacaoData } from "./actions";
import { DashboardShell } from "./dashboard-shell";

export default async function CacaoMonitoringPage() {
  await requirePermission("giz", "viewer");

  const { success, records, metrics, error } = await fetchCacaoData();

  if (!success) {
    return (
      <div className="container mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold mb-4">Monitoreo de Cacao</h1>
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-6">
          <p className="text-destructive font-medium">
            Error al cargar datos de ODK Central
          </p>
          <p className="text-sm text-muted-foreground mt-2">{error}</p>
        </div>
      </div>
    );
  }

  return <DashboardShell records={records} metrics={metrics} />;
}
