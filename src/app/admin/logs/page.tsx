import { requireAdmin } from "@/lib/auth";
import { LogsViewerClient } from "./logs-viewer-client";

export const dynamic = "force-dynamic";

export default async function AdminLogsPage() {
  await requireAdmin();

  return (
    <div className="max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-2">Registros del sistema</h1>
        <p className="text-muted-foreground">
          Stream en vivo de los registros del portal y de los trabajos
          programados. Solo super-administradores.
        </p>
      </div>

      <LogsViewerClient />
    </div>
  );
}
