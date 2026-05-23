import Link from "next/link";
import { desc, inArray } from "drizzle-orm";

import { db } from "@/db";
import {
  cameraTrapModelClassMetrics,
  cameraTrapModels,
  cameraTrapTrainingDatasets,
} from "@/db/schema";
import { requireAdmin } from "@/lib/auth";
import { listUnregisteredModelDirs } from "./actions";
import {
  ComparisonTable,
  type ClassMetricRow,
  type ModelRow,
} from "./comparison-table";
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

  const modelIds = modelRows.map((m) => m.id);
  // Fetch per-class metrics for all models in one query. Lazy-load the
  // (large) confusion matrix on row expand instead of bundling it here.
  const classMetricsRaw = modelIds.length
    ? await db
        .select({
          modelId: cameraTrapModelClassMetrics.modelId,
          className: cameraTrapModelClassMetrics.className,
          precisionValue: cameraTrapModelClassMetrics.precisionValue,
          recall: cameraTrapModelClassMetrics.recall,
          f1: cameraTrapModelClassMetrics.f1,
          support: cameraTrapModelClassMetrics.support,
          trainCount: cameraTrapModelClassMetrics.trainCount,
        })
        .from(cameraTrapModelClassMetrics)
        .where(inArray(cameraTrapModelClassMetrics.modelId, modelIds))
    : [];

  // Group per-class rows by modelId so each row in ComparisonTable carries
  // its own classMetrics dictionary. JS group-by is ~1ms even at scale.
  const byModelClass = new Map<number, ClassMetricRow[]>();
  for (const r of classMetricsRaw) {
    const list = byModelClass.get(r.modelId);
    if (list) list.push(r);
    else byModelClass.set(r.modelId, [r]);
  }

  // Union of all class names across all models, alphabetical.
  const allClassesUnion = Array.from(
    new Set(classMetricsRaw.map((r) => r.className)),
  ).sort((a, b) => a.localeCompare(b));

  const rows: ModelRow[] = modelRows.map((m) => {
    let top1: number | null = null;
    let macroF1: number | null = null;
    try {
      const parsed = JSON.parse(m.metricsJson) as {
        overall?: { top1Accuracy?: number; macroF1?: number };
      };
      if (typeof parsed.overall?.top1Accuracy === "number") {
        top1 = parsed.overall.top1Accuracy;
      }
      if (typeof parsed.overall?.macroF1 === "number") {
        macroF1 = parsed.overall.macroF1;
      }
    } catch {
      // metrics json is opaque on read errors — that's fine
    }
    const classMetrics = byModelClass.get(m.id) ?? [];
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
      macroF1,
      hasConfusionMatrix: m.confusionMatrixJson != null,
      classMetrics,
      // metricsJson is shipped to the client for the drill-down panel
      // (hyperparameter block reads training.* fields). ~5KB per model.
      metricsJson: m.metricsJson,
    };
  });

  return (
    <div className="max-w-7xl mx-auto">
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

      <h2 className="text-xl font-semibold mb-3">Comparación de modelos</h2>
      <ComparisonTable rows={rows} allClassesUnion={allClassesUnion} />

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
