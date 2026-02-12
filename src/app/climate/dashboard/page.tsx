import { requirePermission } from "@/lib/auth";

export default async function ClimateDashboardPage() {
  await requirePermission("climate", "viewer");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Datos Climáticos</h1>
        <p className="text-muted-foreground mt-1">
          Estación meteorológica central FCAT
        </p>
      </div>
      <div className="flex items-center justify-center rounded-lg border border-dashed p-12 text-muted-foreground">
        Panel de datos climáticos — próximamente
      </div>
    </div>
  );
}
