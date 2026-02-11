import { requirePermission } from "@/lib/auth";
import { fetchBudgetData } from "./actions";
import { DashboardShell } from "./dashboard-shell";

export default async function BudgetPage() {
  await requirePermission("finance", "viewer");

  const result = await fetchBudgetData();

  if (!result.success) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-4">Presupuesto</h1>
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-6">
          <p className="text-destructive font-medium">Error al cargar datos</p>
          <p className="text-sm text-muted-foreground mt-2">{result.error}</p>
        </div>
      </div>
    );
  }

  return <DashboardShell data={result.data} />;
}
