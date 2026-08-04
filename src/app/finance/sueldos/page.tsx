import { requirePermission } from "@/lib/auth";
import { fetchSueldosPlanning, fetchSueldosTargets } from "./actions";
import { DashboardShell } from "./dashboard-shell";
import { getDateRangeForPreset } from "../lib/calculations";
import { isFundingStatusFilter, isPlanningYear } from "@/lib/finance/sueldos-fields";

export default async function SueldosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requirePermission("finance", "viewer");
  // Salary data is sensitive: reading follows the finance viewer gate, but every
  // mutation is admin-only. (Note that the roster model shows individual FCATero
  // salaries that used to sit inside a single pooled figure.)
  const role = user.permissions.find((p) => p.projectId === "finance")?.role;
  const canEdit = user.globalRole === "super_admin" || role === "admin";

  const params = await searchParams;

  // The layout's range/from/to keep driving the ledger "Gastado" metric only.
  const range = (params.range as string) || "this-year";
  const from = params.from as string | undefined;
  const to = params.to as string | undefined;
  const dateRange =
    range === "custom" && from && to ? { from, to } : getDateRangeForPreset(range);

  // Planning year and status filter are independent of that range. Both degrade
  // to a sensible default rather than erroring — they come from a URL anyone can
  // hand-edit.
  const requestedYear = Number(params.year);
  const year = isPlanningYear(requestedYear) ? requestedYear : new Date().getFullYear();

  const requestedStatus = typeof params.estado === "string" ? params.estado : "all";
  const statusFilter = isFundingStatusFilter(requestedStatus) ? requestedStatus : "all";

  const [result, targetsResult] = await Promise.all([
    fetchSueldosPlanning(year, statusFilter, dateRange.from, dateRange.to),
    fetchSueldosTargets(),
  ]);

  if (!result.success) {
    return (
      <div>
        <h1 className="mb-4 text-2xl font-bold">Sueldos</h1>
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-6">
          <p className="font-medium text-destructive">Error al cargar datos</p>
          <p className="mt-2 text-sm text-muted-foreground">{result.error}</p>
        </div>
      </div>
    );
  }

  return (
    <DashboardShell
      data={result.data}
      canEdit={canEdit}
      targets={targetsResult.success ? targetsResult.data : { groups: [], people: [] }}
    />
  );
}
