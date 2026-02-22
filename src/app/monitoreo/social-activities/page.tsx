import { requirePermission } from "@/lib/auth";
import { fetchSocialActivities } from "./actions";
import { DashboardShell } from "./dashboard-shell";

export default async function SocialActivitiesPage() {
  await requirePermission("monitoreo", "viewer");

  const result = await fetchSocialActivities();

  if (!result.success) {
    return (
      <div className="container mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold mb-4">Actividades Sociales</h1>
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-6">
          <p className="text-destructive font-medium">
            Error al cargar datos de ODK Central
          </p>
          <p className="text-sm text-muted-foreground mt-2">{result.error}</p>
        </div>
      </div>
    );
  }

  return <DashboardShell activities={result.data.activities} />;
}
