import { requirePermission } from "@/lib/auth";
import { fetchHabitatData } from "./actions";
import { HabitatShell } from "./habitat-shell";

export default async function BiochocoHabitatPage() {
  await requirePermission("biochoco", "viewer");

  const result = await fetchHabitatData();

  if (!result.success) {
    return (
      <div className="container mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold mb-4">Evaluación de Hábitat</h1>
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-6">
          <p className="text-destructive font-medium">
            Error al cargar datos
          </p>
          <p className="text-sm text-muted-foreground mt-2">{result.error}</p>
        </div>
      </div>
    );
  }

  return <HabitatShell data={result.data} />;
}
