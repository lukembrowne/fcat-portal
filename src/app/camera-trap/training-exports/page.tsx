import Link from "next/link";
import { asc, desc, eq, type SQL } from "drizzle-orm";
import { type AnySQLiteColumn } from "drizzle-orm/sqlite-core";

import { db } from "@/db";
import { cameraTrapTrainingDatasets, processingJobs } from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { JOB_TYPES } from "@/lib/job-types";
import { LILA_DATASETS, DEFAULT_REQUESTED_CLASSES } from "@/lib/external/datasets";
import { SortIcon } from "@/components/sort-icon";
import { ExportForm } from "./export-form";
import { ExportArchiveCell } from "./export-archive-cell";
import { ImportForm } from "./import-form";
import { LilaCacheControls } from "./lila-cache-controls";

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

  // LILA external-import section data: import history. (Cache size is loaded
  // lazily client-side via getLilaCacheStats so a slow multi-GB walk never
  // blocks the page render.)
  const importHistory = db
    .select({
      id: processingJobs.id,
      status: processingJobs.status,
      createdAt: processingJobs.createdAt,
      processedImages: processingJobs.processedImages,
      statusMessage: processingJobs.statusMessage,
    })
    .from(processingJobs)
    .where(eq(processingJobs.jobType, JOB_TYPES.EXTERNAL_IMPORT))
    .orderBy(desc(processingJobs.createdAt))
    .limit(25)
    .all();
  const datasetOptions = Object.values(LILA_DATASETS).map((d) => ({
    slug: d.slug,
    name: d.name,
  }));

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
                <th className="px-3 py-2 font-semibold text-right">Fuente</th>
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
                  <td className="px-3 py-2 text-right text-xs">
                    {d.externalImageCount && d.externalImageCount > 0 ? (
                      <span>
                        <span className="text-muted-foreground">FCAT</span>{" "}
                        {(
                          d.fcatImageCount ?? d.imageCount - d.externalImageCount
                        ).toLocaleString("es-EC")}{" "}
                        <span className="text-amber-600">
                          / LILA {d.externalImageCount.toLocaleString("es-EC")}
                        </span>
                      </span>
                    ) : (
                      <span className="text-muted-foreground">FCAT</span>
                    )}
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

      {/* ----------------------------------------------------------------- */}
      {/* LILA external-image augmentation                                  */}
      {/* ----------------------------------------------------------------- */}
      <section className="mt-12 border-t pt-8">
        <h2 className="text-2xl font-bold mb-2">LILA — Imágenes externas</h2>
        <div className="max-w-3xl space-y-3 text-sm text-muted-foreground">
          <p>
            <strong className="text-foreground">LILA BC</strong> (lila.science)
            es un repositorio público de imágenes de cámaras trampa con licencia
            abierta. Algunas de nuestras especies tienen muy pocos ejemplos
            locales; podemos <strong>aumentar el set de entrenamiento</strong>{" "}
            con imágenes de las mismas especies (o congéneres cercanos) tomadas
            de dos conjuntos neotropicales: <strong>Orinoquía</strong> (Colombia)
            y <strong>WCS</strong> (varios países). Cada imagen ya trae una caja
            de MegaDetector precalculada, así que no corremos el detector aquí.
          </p>
          <p>
            <strong className="text-foreground">Al importar:</strong> se
            descargan los fotogramas, se registran como detecciones con su caja y
            una identificación <strong>verificada</strong>, y se guardan como
            datos <strong>solo para train</strong> en despliegues sintéticos. La
            validación y la prueba (val/test) siguen siendo{" "}
            <strong>100% FCAT</strong>, para que la precisión reportada sea honesta
            para el dominio real del Chocó.
          </p>
          <p>
            <strong className="text-foreground">Al exportar:</strong> estas
            imágenes se recortan con los mismos parámetros que las de FCAT y
            aparecen <strong>solo en train/</strong>, con nombres{" "}
            <code>lila-&lt;conjunto&gt;-&lt;id&gt;.jpg</code> y la columna{" "}
            <code>source_dataset</code> en <code>crops.csv</code>. Si la caché de
            imágenes fue borrada, el exporte las vuelve a descargar
            automáticamente.
          </p>
        </div>

        <div className="mt-6 max-w-3xl">
          <LilaCacheControls />
        </div>

        <div className="border rounded-lg p-4 mt-6 mb-6 bg-muted/30 max-w-3xl">
          <h3 className="font-semibold">Nueva importación</h3>
          <ImportForm
            datasetOptions={datasetOptions}
            classOptions={DEFAULT_REQUESTED_CLASSES}
          />
        </div>

        <h3 className="text-lg font-semibold mb-3">Historial de importaciones</h3>
        {importHistory.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Aún no hay importaciones.
          </p>
        ) : (
          <div className="overflow-x-auto border rounded-lg max-w-3xl">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr>
                  <th className="px-3 py-2 font-semibold">Fecha</th>
                  <th className="px-3 py-2 font-semibold">Estado</th>
                  <th className="px-3 py-2 font-semibold text-right">
                    Importadas
                  </th>
                  <th className="px-3 py-2 font-semibold">Mensaje</th>
                </tr>
              </thead>
              <tbody>
                {importHistory.map((j) => (
                  <tr key={j.id} className="border-t align-top">
                    <td className="px-3 py-2 text-muted-foreground">
                      {j.createdAt.toLocaleString("es-EC")}
                    </td>
                    <td className="px-3 py-2">{j.status}</td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {(j.processedImages ?? 0).toLocaleString("es-EC")}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground text-xs">
                      {j.statusMessage}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
