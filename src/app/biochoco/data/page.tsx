import { requirePermission } from "@/lib/auth";
import { fetchSchedule } from "./actions";
import { UploadStatusTable } from "./upload-status-table";
import { CreateFoldersPanel } from "./create-folders-panel";
import { DataUploadGuide } from "./data-upload-guide";

export default async function BiochocoDataPage() {
  const user = await requirePermission("biochoco", "viewer");

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

  const isEditor =
    user.globalRole === "super_admin" ||
    user.permissions.some(
      (p) => p.projectId === "biochoco" && (p.role === "editor" || p.role === "admin")
    );

  return (
    <div className="space-y-6">
      <DataUploadGuide />
      {isEditor && <CreateFoldersPanel />}
      <UploadStatusTable schedule={result.data} />
    </div>
  );
}
