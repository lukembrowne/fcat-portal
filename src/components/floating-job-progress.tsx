"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import { X, Minus, ChevronUp, ChevronDown, Clock, Loader2, CheckCircle2, XCircle, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/format-duration";
import { cancelQueue } from "@/app/camera-trap/actions";
import { cancelProcessingJob } from "@/app/audio/actions";
import { useActiveJobs } from "@/hooks/use-active-jobs";

interface SSEData {
  jobId: number;
  status: string;
  processed: number;
  total: number;
  failed: number;
  statusMessage?: string;
  jobType?: string;
  startedAt?: string | null;
  downloadedImages?: number;
  downloadTotal?: number;
  cachedImages?: number;
}

export function FloatingJobProgress() {
  const {
    allJobs,
    processingJob,
    pendingJobs,
    totalQueueSize,
    currentQueuePosition,
    hasQueue,
    newJobDetected,
  } = useActiveJobs();

  const [sseData, setSseData] = useState<SSEData | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [showQueue, setShowQueue] = useState(false);

  const [elapsed, setElapsed] = useState<string | null>(null);

  const eventSourceRef = useRef<EventSource | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sseErrorCountRef = useRef(0);
  const [sseRetryTrigger, setSseRetryTrigger] = useState(0);

  const activeJob = processingJob ?? allJobs[0] ?? null;

  // Reset UI state when a new job is detected
  useEffect(() => {
    if (newJobDetected === 0) return;
    setDismissed(false);
    setMinimized(false);
    setSseData(null);
    setCancelling(false);
  }, [newJobDetected]);

  // SSE connection — connects when we have a processing job
  useEffect(() => {
    const jobId = processingJob?.jobId;
    if (!jobId) {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      return;
    }

    // Don't reconnect if we already have SSE for this job
    if (
      eventSourceRef.current &&
      sseData?.jobId === jobId &&
      sseData.status !== "completed" &&
      sseData.status !== "failed" &&
      sseData.status !== "cancelled"
    ) {
      return;
    }

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const es = new EventSource(`/api/progress?jobId=${jobId}`);
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data: SSEData = JSON.parse(event.data);
        sseErrorCountRef.current = 0;
        setSseData(data);

        if (["completed", "failed", "cancelled"].includes(data.status)) {
          es.close();
          eventSourceRef.current = null;
          window.dispatchEvent(new Event("jobs-updated"));
        }
      } catch {
        // Ignore parse errors
      }
    };

    es.onerror = () => {
      es.close();
      eventSourceRef.current = null;
      if (sseErrorCountRef.current < 5) {
        sseErrorCountRef.current++;
        setTimeout(() => setSseRetryTrigger((n) => n + 1), 2000);
      }
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [processingJob?.jobId, sseRetryTrigger]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-dismiss after terminal state (only when no pending jobs remain)
  const status = sseData?.status;
  useEffect(() => {
    if (
      (status === "completed" || status === "failed" || status === "cancelled") &&
      pendingJobs.length === 0
    ) {
      dismissTimerRef.current = setTimeout(() => {
        setDismissed(true);
      }, 8000);
    }
    return () => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    };
  }, [status, pendingJobs.length]);

  // Elapsed time timer
  const startedAtStr = sseData?.startedAt ?? activeJob?.startedAt ?? null;
  const isTerminalStatus = status === "completed" || status === "failed" || status === "cancelled";
  useEffect(() => {
    if (!startedAtStr) {
      setElapsed(null);
      return;
    }
    const startMs = new Date(startedAtStr).getTime();
    if (isTerminalStatus) {
      setElapsed(formatDuration(Date.now() - startMs));
      return;
    }
    const update = () => setElapsed(formatDuration(Date.now() - startMs));
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [startedAtStr, isTerminalStatus]);

  // Nothing to show
  const hasJob = activeJob || (sseData && !dismissed);
  if (!hasJob || dismissed) return null;

  const jobId = sseData?.jobId || activeJob?.jobId;
  const displayName = activeJob?.displayName || "Trabajo";
  const isTerminal = isTerminalStatus;
  const jobType = sseData?.jobType ?? activeJob?.jobType ?? "ml";
  const isCompression = jobType === "compression";
  const isRevert = jobType === "revert_compression";
  const isAudioCompression = jobType === "audio_compression";
  const isAudioRevert = jobType === "revert_audio_compression";
  const isBirdnet = jobType === "birdnet";
  const isAcousticIndices = jobType === "acoustic_indices";
  const isAudioAnalysis = jobType === "audio_analysis";
  const isCompressionLike =
    isCompression || isRevert || isAudioCompression || isAudioRevert;
  const isDriveSync = jobType === "drive_sync" || jobType === "audio_sync";
  const isAudioJob =
    isBirdnet ||
    isAcousticIndices ||
    isAudioAnalysis ||
    isAudioCompression ||
    isAudioRevert;
  const isLinkable =
    !isCompressionLike && !isDriveSync && !isAudioJob;
  const unitLabel = isDriveSync
    ? "instalaciones"
    : isAudioJob
      ? "archivos"
      : "imágenes";
  const canCancel = activeJob?.canCancel ?? false;
  const dlTotal = sseData?.downloadTotal ?? activeJob?.downloadTotal ?? 0;
  const dlDone = sseData?.downloadedImages ?? activeJob?.downloadedImages ?? 0;
  const isDownloading = status === "processing" && dlTotal > 0 && dlDone < dlTotal;
  const isAnalyzing = status === "processing" && (sseData?.processed ?? 0) > 0;
  const hasProgress = isDownloading || isAnalyzing;
  const processed = sseData?.processed ?? activeJob?.processedImages ?? 0;
  const total = sseData?.total ?? activeJob?.totalImages ?? 0;
  const percentage = isDownloading
    ? dlTotal > 0 ? Math.round((dlDone / dlTotal) * 100) : 0
    : total > 0 ? Math.round((processed / total) * 100) : 0;

  // ETA for download phase OR processing phase (compression/ML/revert)
  let etaStr: string | null = null;
  if (isDownloading && dlDone > 0 && startedAtStr) {
    const elapsedMs = Date.now() - new Date(startedAtStr).getTime();
    const rate = dlDone / (elapsedMs / 1000);
    const remaining = dlTotal - dlDone;
    const etaMs = rate > 0 ? (remaining / rate) * 1000 : 0;
    if (etaMs > 0) {
      etaStr = `~${formatDuration(etaMs)} restante`;
    }
  } else if (status === "processing" && processed > 0 && processed < total && startedAtStr) {
    const elapsedMs = Date.now() - new Date(startedAtStr).getTime();
    const rate = processed / (elapsedMs / 1000);
    const remaining = total - processed;
    const etaMs = rate > 0 ? (remaining / rate) * 1000 : 0;
    if (etaMs > 0) {
      etaStr = `~${formatDuration(etaMs)} restante`;
    }
  }

  const rawStatusMessage = isTerminal
    ? status === "completed"
      ? "Completado"
      : status === "cancelled"
        ? "Cancelado"
        : "Fallido"
    : sseData?.statusMessage || activeJob?.statusMessage || "Esperando inicio...";
  // Strip trailing "(N de M)" — shown on its own row below the bar
  const statusMessage = rawStatusMessage.replace(/\s*\(\d+\s+de\s+\d+\)\s*$/, "");

  const statusColor = isTerminal
    ? status === "completed"
      ? "text-green-700 dark:text-green-500"
      : status === "cancelled"
        ? "text-orange-700 dark:text-orange-500"
        : "text-red-700 dark:text-red-500"
    : "text-foreground";

  const handleCancel = async () => {
    if (!jobId || cancelling) return;
    setCancelling(true);
    if (hasQueue) {
      const result = await cancelQueue();
      if (!result.success) {
        alert(`Error al cancelar cola: ${result.error}`);
        setCancelling(false);
      }
    } else {
      const result = await cancelProcessingJob(jobId);
      if (!result.success) {
        alert(`Error al cancelar: ${result.error}`);
        setCancelling(false);
      }
    }
  };

  if (minimized) {
    return (
      <div className="fixed bottom-4 right-4 z-50">
        <button
          onClick={() => setMinimized(false)}
          className={cn(
            "flex items-center gap-2 rounded-full px-4 py-2 shadow-lg border text-sm font-medium",
            "bg-background hover:bg-accent transition-colors",
            isTerminal && status === "completed" && "border-green-300",
            isTerminal && status === "failed" && "border-red-300",
            isTerminal && status === "cancelled" && "border-orange-300",
            !isTerminal && "border-primary/40"
          )}
        >
          <span
            className={cn(
              "w-2 h-2 rounded-full",
              isTerminal
                ? status === "completed"
                  ? "bg-green-500"
                  : status === "cancelled"
                    ? "bg-orange-500"
                    : "bg-red-500"
                : "bg-primary animate-pulse"
            )}
          />
          <span>
            {hasQueue
              ? `Procesando ${currentQueuePosition} de ${totalQueueSize}`
              : isCompression
                ? "Comprimiendo..."
                : isRevert
                  ? "Revirtiendo..."
                  : isBirdnet
                    ? "Análisis BirdNET..."
                    : isAcousticIndices
                      ? "Índices acústicos..."
                      : isAudioAnalysis
                        ? "Análisis acústico..."
                        : isDriveSync
                          ? "Sincronizando..."
                          : `Trabajo #${jobId}`}
          </span>
          <ChevronUp className="h-3 w-3" />
        </button>
      </div>
    );
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 w-80 rounded-lg border bg-background shadow-xl">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium truncate">{displayName}</p>
          <p className="text-xs text-muted-foreground">
            {hasQueue
              ? `Procesando ${currentQueuePosition} de ${totalQueueSize}`
              : isCompression
                ? "Compresión de imágenes"
                : isRevert
                  ? "Revirtiendo compresión"
                  : isBirdnet
                    ? "Análisis BirdNET"
                    : isAcousticIndices
                      ? "Índices acústicos"
                      : isAudioAnalysis
                        ? "Análisis acústico (BirdNET + índices)"
                        : isDriveSync
                          ? "Sincronización con Drive"
                          : `Trabajo #${jobId}`}
          </p>
        </div>
        <div className="flex items-center gap-1 ml-2 shrink-0">
          <button
            onClick={() => setMinimized(true)}
            className="p-1 rounded hover:bg-accent transition-colors"
            title="Minimizar"
          >
            <Minus className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
          <button
            onClick={() => setDismissed(true)}
            className="p-1 rounded hover:bg-accent transition-colors"
            title="Cerrar"
          >
            <X className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="px-3 py-3 space-y-2.5">
        {/* Status message + percent */}
        <div className="flex items-start justify-between gap-3">
          <p className={cn("flex items-center gap-1.5 text-sm font-medium leading-tight", statusColor)}>
            {(() => {
              const Icon =
                status === "completed" ? CheckCircle2
                : status === "failed" ? XCircle
                : status === "cancelled" ? AlertCircle
                : status === "processing" ? Loader2
                : null;
              return Icon ? (
                <Icon
                  className={cn(
                    "h-3.5 w-3.5 shrink-0",
                    status === "processing" && "animate-spin"
                  )}
                />
              ) : null;
            })()}
            {statusMessage}
          </p>
          {(hasProgress || isTerminal) && (
            <span className={cn("flex items-baseline font-semibold tabular-nums leading-none tracking-tight shrink-0", statusColor)}>
              <span className="text-xl">{percentage}</span>
              <span className="ml-0.5 text-[10px] font-normal text-muted-foreground">%</span>
            </span>
          )}
        </div>

        {/* Progress bar */}
        <div className="space-y-1.5">
          <div className="h-2 bg-muted rounded-full overflow-hidden shadow-inner">
            {status === "processing" && !hasProgress ? (
              <div className="h-full w-full bg-primary/30 rounded-full relative overflow-hidden">
                <div className="absolute inset-0 bg-primary/60 rounded-full animate-pulse" />
              </div>
            ) : (
              <div
                className={cn(
                  "h-full transition-all duration-500 ease-out rounded-full",
                  isTerminal
                    ? status === "completed"
                      ? "bg-gradient-to-r from-green-600 to-green-500"
                      : status === "cancelled"
                        ? "bg-gradient-to-r from-orange-600 to-orange-500"
                        : "bg-gradient-to-r from-red-600 to-red-500"
                    : "bg-gradient-to-r from-primary to-primary/85 progress-shimmer"
                )}
                style={{ width: `${percentage}%` }}
              />
            )}
          </div>
          {(hasProgress || isTerminal) && (
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="tabular-nums truncate">
                {isDownloading
                  ? <>{dlDone} de {dlTotal} archivos</>
                  : <>{processed} de {total} {unitLabel}</>
                }
              </span>
              {(elapsed || etaStr) && (
                <span className="flex items-center gap-1 tabular-nums shrink-0">
                  <Clock className="h-3 w-3" />
                  {elapsed}
                  {elapsed && etaStr && <span className="text-muted-foreground/60">·</span>}
                  {etaStr}
                </span>
              )}
            </div>
          )}
          {!hasProgress && !isTerminal && elapsed && (
            <p className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
              <Clock className="h-3 w-3" />
              {elapsed}
            </p>
          )}
        </div>

        {/* Queue list (collapsible) */}
        {hasQueue && !isTerminal && (
          <div>
            <button
              onClick={() => setShowQueue(!showQueue)}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            >
              {showQueue ? (
                <ChevronUp className="h-3 w-3" />
              ) : (
                <ChevronDown className="h-3 w-3" />
              )}
              {pendingJobs.length} en cola
            </button>
            {showQueue && (
              <div className="mt-1 space-y-1">
                {pendingJobs.map((job) => (
                  <div
                    key={job.jobId}
                    className="text-xs text-muted-foreground flex items-center gap-1.5 pl-4"
                  >
                    <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40" />
                    {job.displayName}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-1 pt-1">
          {!isTerminal && (
            <>
              {isLinkable && (
                <Link
                  href={`/camera-trap/process?jobId=${jobId}`}
                  className="inline-flex h-7 items-center rounded px-2 text-xs font-medium text-primary hover:bg-accent transition-colors"
                >
                  Ver detalles
                </Link>
              )}
              {canCancel && (
                <button
                  onClick={handleCancel}
                  disabled={cancelling}
                  className="inline-flex h-7 items-center rounded px-2 text-xs font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors disabled:opacity-50"
                >
                  {cancelling
                    ? "Cancelando..."
                    : hasQueue
                      ? "Cancelar cola"
                      : "Cancelar"}
                </button>
              )}
            </>
          )}
          {status === "completed" && isLinkable && (
            <Link
              href={`/camera-trap/results/${jobId}`}
              className="inline-flex h-7 items-center rounded px-2 text-xs font-medium text-green-600 hover:bg-green-50 dark:hover:bg-green-950/30 transition-colors"
            >
              Ver resultados
            </Link>
          )}
          {status === "completed" && isDriveSync && (
            <span className="text-xs font-medium text-green-600">
              Sincronización completada
            </span>
          )}
          {status === "completed" && isCompression && (
            <span className="text-xs font-medium text-green-600">
              Compresión completada
            </span>
          )}
          {status === "completed" && isRevert && (
            <span className="text-xs font-medium text-green-600">
              Reversión completada
            </span>
          )}
          {status === "completed" && isBirdnet && (
            <span className="text-xs font-medium text-green-600">
              Análisis completado
            </span>
          )}
          {status === "completed" && isAcousticIndices && (
            <span className="text-xs font-medium text-green-600">
              Índices acústicos calculados
            </span>
          )}
          {status === "completed" && isAudioAnalysis && (
            <span className="text-xs font-medium text-green-600">
              Análisis acústico completado
            </span>
          )}
          {(status === "failed" || status === "cancelled") && isLinkable && (
            <Link
              href={`/camera-trap/process?jobId=${jobId}`}
              className="inline-flex h-7 items-center rounded px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
            >
              Ver detalles
            </Link>
          )}
          {(status === "failed" || status === "cancelled") && isDriveSync && (
            <span className="text-xs text-muted-foreground">
              {status === "failed" ? "Sincronización fallida" : "Sincronización cancelada"}
            </span>
          )}
          {(status === "failed" || status === "cancelled") && isCompression && (
            <span className="text-xs text-muted-foreground">
              {status === "failed" ? "Compresión fallida" : "Compresión cancelada"}
            </span>
          )}
          {(status === "failed" || status === "cancelled") && isRevert && (
            <span className="text-xs text-muted-foreground">
              {status === "failed" ? "Reversión fallida" : "Reversión cancelada"}
            </span>
          )}
          {(status === "failed" || status === "cancelled") && isAcousticIndices && (
            <span className="text-xs text-muted-foreground">
              {status === "failed" ? "Cálculo fallido" : "Cálculo cancelado"}
            </span>
          )}
          {(status === "failed" || status === "cancelled") && isAudioAnalysis && (
            <span className="text-xs text-muted-foreground">
              {status === "failed" ? "Análisis fallido" : "Análisis cancelado"}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
