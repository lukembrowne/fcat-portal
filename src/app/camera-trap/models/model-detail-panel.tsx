"use client";

/**
 * Drill-down detail for an expanded model row in the comparison table.
 * Three blocks: confusion matrix heatmap, per-class metrics table,
 * hyperparameters parsed from metrics.json.training.
 *
 * The confusion matrix is lazy-loaded from the server on expand to keep the
 * initial page payload small.
 */

import { useEffect, useState } from "react";

import { getConfusionMatrix } from "./actions";
import type { ClassMetricRow } from "./comparison-table";
import { ConfusionMatrixHeatmap } from "./confusion-matrix-heatmap";
import type { ParsedConfusionMatrix } from "./parse-confusion-matrix";

interface TrainingBlock {
  optimizer?: string;
  lr?: number;
  weight_decay?: number;
  batch_size?: number;
  warmup_epochs?: number;
  epochs_requested?: number;
  epochs_trained?: number;
  early_stopped?: boolean;
  best_epoch?: number;
  scheduler?: string;
  loss?: string;
  mixed_precision?: boolean;
  label_smoothing?: number;
  gitSha?: string;
  finishedAt?: string;
  wandbRunUrl?: string;
}

function parseTraining(metricsJson: string): TrainingBlock | null {
  try {
    const parsed = JSON.parse(metricsJson) as {
      training?: TrainingBlock;
    };
    return parsed.training ?? null;
  } catch {
    return null;
  }
}

function fmt(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "—";
    return Math.abs(v) < 0.01 && v !== 0
      ? v.toExponential(2)
      : v.toString();
  }
  if (typeof v === "boolean") return v ? "sí" : "no";
  return String(v);
}

export function ModelDetailPanel({
  modelId,
  classMetrics,
  metricsJson,
}: {
  modelId: number;
  classMetrics: ClassMetricRow[];
  metricsJson: string;
}) {
  const [matrixState, setMatrixState] = useState<
    | { status: "loading" }
    | { status: "ready"; matrix: ParsedConfusionMatrix | null }
    | { status: "error"; message: string }
  >({ status: "loading" });
  const [minSupport, setMinSupport] = useState(0);

  useEffect(() => {
    let cancelled = false;
    getConfusionMatrix(modelId).then((res) => {
      if (cancelled) return;
      if (res.success) {
        setMatrixState({ status: "ready", matrix: res.data });
      } else {
        setMatrixState({ status: "error", message: res.error });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [modelId]);

  const training = parseTraining(metricsJson);

  const visibleClassRows = classMetrics
    .filter((c) => c.support >= minSupport)
    .sort((a, b) => b.support - a.support);

  const supportByClass = new Map(
    classMetrics.map((c) => [c.className, c.support]),
  );

  return (
    <div className="space-y-6">
      {/* Heatmap */}
      <section>
        <h3 className="mb-2 text-sm font-semibold">Matriz de confusión</h3>
        {matrixState.status === "loading" && (
          <p className="text-xs text-muted-foreground">Cargando matriz…</p>
        )}
        {matrixState.status === "error" && (
          <p className="text-xs text-destructive">{matrixState.message}</p>
        )}
        {matrixState.status === "ready" && matrixState.matrix && (
          <ConfusionMatrixHeatmap
            classes={matrixState.matrix.classes}
            matrix={matrixState.matrix.matrix}
            supportByClass={supportByClass}
          />
        )}
      </section>

      {/* Per-class table + filter */}
      <section>
        <div className="flex items-center justify-between gap-2 mb-2">
          <h3 className="text-sm font-semibold">Métricas por clase</h3>
          <label className="text-xs text-muted-foreground inline-flex items-center gap-2">
            Mínimo de soporte:
            <input
              type="number"
              min={0}
              value={minSupport}
              onChange={(e) => setMinSupport(Number(e.target.value) || 0)}
              className="w-20 rounded border px-2 py-0.5 text-xs"
            />
          </label>
        </div>
        <div className="overflow-x-auto border rounded">
          <table className="w-full text-xs">
            <thead className="bg-muted/40 text-left">
              <tr>
                <th className="px-2 py-1 font-semibold">Clase</th>
                <th className="px-2 py-1 font-semibold text-right">Precisión</th>
                <th className="px-2 py-1 font-semibold text-right">Recall</th>
                <th className="px-2 py-1 font-semibold text-right">F1</th>
                <th className="px-2 py-1 font-semibold text-right">
                  Soporte (test)
                </th>
                <th className="px-2 py-1 font-semibold text-right">
                  Entrenamiento
                </th>
              </tr>
            </thead>
            <tbody>
              {visibleClassRows.map((c) => (
                <tr key={c.className} className="border-t">
                  <td className="px-2 py-1 font-mono">{c.className}</td>
                  <td className="px-2 py-1 text-right font-mono">
                    {c.precisionValue == null
                      ? "—"
                      : c.precisionValue.toFixed(3)}
                  </td>
                  <td className="px-2 py-1 text-right font-mono">
                    {c.recall == null ? "—" : c.recall.toFixed(3)}
                  </td>
                  <td className="px-2 py-1 text-right font-mono">
                    {c.f1 == null ? "—" : c.f1.toFixed(3)}
                  </td>
                  <td className="px-2 py-1 text-right font-mono">{c.support}</td>
                  <td className="px-2 py-1 text-right font-mono">
                    {c.trainCount == null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : c.trainCount === 0 ? (
                      <span
                        className="italic opacity-60"
                        title="Sin imágenes de entrenamiento"
                      >
                        0
                      </span>
                    ) : (
                      c.trainCount
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Hyperparameters */}
      {training && (
        <section>
          <h3 className="mb-2 text-sm font-semibold">Hiperparámetros</h3>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
            <Field label="Optimizador" value={training.optimizer} />
            <Field label="Learning rate" value={training.lr} />
            <Field label="Weight decay" value={training.weight_decay} />
            <Field label="Batch size" value={training.batch_size} />
            <Field label="Warmup epochs" value={training.warmup_epochs} />
            <Field
              label="Epochs (entrenados / solicitados)"
              value={
                training.epochs_trained != null &&
                training.epochs_requested != null
                  ? `${training.epochs_trained} / ${training.epochs_requested}`
                  : undefined
              }
            />
            <Field label="Mejor epoch" value={training.best_epoch} />
            <Field label="Early stopped" value={training.early_stopped} />
            <Field label="Scheduler" value={training.scheduler} />
            <Field label="Loss" value={training.loss} />
            <Field
              label="Mixed precision"
              value={training.mixed_precision}
            />
            <Field
              label="Label smoothing"
              value={training.label_smoothing}
            />
            <Field label="Git SHA" value={training.gitSha} />
            <Field label="Finalizado" value={training.finishedAt} />
          </dl>
          {training.wandbRunUrl && (
            <a
              href={training.wandbRunUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-block text-xs text-primary hover:underline"
            >
              Ver run en W&B ↗
            </a>
          )}
        </section>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono">{fmt(value)}</dd>
    </div>
  );
}
