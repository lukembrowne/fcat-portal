"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  exportTrainingDataset,
  getExportPreview,
  type ExportPreview,
  type ExportResult,
} from "./actions";

const DEFAULT_MIN_EXAMPLES = 50;
const PREVIEW_DEBOUNCE_MS = 300;

export function ExportForm() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<ExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [minExamples, setMinExamples] = useState(DEFAULT_MIN_EXAMPLES);
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Debounced preview fetch — re-runs whenever minExamples changes.
  // Loading flag flips inside the timeout (not synchronously in the effect
  // body) to avoid cascading renders per the React lint rule.
  useEffect(() => {
    if (!Number.isFinite(minExamples) || minExamples < 1) return;
    let cancelled = false;
    const handle = setTimeout(async () => {
      if (cancelled) return;
      setPreviewLoading(true);
      setPreviewError(null);
      const res = await getExportPreview(minExamples);
      if (cancelled) return;
      if (res.success) {
        setPreview(res.data);
      } else {
        setPreviewError(res.error);
        setPreview(null);
      }
      setPreviewLoading(false);
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [minExamples]);

  function handleSubmit(formData: FormData) {
    setError(null);
    setResult(null);
    startTransition(async () => {
      const res = await exportTrainingDataset(formData);
      if (res.success) {
        setResult(res.data);
        router.refresh();
      } else {
        setError(res.error);
      }
    });
  }

  return (
    <div>
      <PreviewCard
        preview={preview}
        loading={previewLoading}
        error={previewError}
      />

      <form action={handleSubmit} className="flex items-end gap-3 mt-4">
        <div className="flex-1 max-w-xs">
          <Label htmlFor="minExamples" className="text-xs">
            Mínimo de ejemplos por especie
          </Label>
          <Input
            id="minExamples"
            name="minExamples"
            type="number"
            min={1}
            value={minExamples}
            onChange={(e) => {
              const next = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(next) && next >= 1) {
                setMinExamples(next);
              }
            }}
            disabled={isPending}
          />
        </div>
        <Button type="submit" disabled={isPending || previewLoading}>
          {isPending ? "Exportando…" : "Exportar"}
        </Button>
      </form>

      {isPending && (
        <p className="mt-3 text-xs text-muted-foreground">
          Esto puede tardar varios minutos. No cierres la pestaña.
        </p>
      )}

      {error && (
        <div className="mt-3 rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-3 rounded border border-green-600/40 bg-green-600/10 p-3 text-sm">
          <p className="font-semibold">
            {result.status === "created"
              ? `Exporte creado: ${result.version}`
              : `Sin cambios — ya existía como ${result.version}`}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {result.imageCount.toLocaleString("es-EC")} imágenes ·{" "}
            {result.classCount} clases
          </p>
          {result.warnings.length > 0 && (
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                {result.warnings.length} advertencias durante el recorte
              </summary>
              <ul className="mt-1 ml-4 list-disc max-h-40 overflow-y-auto">
                {result.warnings.slice(0, 50).map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

function SplitCell({
  count,
  deployments,
  names,
}: {
  count: number;
  deployments: number;
  names: string[];
}) {
  if (count === 0) {
    return <span className="text-muted-foreground">0</span>;
  }
  const inner = (
    <span className="cursor-help underline decoration-dotted decoration-muted-foreground/40 underline-offset-2">
      {count.toLocaleString("es-EC")}{" "}
      <span className="text-xs text-muted-foreground">({deployments})</span>
    </span>
  );
  if (deployments === 0 || names.length === 0) return inner;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{inner}</TooltipTrigger>
      <TooltipContent side="left" className="max-w-xs">
        <div className="font-medium mb-1">
          {deployments}{" "}
          {deployments === 1 ? "instalación" : "instalaciones"}
        </div>
        <div className="text-left leading-snug">
          {names.join(", ")}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function PreviewCard({
  preview,
  loading,
  error,
}: {
  preview: ExportPreview | null;
  loading: boolean;
  error: string | null;
}) {
  if (error) {
    return (
      <div className="rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        Error cargando la vista previa: {error}
      </div>
    );
  }

  if (!preview && loading) {
    return (
      <div className="rounded border p-3 text-sm text-muted-foreground animate-pulse">
        Calculando vista previa…
      </div>
    );
  }

  if (!preview) return null;

  const droppedEntries = Object.entries(preview.droppedSpecies).sort(
    (a, b) => b[1] - a[1],
  );

  return (
    <div
      className={`rounded border p-3 ${loading ? "opacity-60" : ""}`}
      aria-busy={loading}
    >
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
        <span className="font-semibold">
          Vista previa — umbral {preview.minExamples}
        </span>
        <span className="text-muted-foreground">
          {preview.totalCandidates.toLocaleString("es-EC")} detecciones
          verificadas
        </span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">
          {preview.classList.length} especies
        </span>
        <span className="text-muted-foreground">·</span>
        <span className="text-muted-foreground">
          {preview.deploymentCount} instalaciones
        </span>
      </div>

      {preview.migrationApplied && (
        <div className="mt-2 rounded border border-amber-500/40 bg-amber-50 p-2 text-xs text-amber-800">
          ⚠ El próximo exporte aplicará el algoritmo de estratificación
          v{preview.splitStrategyVersion}. Todos los splits persistidos se
          recalcularán para garantizar al menos una instalación en
          val + test por cada especie con ≥3 instalaciones.
        </div>
      )}

      {preview.newDeploymentSplits > 0 && !preview.migrationApplied && (
        <p className="mt-1 text-xs text-amber-700">
          ⚠ {preview.newDeploymentSplits}{" "}
          {preview.newDeploymentSplits === 1
            ? "instalación recibirá un split nuevo"
            : "instalaciones recibirán un split nuevo"}{" "}
          en el próximo exporte.
        </p>
      )}

      {preview.perSpecies.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Ninguna especie alcanza el umbral de {preview.minExamples} ejemplos.
          {droppedEntries.length > 0 && (
            <> Reducí el umbral para incluir más especies.</>
          )}
        </p>
      ) : (
        <TooltipProvider delayDuration={150}>
        <div className="mt-3 overflow-x-auto">
          <p className="text-xs text-muted-foreground mb-1">
            Entre paréntesis: número de instalaciones distintas (hover para ver
            nombres).
          </p>
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-1 pr-3 font-normal">Especie</th>
                <th className="py-1 px-2 font-normal text-right">Train</th>
                <th className="py-1 px-2 font-normal text-right">Val</th>
                <th className="py-1 px-2 font-normal text-right">Test</th>
                <th className="py-1 pl-2 font-normal text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {preview.perSpecies.map((row) => (
                <tr key={row.label} className="border-t">
                  <td className="py-1 pr-3 italic font-mono text-xs">
                    {row.label}
                  </td>
                  <td className="py-1 px-2 text-right tabular-nums">
                    <SplitCell
                      count={row.train}
                      deployments={row.trainDeployments}
                      names={row.trainDeploymentNames}
                    />
                  </td>
                  <td className="py-1 px-2 text-right tabular-nums">
                    <SplitCell
                      count={row.val}
                      deployments={row.valDeployments}
                      names={row.valDeploymentNames}
                    />
                  </td>
                  <td className="py-1 px-2 text-right tabular-nums">
                    <SplitCell
                      count={row.test}
                      deployments={row.testDeployments}
                      names={row.testDeploymentNames}
                    />
                  </td>
                  <td className="py-1 pl-2 text-right tabular-nums font-semibold">
                    {row.total.toLocaleString("es-EC")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </TooltipProvider>
      )}

      {preview.forcedReassignments.length > 0 && (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            {preview.forcedReassignments.length}{" "}
            {preview.forcedReassignments.length === 1
              ? "reasignación"
              : "reasignaciones"}{" "}
            por estratificación (garantía val/test para especies raras)
          </summary>
          <ul className="mt-1 ml-4 list-disc max-h-40 overflow-y-auto">
            {preview.forcedReassignments.map((r) => (
              <li key={`${r.label}-${r.deploymentId}`}>
                <span className="font-mono">{r.label}</span> —{" "}
                <span className="font-mono text-muted-foreground">
                  {r.deploymentName}
                </span>{" "}
                movido de <strong>{r.from}</strong> a{" "}
                <strong>{r.to}</strong>
              </li>
            ))}
          </ul>
        </details>
      )}

      {droppedEntries.length > 0 && (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            {droppedEntries.length} especies por debajo de los umbrales
            (≥{preview.minExamples} ejemplos y ≥{preview.minDeployments}{" "}
            instalaciones)
          </summary>
          <ul className="mt-1 ml-4 list-disc max-h-40 overflow-y-auto">
            {droppedEntries.map(([label, count]) => {
              const deps = preview.droppedDeployments[label] ?? 0;
              return (
                <li key={label}>
                  <span className="font-mono">{label}</span> — {count}{" "}
                  ejemplos en {deps}{" "}
                  {deps === 1 ? "instalación" : "instalaciones"}
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
}
