import { requirePermission } from "@/lib/auth";
import { fetchRevenueData } from "./actions";
import { DashboardShell } from "./dashboard-shell";
import { getDateRangeForPreset } from "../lib/calculations";

export default async function RevenuePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requirePermission("finance", "viewer");

  const params = await searchParams;
  const range = (params.range as string) || "this-year";
  const from = params.from as string | undefined;
  const to = params.to as string | undefined;

  const dateRange =
    range === "custom" && from && to
      ? { from, to }
      : getDateRangeForPreset(range);

  const result = await fetchRevenueData(dateRange.from, dateRange.to);

  if (!result.success) {
    return (
      <div>
        <h1 className="text-2xl font-bold mb-4">Ingresos</h1>
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-6">
          <p className="text-destructive font-medium">Error al cargar datos</p>
          <p className="text-sm text-muted-foreground mt-2">{result.error}</p>
        </div>
      </div>
    );
  }

  return <DashboardShell data={result.data} />;
}
