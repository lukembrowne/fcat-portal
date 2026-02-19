import { requirePermission } from "@/lib/auth";
import { fetchToolsData } from "./actions";
import { ToolsShell } from "./tools-shell";

export default async function BiochocoToolsPage() {
  await requirePermission("biochoco", "admin");

  const result = await fetchToolsData();

  if (!result.success) {
    return (
      <div className="container mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold mb-4">Herramientas de Cronograma</h1>
        <p className="text-destructive">Error al cargar datos: {result.error}</p>
      </div>
    );
  }

  return <ToolsShell initialData={result.data} />;
}
