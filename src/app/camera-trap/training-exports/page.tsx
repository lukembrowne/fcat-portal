import Link from "next/link";
import { asc, desc, type SQL } from "drizzle-orm";
import { type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

import { db } from "@/db";
import { cameraTrapTrainingDatasets } from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { SortIcon } from "@/components/sort-icon";
import { ExportForm } from "./export-form";
import { ExportArchiveCell } from "./export-archive-cell";

type SortColumn =
  | "version"
  | "date"
  | "images"
  | "classes"
  | "minExamples"
  | "createdBy";
type SortDirection = "asc" | "desc";

const SORTABLE_COLUMNS: Record<SortColumn, AnySQLiteColumn> = {
  version: cameraTrapTrainingDatasets.id, // version is monotonic with id
  date: cameraTrapTrainingDatasets.createdAt,
  images: cameraTrapTrainingDatasets.imageCount,
  classes: cameraTrapTrainingDatasets.classCount,
  minExamples: cameraTrapTrainingDatasets.minExamplesThreshold,
  createdBy: cameraTrapTrainingDatasets.createdBy,
};

function SortableHeader({
  column,
  label,
  currentSort,
  currentDir,
  align = "left",
}: {
  column: SortColumn;
  label: string;
  currentSort: SortColumn;
  currentDir: SortDirection;
  align?: "left" | "right";
}) {
  const isActive = currentSort === column;
  const nextDir = isActive && currentDir === "asc" ? "desc" : "asc";
  const query = new URLSearchParams();
  query.set("sortBy", column);
  query.set("sortDir", nextDir);

  return (
    <th
      className={`px-3 py-2 font-semibold ${align === "right" ? "text-right" : ""}`}
    >
      <Link
        href={`/camera-trap/training-exports?${query.toString()}`}
        className={`inline-flex items-center gap-1 hover:text-foreground transition-colors ${
          align === "right" ? "flex-row-reverse" : ""
        }`}
      >
        {label}
        <SortIcon direction={isActive ? currentDir : false} />
      </Link>
    </th>
  );
}

export default async function TrainingExportsPage({
  searchParams,
}: {
  searchParams: Promise<{ sortBy?: string; sortDir?: string }>;
}) {
  await requireAdmin();

  const params = await searchParams;
  const sortBy = (
    params.sortBy && params.sortBy in SORTABLE_COLUMNS ? params.sortBy : "date"
  ) as SortColumn;
  const sortDir = (params.sortDir === "asc" ? "asc" : "desc") as SortDirection;

  const sortCol = SORTABLE_COLUMNS[sortBy];
  // Stable id tiebreaker so equal values have a deterministic order.
  const orderBy: SQL[] =
    sortDir === "asc"
      ? [asc(sortCol), asc(cameraTrapTrainingDatasets.id)]
      : [desc(sortCol), desc(cameraTrapTrainingDatasets.id)];

  const datasets = await db
    .select()
    .from(cameraTrapTrainingDatasets)
    .orderBy(...orderBy);

  return (
    <div className="max-w-6xl mx-auto">
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
        nueva versión. Cada exporte incluye <code>crops.csv</code> (metadatos
        por recorte) y un <code>manifest.json</code> con los parámetros del
        pipeline (MegaDetector, umbral, padding).
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
                <SortableHeader
                  column="version"
                  label="Versión"
                  currentSort={sortBy}
                  currentDir={sortDir}
                />
                <SortableHeader
                  column="date"
                  label="Fecha"
                  currentSort={sortBy}
                  currentDir={sortDir}
                />
                <SortableHeader
                  column="images"
                  label="Imágenes"
                  currentSort={sortBy}
                  currentDir={sortDir}
                  align="right"
                />
                <SortableHeader
                  column="classes"
                  label="Clases"
                  currentSort={sortBy}
                  currentDir={sortDir}
                  align="right"
                />
                <SortableHeader
                  column="minExamples"
                  label="Umbral mínimo"
                  currentSort={sortBy}
                  currentDir={sortDir}
                  align="right"
                />
                <SortableHeader
                  column="createdBy"
                  label="Creado por"
                  currentSort={sortBy}
                  currentDir={sortDir}
                />
                <th className="px-3 py-2 font-semibold">Archivo / Compartir</th>
              </tr>
            </thead>
            <tbody>
              {datasets.map((d) => (
                <tr key={d.id} className="border-t align-top">
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
                  <td className="px-3 py-2">
                    <ExportArchiveCell
                      version={d.version}
                      webViewLink={d.driveArchiveWebViewLink}
                      uploadedAt={
                        d.archiveUploadedAt
                          ? d.archiveUploadedAt.toLocaleString("es-EC")
                          : null
                      }
                    />
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
