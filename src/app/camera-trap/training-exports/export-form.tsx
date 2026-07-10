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
  type ExportDispatchResult,
} from "./actions";
// Type-only import (erased at build → no node:crypto in the client bundle).
import type { PreviewDeltaRow } from "@/lib/training-export-helpers";

const DEFAULT_MIN_EXAMPLES = 50;
const DEFAULT_CONFIDENCE_FLOOR = 0.1;
const DEFAULT_CROP_PADDING = 0.05;
const DEFAULT_CROP_LONG_EDGE = 512;
const DEFAULT_JPEG_QUALITY = 90;
const PREVIEW_DEBOUNCE_MS = 300;

export function ExportForm() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [result, setResult] = useState<ExportDispatchResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [minExamples, setMinExamples] = useState(DEFAULT_MIN_EXAMPLES);
  // Crop-quality knobs (advanced). Only the confidence floor changes which
  // detections qualify, so only it re-runs the preview.
  const [confidenceFloor, setConfidenceFloor] = useState(
    DEFAULT_CONFIDENCE_FLOOR,
  );
  const [cropPadding, setCropPadding] = useState(DEFAULT_CROP_PADDING);
  const [cropLongEdge, setCropLongEdge] = useState(DEFAULT_CROP_LONG_EDGE);
  const [jpegQuality, setJpegQuality] = useState(DEFAULT_JPEG_QUALITY);
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(true);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Debounced preview fetch — re-runs whenever minExamples or the confidence
  // floor changes. Loading flag flips inside the timeout (not synchronously in
  // the effect body) to avoid cascading renders per the React lint rule.
  useEffect(() => {
    if (!Number.isFinite(minExamples) || minExamples < 1) return;
    let cancelled = false;
    const handle = setTimeout(async () => {
      if (cancelled) return;
      setPreviewLoading(true);
      setPreviewError(null);
      const res = await getExportPreview(minExamples, confidenceFloor);
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
  }, [minExamples, confidenceFloor]);

  function handleSubmit(formData: FormData) {
    setError(null);
    setResult(null);
    startTransition(async () => {
      const res = await exportTrainingDataset(formData);
      if (res.success) {
        setResult(res.data);
        // A started export runs in the background — wake the floating progress
        // bar so it picks the job up immediately instead of on its next poll.
        if (res.data.kind === "started") {
          window.dispatchEvent(new Event("job-started"));
        }
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

      <form action={handleSubmit} className="mt-4">
        <div className="flex items-end gap-3">
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
        </div>

        <details className="mt-3 text-sm">
          <summary className="cursor-pointer text-muted-foreground select-none">
            Opciones avanzadas — calidad de recorte
          </summary>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <Label htmlFor="detectionConfidenceFloor" className="text-xs">
                Confianza mínima (MegaDetector)
              </Label>
              <Input
                id="detectionConfidenceFloor"
                name="detectionConfidenceFloor"
                type="number"
                min={0.1}
                max={1}
                step={0.05}
                value={confidenceFloor}
                onChange={(e) => {
                  const next = Number.parseFloat(e.target.value);
                  if (Number.isFinite(next)) setConfidenceFloor(next);
                }}
                disabled={isPending}
              />
              <p className="mt-1 text-[11px] leading-tight text-muted-foreground">
                Mínimo 0.1 — las detecciones por debajo de 0.1 no se almacenan
                y requerirían reprocesar las imágenes.
              </p>
            </div>
            <div>
              <Label htmlFor="cropPadding" className="text-xs">
                Padding del recorte
              </Label>
              <Input
                id="cropPadding"
                name="cropPadding"
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={cropPadding}
                onChange={(e) => {
                  const next = Number.parseFloat(e.target.value);
                  if (Number.isFinite(next)) setCropPadding(next);
                }}
                disabled={isPending}
              />
              <p className="mt-1 text-[11px] leading-tight text-muted-foreground">
                Fracción del bbox añadida como margen (0.05 = 5%).
              </p>
            </div>
            <div>
              <Label htmlFor="cropLongEdge" className="text-xs">
                Lado largo (px)
              </Label>
              <Input
                id="cropLongEdge"
                name="cropLongEdge"
                type="number"
                min={32}
                max={4096}
                step={32}
                value={cropLongEdge}
                onChange={(e) => {
                  const next = Number.parseInt(e.target.value, 10);
                  if (Number.isFinite(next)) setCropLongEdge(next);
                }}
                disabled={isPending}
              />
            </div>
            <div>
              <Label htmlFor="jpegQuality" className="text-xs">
                Calidad JPEG
              </Label>
              <Input
                id="jpegQuality"
                name="jpegQuality"
                type="number"
                min={1}
                max={100}
                step={1}
                value={jpegQuality}
                onChange={(e) => {
                  const next = Number.parseInt(e.target.value, 10);
                  if (Number.isFinite(next)) setJpegQuality(next);
                }}
                disabled={isPending}
              />
            </div>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            Cambiar cualquiera de estos valores genera una versión nueva del
            exporte (no se considera idéntico al anterior).
          </p>
        </details>
      </form>

      {error && (
        <div className="mt-3 rounded border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-3 rounded border border-green-600/40 bg-green-600/10 p-3 text-sm">
          {result.kind === "started" ? (
            <>
              <p className="font-semibold">
                Exporte {result.version} iniciado
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                Generando recortes en segundo plano. Sigue el progreso en la
                barra inferior — puedes cerrar esta pestaña o cancelarlo desde
                ahí.
              </p>
            </>
          ) : (
            <p className="font-semibold">
              Sin cambios — ya existía como {result.version}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Inline +N / −N delta vs. the last export. Suppressed for a zero/absent
 * delta. Sign is explicit (so it reads without color too); the magnitude is
 * es-EC formatted. Hover shows the previous value. */
function DeltaBadge({
  delta,
  previous,
}: {
  delta: number | null | undefined;
  previous: number | null | undefined;
}) {
  if (delta == null || delta === 0) return null;
  // U+2212 minus for a typographically consistent negative sign.
  const sign = delta > 0 ? "+" : "−";
  const text = `${sign}${Math.abs(delta).toLocaleString("es-EC")}`;
  const color = delta > 0 ? "text-emerald-600" : "text-red-600";
  const badge = <span className={`ml-1 text-xs font-medium ${color}`}>{text}</span>;
  if (previous == null) return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help">{badge}</span>
      </TooltipTrigger>
      <TooltipContent side="top">
        Antes: {previous.toLocaleString("es-EC")}
      </TooltipContent>
    </Tooltip>
  );
}

function SplitCell({
  count,
  deployments,
  names,
  delta,
  previous,
  external,
}: {
  count: number;
  deployments: number;
  names: string[];
  delta?: number | null;
  previous?: number | null;
  /** External (LILA) images included in this count; shown as a "+N LILA" badge. */
  external?: number;
}) {
  const deltaBadge = <DeltaBadge delta={delta} previous={previous} />;
  const externalBadge =
    external && external > 0 ? (
      <span
        className="ml-1 text-[10px] font-medium text-amber-600"
        title="Imágenes externas (LILA) incluidas en train"
      >
        +{external.toLocaleString("es-EC")} LILA
      </span>
    ) : null;

  if (count === 0) {
    return (
      <span>
        <span className="text-muted-foreground">0</span>
        {deltaBadge}
      </span>
    );
  }
  const inner = (
    <span className="cursor-help underline decoration-dotted decoration-muted-foreground/40 underline-offset-2">
      {count.toLocaleString("es-EC")}{" "}
      <span className="text-xs text-muted-foreground">({deployments})</span>
    </span>
  );
  const countEl =
    deployments === 0 || names.length === 0 ? (
      inner
    ) : (
      <Tooltip>
        <TooltipTrigger asChild>{inner}</TooltipTrigger>
        <TooltipContent side="left" className="max-w-xs">
          <div className="font-medium mb-1">
            {deployments}{" "}
            {deployments === 1 ? "instalación" : "instalaciones"}
          </div>
          <div className="text-left leading-snug">{names.join(", ")}</div>
        </TooltipContent>
      </Tooltip>
    );
  return (
    <span>
      {countEl}
      {externalBadge}
      {deltaBadge}
    </span>
  );
}

/** One per-species row of the preview table: counts + inline deltas vs. the
 * last export. `new` classes get a badge; `removed` classes render muted as a
 * ghost row (zero current, negative deltas) so removals stay visible. */
function SpeciesDeltaRow({ row }: { row: PreviewDeltaRow }) {
  const removed = row.status === "removed";
  return (
    <tr className={`border-t ${removed ? "text-muted-foreground/70" : ""}`}>
      <td className="py-1 pr-3 italic font-mono text-xs">
        {row.label}
        {row.status === "new" && (
          <span className="ml-1 not-italic font-sans rounded bg-emerald-100 px-1 text-[10px] font-medium text-emerald-700">
            nuevo
          </span>
        )}
      </td>
      <td className="py-1 px-2 text-right tabular-nums">
        <SplitCell
          count={row.train}
          deployments={row.trainDeployments}
          names={row.trainDeploymentNames}
          delta={row.delta?.train}
          previous={row.baseline?.train}
          external={row.trainExternal}
        />
      </td>
      <td className="py-1 px-2 text-right tabular-nums">
        <SplitCell
          count={row.val}
          deployments={row.valDeployments}
          names={row.valDeploymentNames}
          delta={row.delta?.val}
          previous={row.baseline?.val}
        />
      </td>
      <td className="py-1 px-2 text-right tabular-nums">
        <SplitCell
          count={row.test}
          deployments={row.testDeployments}
          names={row.testDeploymentNames}
          delta={row.delta?.test}
          previous={row.baseline?.test}
        />
      </td>
      <td className="py-1 pl-2 text-right tabular-nums font-semibold">
        {row.total.toLocaleString("es-EC")}
        <DeltaBadge delta={row.delta?.total} previous={row.baseline?.total} />
      </td>
    </tr>
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

  // Current totals per split (ghost rows contribute 0, so this is the live
  // candidate total) — used for the footer row alongside the footer delta.
  const totals = preview.deltaRows.reduce(
    (acc, row) => {
      acc.train += row.train;
      acc.val += row.val;
      acc.test += row.test;
      acc.total += row.total;
      return acc;
    },
    { train: 0, val: 0, test: 0, total: 0 },
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
          {preview.baseline ? (
            <p className="text-xs text-muted-foreground mb-1">
              Δ vs. último exporte {preview.baseline.version} ·{" "}
              {new Date(preview.baseline.createdAt).toLocaleDateString("es-EC")}{" "}
              · umbral {preview.baseline.minExamplesThreshold} ·{" "}
              <span className="text-emerald-600">+más</span> /{" "}
              <span className="text-red-600">−menos</span>
            </p>
          ) : (
            <p className="text-xs text-muted-foreground mb-1">
              Sin exporte previo para comparar.
            </p>
          )}
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
              {preview.deltaRows.map((row) => (
                <SpeciesDeltaRow key={row.folderName} row={row} />
              ))}
            </tbody>
            {preview.deltaFooter && (
              <tfoot>
                <tr className="border-t-2 font-semibold">
                  <td className="py-1 pr-3 text-xs text-muted-foreground">
                    Total
                  </td>
                  <td className="py-1 px-2 text-right tabular-nums">
                    {totals.train.toLocaleString("es-EC")}
                    <DeltaBadge
                      delta={preview.deltaFooter.train}
                      previous={totals.train - preview.deltaFooter.train}
                    />
                  </td>
                  <td className="py-1 px-2 text-right tabular-nums">
                    {totals.val.toLocaleString("es-EC")}
                    <DeltaBadge
                      delta={preview.deltaFooter.val}
                      previous={totals.val - preview.deltaFooter.val}
                    />
                  </td>
                  <td className="py-1 px-2 text-right tabular-nums">
                    {totals.test.toLocaleString("es-EC")}
                    <DeltaBadge
                      delta={preview.deltaFooter.test}
                      previous={totals.test - preview.deltaFooter.test}
                    />
                  </td>
                  <td className="py-1 pl-2 text-right tabular-nums">
                    {totals.total.toLocaleString("es-EC")}
                    <DeltaBadge
                      delta={preview.deltaFooter.total}
                      previous={totals.total - preview.deltaFooter.total}
                    />
                  </td>
                </tr>
              </tfoot>
            )}
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
