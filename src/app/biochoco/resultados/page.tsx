import { requirePermission } from "@/lib/auth";
import { fetchResultadosData } from "./actions";
import { ResultadosShell } from "./resultados-shell";

export default async function ResultadosPage() {
  await requirePermission("biochoco", "viewer");

  const result = await fetchResultadosData();

  if (!result.success) {
    return (
      <div className="flex items-center justify-center h-[400px]">
        <p className="text-destructive">{result.error}</p>
      </div>
    );
  }

  return <ResultadosShell data={result.data} />;
}
