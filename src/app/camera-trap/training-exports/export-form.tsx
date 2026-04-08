"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

      {preview.newDeploymentSplits > 0 && (
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
        <div className="mt-3 overflow-x-auto">
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
                  <td
                    className="py-1 pr-3 italic font-mono text-xs"
                    title={row.slug}
                  >
                    {row.label}
                  </td>
                  <td className="py-1 px-2 text-right tabular-nums">
                    {row.train.toLocaleString("es-EC")}
                  </td>
                  <td className="py-1 px-2 text-right tabular-nums">
                    {row.val.toLocaleString("es-EC")}
                  </td>
                  <td className="py-1 px-2 text-right tabular-nums">
                    {row.test.toLocaleString("es-EC")}
                  </td>
                  <td className="py-1 pl-2 text-right tabular-nums font-semibold">
                    {row.total.toLocaleString("es-EC")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {droppedEntries.length > 0 && (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer text-muted-foreground">
            {droppedEntries.length} especies por debajo del umbral
          </summary>
          <ul className="mt-1 ml-4 list-disc max-h-40 overflow-y-auto">
            {droppedEntries.map(([label, count]) => (
              <li key={label}>
                <span className="font-mono">{label}</span> — {count}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
