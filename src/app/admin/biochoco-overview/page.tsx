import Link from "next/link";
import { requireAdmin } from "@/lib/auth";
import { getActiveReportSnapshot } from "@/lib/public-report-snapshot";
import { PublishControl } from "@/app/public/biochoco-overview/publish-control";

export const dynamic = "force-dynamic";

export default async function AdminBiochocoOverviewPage() {
  await requireAdmin();
  const snapshot = await getActiveReportSnapshot();
  const lastPublished = snapshot
    ? new Date(snapshot.generatedAt).toLocaleString("es-EC")
    : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="mb-2 text-3xl font-bold">Página pública BioChocó</h1>
        <p className="text-muted-foreground">
          Regenera la página pública de divulgación con las estadísticas más
          recientes y la selección curada de fotos y audios. Solo
          super-administradores.
        </p>
      </div>

      <div className="rounded-xl border p-4">
        <p className="mb-3 text-sm text-muted-foreground">
          {lastPublished
            ? `Última publicación: ${lastPublished}`
            : "Aún no se ha publicado ninguna versión."}
        </p>
        <PublishControl />
      </div>

      <p className="text-sm">
        <Link href="/public/biochoco-overview" className="underline" target="_blank">
          Ver la página pública →
        </Link>
      </p>
    </div>
  );
}
