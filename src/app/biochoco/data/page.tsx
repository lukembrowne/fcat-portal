import { requirePermission } from "@/lib/auth";
import { fetchSchedule } from "./actions";
import { UploadStatusTable } from "./upload-status-table";

export default async function BiochocoDataPage() {
  await requirePermission("biochoco", "viewer");

  const result = await fetchSchedule();

  if (!result.success) {
    return (
      <div className="container mx-auto px-4 py-8">
        <h1 className="text-2xl font-bold mb-4">Estado de Datos</h1>
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-6">
          <p className="text-destructive font-medium">
            Error al cargar estado de datos
          </p>
          <p className="text-sm text-muted-foreground mt-2">{result.error}</p>
        </div>
      </div>
    );
  }

  return <UploadStatusTable schedule={result.data} />;
}
