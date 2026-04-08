import Link from "next/link";
import { desc } from "drizzle-orm";

import { db } from "@/db";
import { cameraTrapTrainingDatasets } from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { ExportForm } from "./export-form";

export default async function TrainingExportsPage() {
  await requireAdmin();

  const datasets = await db
    .select()
    .from(cameraTrapTrainingDatasets)
    .orderBy(desc(cameraTrapTrainingDatasets.createdAt));

  return (
    <div className="max-w-5xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
        <Link href="/camera-trap" className="hover:underline">
          Cámaras Trampa
        </Link>
        <span>/</span>
        <span>Exportes de Entrenamiento</span>
      </div>

      <h1 className="text-3xl font-bold mb-2">Exportes de Entrenamiento</h1>
      <p className="text-sm text-muted-foreground mb-6">
        Genera datasets versionados a partir de detecciones verificadas para
        entrenar el clasificador personalizado de Chocó. Cada exporte es
        reproducible — si los datos de entrada no cambiaron, no se crea una
        nueva versión.
      </p>

      <div className="border rounded-lg p-4 mb-6 bg-muted/30">
        <h2 className="font-semibold mb-2">Crear nuevo exporte</h2>
        <ExportForm />
      </div>

      <h2 className="text-xl font-semibold mb-3">Historial</h2>
      {datasets.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Todavía no hay exportes. Usa el formulario de arriba para crear el
          primero.
        </p>
      ) : (
        <div className="overflow-x-auto border rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="px-3 py-2 font-semibold">Versión</th>
                <th className="px-3 py-2 font-semibold">Fecha</th>
                <th className="px-3 py-2 font-semibold text-right">
                  Imágenes
                </th>
                <th className="px-3 py-2 font-semibold text-right">Clases</th>
                <th className="px-3 py-2 font-semibold text-right">
                  Umbral mínimo
                </th>
                <th className="px-3 py-2 font-semibold">Creado por</th>
                <th className="px-3 py-2 font-semibold">Manifest</th>
              </tr>
            </thead>
            <tbody>
              {datasets.map((d) => (
                <tr key={d.id} className="border-t">
                  <td className="px-3 py-2 font-mono">{d.version}</td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {d.createdAt.toLocaleString("es-EC")}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {d.imageCount.toLocaleString("es-EC")}
                  </td>
                  <td className="px-3 py-2 text-right">{d.classCount}</td>
                  <td className="px-3 py-2 text-right">
                    {d.minExamplesThreshold}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground text-xs">
                    {d.createdBy}
                  </td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                    {d.manifestPath}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
