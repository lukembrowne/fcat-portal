import Link from "next/link";
import { desc } from "drizzle-orm";

import { db } from "@/db";
import {
  cameraTrapModels,
  cameraTrapTrainingDatasets,
} from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { listUnregisteredModelDirs } from "./actions";
import { ModelsTable, type ModelRow } from "./models-table";
import { RegisterDirsList } from "./register-button";

export default async function CtModelsPage() {
  await requireAdmin();

  const [modelRows, datasets, unregistered] = await Promise.all([
    db
      .select()
      .from(cameraTrapModels)
      .orderBy(desc(cameraTrapModels.createdAt)),
    db
      .select({
        id: cameraTrapTrainingDatasets.id,
        version: cameraTrapTrainingDatasets.version,
      })
      .from(cameraTrapTrainingDatasets),
    listUnregisteredModelDirs(),
  ]);

  const datasetVersionById = new Map(datasets.map((d) => [d.id, d.version]));

  // Resolve metrics summary into plain POJOs for the client component —
  // never pass Drizzle row objects across the boundary.
  const rows: ModelRow[] = modelRows.map((m) => {
    let top1: number | null = null;
    try {
      const parsed = JSON.parse(m.metricsJson) as {
        overall?: { top1Accuracy?: number };
      };
      if (typeof parsed.overall?.top1Accuracy === "number") {
        top1 = parsed.overall.top1Accuracy;
      }
    } catch {
      // metrics json is opaque on read errors — that's fine
    }
    return {
      id: m.id,
      version: m.version,
      modelDir: m.modelDir,
      confidenceThreshold: m.confidenceThreshold,
      active: m.active,
      createdAt: m.createdAt.toISOString(),
      createdBy: m.createdBy,
      trainingDatasetVersion: m.trainingDatasetId
        ? (datasetVersionById.get(m.trainingDatasetId) ?? null)
        : null,
      top1Accuracy: top1,
    };
  });

  return (
    <div className="max-w-6xl mx-auto">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground mb-2">
        <Link href="/camera-trap" className="hover:underline">
          Cámaras Trampa
        </Link>
        <span>/</span>
        <span>Modelos</span>
      </div>

      <h1 className="text-3xl font-bold mb-2">
        Modelos del Clasificador Personalizado
      </h1>
      <p className="text-sm text-muted-foreground mb-6">
        Registro de modelos timm fine-tuneados para Chocó. Los pesos se
        copian a <code>data/models/&lt;version&gt;/</code> con scp y luego
        se registran desde aquí.
      </p>

      <h2 className="text-xl font-semibold mb-3">Modelos registrados</h2>
      <ModelsTable rows={rows} />

      <h2 className="text-xl font-semibold mt-8 mb-3">
        Directorios sin registrar
      </h2>
      {unregistered.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No hay directorios nuevos en <code>data/models/</code>.
        </p>
      ) : (
        <RegisterDirsList dirs={unregistered} />
      )}
    </div>
  );
}
