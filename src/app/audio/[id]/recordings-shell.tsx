"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/status-badge";
import { CollapsibleSection } from "@/components/collapsible-section";
import { AudioActionsMenu } from "./audio-actions-menu";
import { AudioMetadataSection } from "./audio-metadata-section";
import { AudioQaSection } from "./audio-qa-section";
import { ConfidenceThresholdSlider } from "@/components/audio/confidence-threshold-slider";
import type { AudioFileRow } from "../actions";
import {
  buildCells,
  computeDomain,
  metricToFill,
  RASTER_METRIC_KEYS,
  RASTER_METRIC_LABELS,
  type RasterCell,
  type RasterMetricKey,
} from "@/lib/recordings-raster";
import { RecordingsRaster } from "./recordings-raster";

interface DeploymentInfo {
  id: number;
  name: string;
  siteName: string | null;
  dateStart: string | null;
  dateEnd: string | null;
  latitude: number | null;
  longitude: number | null;
  ctProjectName: string | null;
  excluded: boolean;
  qaNotes: string | null;
  fieldNotes: string | null;
  uploadAudioFolderId: string | null;
}

interface BirdnetStats {
  totalDetections: number;
  totalSpecies: number;
  verified: number;
  pending: number;
}

function ReviewProgress({ reviewed, total }: { reviewed: number; total: number }) {
  const pct = total > 0 ? Math.round((reviewed / total) * 100) : 0;
  const isComplete = reviewed >= total;
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground">·</span>
      <div className="w-32 h-2 rounded-full bg-muted overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${isComplete ? "bg-emerald-500" : "bg-blue-500"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className={`tabular-nums ${isComplete ? "text-emerald-600 font-medium" : ""}`}>
        {reviewed.toLocaleString()}/{total.toLocaleString()} revisadas
      </span>
    </div>
  );
}

export function RecordingsShell({
  deployment,
  files,
  isEditor,
  isAdmin = false,
  displayStatus = "unscanned",
  isBirdnetProcessing = false,
  birdnetStats = null,
  hasBirdnetDetections = false,
  isAcousticIndicesProcessing = false,
  isAudioAnalysisProcessing = false,
  isAudioCompressionProcessing = false,
  uncompressedFileCount = 0,
  revertibleFileCount = 0,
  reviewStats = null,
}: {
  deployment: DeploymentInfo;
  files: AudioFileRow[];
  isEditor: boolean;
  isAdmin?: boolean;
  displayStatus?: string;
  isBirdnetProcessing?: boolean;
  birdnetStats?: BirdnetStats | null;
  hasBirdnetDetections?: boolean;
  isAcousticIndicesProcessing?: boolean;
  isAudioAnalysisProcessing?: boolean;
  isAudioCompressionProcessing?: boolean;
  uncompressedFileCount?: number;
  revertibleFileCount?: number;
  reviewStats?: { verified: number; total: number } | null;
}) {
  const router = useRouter();
  const [metricKey, setMetricKey] = useState<RasterMetricKey>("detectionCount");

  // Which acoustic-index metrics are available depends on whether any rows have
  // them computed. Detection count is always available once BirdNET has run.
  const availableMetrics = useMemo(() => {
    const available: Record<RasterMetricKey, boolean> = {
      detectionCount: true,
      soundscapeSaturation: false,
      acousticComplexityIndex: false,
      frequencyEntropy: false,
      temporalEntropy: false,
      eventsPerSecond: false,
    };
    for (const f of files) {
      if (f.soundscapeSaturation !== null) available.soundscapeSaturation = true;
      if (f.acousticComplexityIndex !== null) available.acousticComplexityIndex = true;
      if (f.frequencyEntropy !== null) available.frequencyEntropy = true;
      if (f.temporalEntropy !== null) available.temporalEntropy = true;
      if (f.eventsPerSecond !== null) available.eventsPerSecond = true;
    }
    return available;
  }, [files]);

  const { cells, dates, domain, skippedCount } = useMemo(() => {
    const built = buildCells(files, metricKey);
    return {
      cells: built.cells,
      dates: built.dates,
      skippedCount: built.skippedCount,
      domain: computeDomain(built.cells),
    };
  }, [files, metricKey]);

  function handleClickCell(cell: RasterCell) {
    router.push(`/audio/${deployment.id}/annotate/${cell.fileId}`);
  }

  return (
    <div className="max-w-screen-2xl mx-auto space-y-3">
      {/* Status banner */}
      <div className="rounded-lg border bg-card px-4 py-2.5">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0 flex-wrap">
            <Link href="/audio">
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <ArrowLeft className="h-4 w-4" />
              </Button>
            </Link>
            <h1 className="text-lg font-bold shrink-0">{deployment.name}</h1>
            <StatusBadge status={displayStatus} type="audio-deployment" />
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              {files.length > 0 && (
                <span>{files.length.toLocaleString()} grabaciones</span>
              )}
              {birdnetStats && birdnetStats.totalDetections > 0 && (
                <span>
                  · {birdnetStats.totalDetections.toLocaleString()} detecciones · {birdnetStats.totalSpecies} especies
                </span>
              )}
              {reviewStats && reviewStats.total > 0 && (
                <ReviewProgress
                  reviewed={reviewStats.verified}
                  total={reviewStats.total}
                />
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {isEditor && (
              <AudioActionsMenu
                deploymentId={deployment.id}
                deploymentName={deployment.name}
                uploadAudioFolderId={deployment.uploadAudioFolderId}
                isBirdnetProcessing={isBirdnetProcessing}
                hasBirdnetDetections={hasBirdnetDetections}
                isAcousticIndicesProcessing={isAcousticIndicesProcessing}
                isAudioAnalysisProcessing={isAudioAnalysisProcessing}
                isAudioCompressionProcessing={isAudioCompressionProcessing}
                canAdmin={isAdmin}
                uncompressedFileCount={uncompressedFileCount}
                revertibleFileCount={revertibleFileCount}
                hasFiles={files.length > 0}
              />
            )}
          </div>
        </div>

        {hasBirdnetDetections && (
          <div className="mt-2">
            <ConfidenceThresholdSlider className="max-w-md" />
          </div>
        )}

        <div className="mt-2 border-t pt-2">
          <CollapsibleSection title="Detalles" defaultOpen={false}>
            {deployment.fieldNotes && (
              <div className="rounded-md border bg-amber-50 dark:bg-amber-950/20 px-3 py-2 mb-4">
                <p className="text-muted-foreground text-xs font-medium uppercase tracking-wide mb-0.5">
                  Notas de campo
                </p>
                <p className="text-sm whitespace-pre-wrap">{deployment.fieldNotes}</p>
              </div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <AudioMetadataSection
                deployment={deployment}
                fileCount={files.length}
              />
              <AudioQaSection
                deploymentId={deployment.id}
                canEdit={isEditor}
                excluded={deployment.excluded ?? false}
                qaNotes={deployment.qaNotes}
              />
            </div>
          </CollapsibleSection>
        </div>
      </div>

      {/* Raster + controls */}
      {files.length === 0 ? (
        <div className="rounded-lg border bg-card px-6 py-10 text-center text-muted-foreground">
          {isEditor
            ? 'No hay archivos escaneados. Usa "Acciones → Escanear archivos" para buscar archivos en Drive.'
            : "No hay archivos de audio."}
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-3 flex-wrap">
            <label className="text-sm font-medium" htmlFor="raster-metric">
              Métrica:
            </label>
            <select
              id="raster-metric"
              value={metricKey}
              onChange={(e) => setMetricKey(e.target.value as RasterMetricKey)}
              className="rounded-md border bg-background px-2 py-1 text-sm"
            >
              {RASTER_METRIC_KEYS.map((key) => {
                const available = availableMetrics[key];
                return (
                  <option key={key} value={key} disabled={!available}>
                    {RASTER_METRIC_LABELS[key]}
                    {!available ? " — sin calcular" : ""}
                  </option>
                );
              })}
            </select>

            <RasterLegend domain={domain} metricKey={metricKey} />

            {skippedCount > 0 && (
              <span className="text-xs text-muted-foreground">
                {skippedCount} archivo{skippedCount === 1 ? "" : "s"} sin fecha (omitido{skippedCount === 1 ? "" : "s"})
              </span>
            )}
          </div>

          <RecordingsRaster
            cells={cells}
            dates={dates}
            domain={domain}
            metricKey={metricKey}
            onClickCell={handleClickCell}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inline legend — gradient strip + min/max labels + unscanned swatch
// ---------------------------------------------------------------------------

function RasterLegend({
  domain,
  metricKey,
}: {
  domain: readonly [number, number];
  metricKey: RasterMetricKey;
}) {
  const [lo, hi] = domain;
  const noSignal = hi === 0;
  const format = metricKey === "detectionCount"
    ? (n: number) => n.toLocaleString()
    : (n: number) => n.toFixed(2);

  if (noSignal) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span
          className="inline-block h-3 w-3 rounded-sm border"
          style={{ background: "var(--raster-unscanned)" }}
          aria-hidden
        />
        <span>Sin valores para esta métrica</span>
      </div>
    );
  }

  const gradient = `linear-gradient(to right, ${metricToFill(lo, domain)}, ${metricToFill(hi * 0.5, domain)}, ${metricToFill(hi, domain)})`;

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="tabular-nums text-muted-foreground">{format(lo)}</span>
      <div
        className="h-3 w-32 rounded border"
        style={{ background: gradient }}
        aria-hidden
      />
      <span className="tabular-nums text-muted-foreground">{format(hi)}</span>
      <span className="ml-3 flex items-center gap-1">
        <span
          className="inline-block h-3 w-3 rounded-sm border"
          style={{ background: "var(--raster-unscanned)" }}
          aria-hidden
        />
        <span className="text-muted-foreground">Sin escanear</span>
      </span>
    </div>
  );
}
