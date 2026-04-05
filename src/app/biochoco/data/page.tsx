import { requirePermission } from "@/lib/auth";
import { fetchSchedule, fetchUploadSummary } from "./actions";
import { UploadStatusTable } from "./upload-status-table";
import { CreateFoldersPanel } from "./create-folders-panel";
import { DataUploadGuide } from "./data-upload-guide";
import { UploadSummaryCards } from "./upload-summary-cards";

export default async function BiochocoDataPage() {
  const user = await requirePermission("biochoco", "viewer");

  const [result, summary] = await Promise.all([
    fetchSchedule(),
    fetchUploadSummary(),
  ]);

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

  // Compute retrieved deployment stats from schedule data
  const retrieved = result.data.filter((r) => r.status === "retrieved");
  const retrievedWithUploads = retrieved.filter(
    (r) =>
      (r.uploadCameraCount ?? 0) > 0 ||
      (r.uploadAudioCount ?? 0) > 0 ||
      (r.uploadIbuttonCount ?? 0) > 0
  ).length;

  return (
    <div className="space-y-6">
      <DataUploadGuide />
      <UploadSummaryCards
        summary={summary}
        retrievedWithUploads={retrievedWithUploads}
        totalRetrieved={retrieved.length}
      />
      {isEditor && <CreateFoldersPanel />}
      <UploadStatusTable schedule={result.data} canEditNotes={isEditor} />
    </div>
  );
}
