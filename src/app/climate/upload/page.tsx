import { requirePermission } from "@/lib/auth";

export default async function ClimateUploadPage() {
  await requirePermission("climate", "editor");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Cargar Datos Climáticos</h1>
        <p className="text-muted-foreground mt-1">
          Subir archivos .dat de la estación meteorológica Campbell Scientific
        </p>
      </div>
      <div className="flex items-center justify-center rounded-lg border border-dashed p-12 text-muted-foreground">
        Carga de archivos — próximamente
      </div>
    </div>
  );
}
