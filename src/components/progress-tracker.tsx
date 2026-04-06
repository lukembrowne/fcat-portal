"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/format-duration";

interface ProgressData {
  jobId: number;
  status: string;
  processed: number;
  total: number;
  failed: number;
  error?: string;
  errorMessage?: string | null;
  statusMessage?: string;
  startedAt?: string | null;
  downloadedImages?: number;
  downloadTotal?: number;
  cachedImages?: number;
}

interface ProgressTrackerProps {
  jobId: number;
  onComplete?: () => void;
  onCancel?: () => void;
}

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

export function ProgressTracker({
  jobId,
  onComplete,
  onCancel,
}: ProgressTrackerProps) {
  const [progress, setProgress] = useState<ProgressData | null>(null);
  const [connectionState, setConnectionState] = useState<
    "connecting" | "connected" | "reconnecting" | "failed" | "closed"
  >("connecting");
  const [retryCount, setRetryCount] = useState(0);

  const eventSourceRef = useRef<EventSource | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const connect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const es = new EventSource(`/api/progress?jobId=${jobId}`);
    eventSourceRef.current = es;

    es.onopen = () => {
      setConnectionState("connected");
      setRetryCount(0);
    };

    es.onmessage = (event) => {
      try {
        const data: ProgressData = JSON.parse(event.data);
        setProgress(data);

        if (["completed", "failed", "cancelled"].includes(data.status)) {
          es.close();
          setConnectionState("closed");

          if (data.status === "completed" && onCompleteRef.current) {
            onCompleteRef.current();
          }
        }
      } catch (e) {
        console.error("Failed to parse progress data:", e);
      }
    };

    es.onerror = () => {
      es.close();
      eventSourceRef.current = null;

      setRetryCount((prev) => {
        const next = prev + 1;
        if (next <= MAX_RETRIES) {
          setConnectionState("reconnecting");
          retryTimerRef.current = setTimeout(() => {
            connect();
          }, RETRY_DELAY_MS);
        } else {
          setConnectionState("failed");
        }
        return next;
      });
    };
  }, [jobId]);

  useEffect(() => {
    connect();

    return () => {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
      }
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
      }
    };
  }, [connect]);

  const handleManualReconnect = () => {
    setRetryCount(0);
    setConnectionState("connecting");
    connect();
  };

  // Elapsed time timer
  const [elapsed, setElapsed] = useState<string | null>(null);
  const startedAtStr = progress?.startedAt ?? null;
  const progressStatus = progress?.status;
  useEffect(() => {
    if (!startedAtStr) {
      setElapsed(null);
      return;
    }
    const startMs = new Date(startedAtStr).getTime();
    const terminal = progressStatus === "completed" || progressStatus === "failed" || progressStatus === "cancelled";
    if (terminal) {
      setElapsed(formatDuration(Date.now() - startMs));
      return;
    }
    const update = () => setElapsed(formatDuration(Date.now() - startMs));
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [startedAtStr, progressStatus]);

  const dlTotal = progress?.downloadTotal ?? 0;
  const dlDone = progress?.downloadedImages ?? 0;
  const isDownloading = (progress?.status === "processing") && dlTotal > 0 && dlDone < dlTotal;

  const percentage = isDownloading
    ? dlTotal > 0 ? Math.round((dlDone / dlTotal) * 100) : 0
    : progress
      ? Math.round((progress.processed / Math.max(progress.total, 1)) * 100)
      : 0;

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
  } else if (progress?.status === "processing" && (progress?.processed ?? 0) > 0 && (progress?.processed ?? 0) < (progress?.total ?? 0) && startedAtStr) {
    const elapsedMs = Date.now() - new Date(startedAtStr).getTime();
    const rate = (progress?.processed ?? 0) / (elapsedMs / 1000);
    const remaining = (progress?.total ?? 0) - (progress?.processed ?? 0);
    const etaMs = rate > 0 ? (remaining / rate) * 1000 : 0;
    if (etaMs > 0) {
      etaStr = `~${formatDuration(etaMs)} restante`;
    }
  }

  // Use statusMessage from backend during active processing, static labels for terminal states
  const terminalLabels: Record<string, string> = {
    completed: "Completado",
    failed: "Fallido",
    cancelled: "Cancelado",
  };
  const status = progress?.status || "pending";
  const isTerminal = status in terminalLabels;
  const isAnalyzing = status === "processing" && progress?.processed !== undefined && progress.processed > 0;
  const hasProgress = isDownloading || isAnalyzing;
  const statusLabel = isTerminal
    ? terminalLabels[status]
    : progress?.statusMessage || (status === "pending" ? "Esperando inicio..." : "Procesando imágenes...");

  const statusColor = {
    pending: "text-muted-foreground",
    processing: "text-blue-600",
    completed: "text-green-600",
    failed: "text-red-600",
    cancelled: "text-orange-600",
  }[status];

  return (
    <Card>
      <CardContent className="pt-6 space-y-4">
        <div className="flex items-center justify-between">
          <span className={cn("font-medium", statusColor)}>
            {statusLabel}
          </span>
          <ConnectionIndicator
            state={connectionState}
            retryCount={retryCount}
            jobStatus={progress?.status}
          />
        </div>

        <div className="space-y-2">
          <div className="h-4 bg-muted rounded-full overflow-hidden">
            {status === "processing" && !hasProgress ? (
              <div className="h-full w-full bg-primary/30 rounded-full relative overflow-hidden">
                <div className="absolute inset-0 bg-primary/60 rounded-full animate-pulse" />
              </div>
            ) : (
              <div
                className={cn(
                  "h-full transition-all duration-300 rounded-full",
                  status === "completed"
                    ? "bg-green-500"
                    : status === "failed"
                      ? "bg-red-500"
                      : status === "cancelled"
                        ? "bg-orange-500"
                        : "bg-primary"
                )}
                style={{ width: `${percentage}%` }}
              />
            )}
          </div>
          {hasProgress || isTerminal ? (
            <div className="flex justify-between text-sm text-muted-foreground">
              <span>
                {isDownloading
                  ? <>{dlDone} de {dlTotal} archivos</>
                  : <>{progress?.processed || 0} de {progress?.total || 0} imágenes</>
                }
                {etaStr && <> · {etaStr}</>}
                {elapsed && <> · {elapsed}</>}
              </span>
              <span>{percentage}%</span>
            </div>
          ) : status === "processing" ? (
            <div className="text-sm text-muted-foreground">
              Preparando...{elapsed && <> · {elapsed}</>}
            </div>
          ) : (
            <div className="flex justify-between text-sm text-muted-foreground">
              <span>
                {progress?.processed || 0} de {progress?.total || 0} imágenes
              </span>
              <span>{percentage}%</span>
            </div>
          )}
        </div>

        {progress && progress.failed > 0 && (
          <p className="text-sm text-orange-600">
            {progress.failed} imágenes fallaron al procesar
          </p>
        )}

        {progress?.status === "failed" && progress?.errorMessage && (
          <details className="rounded-md border border-destructive/30 bg-destructive/5 text-sm" open>
            <summary className="cursor-pointer px-3 py-2 font-medium text-destructive">
              Detalles del error
            </summary>
            <pre className="px-3 pb-3 pt-1 text-xs text-destructive/90 whitespace-pre-wrap break-words font-mono max-h-64 overflow-y-auto">
              {progress.errorMessage}
            </pre>
          </details>
        )}

        {connectionState === "failed" && (
          <div className="flex items-center gap-3 rounded-md bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-900 p-3">
            <p className="text-sm text-red-700 dark:text-red-300 flex-1">
              Conexión perdida después de {MAX_RETRIES} intentos.
            </p>
            <Button variant="outline" size="sm" onClick={handleManualReconnect}>
              Reconectar
            </Button>
          </div>
        )}

        {progress?.status === "processing" && onCancel && (
          <Button variant="outline" onClick={onCancel} className="w-full">
            Cancelar procesamiento
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function ConnectionIndicator({
  state,
  retryCount,
  jobStatus,
}: {
  state: string;
  retryCount: number;
  jobStatus?: string;
}) {
  if (jobStatus && ["completed", "failed", "cancelled"].includes(jobStatus)) {
    return null;
  }

  if (state === "connected") {
    return (
      <span className="flex items-center gap-1 text-sm text-muted-foreground">
        <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
        En vivo
      </span>
    );
  }

  if (state === "reconnecting") {
    return (
      <span className="flex items-center gap-1 text-sm text-orange-600">
        <span className="w-2 h-2 bg-orange-500 rounded-full animate-pulse" />
        Reconectando ({retryCount}/{MAX_RETRIES})...
      </span>
    );
  }

  if (state === "failed") {
    return (
      <span className="flex items-center gap-1 text-sm text-red-600">
        <span className="w-2 h-2 bg-red-500 rounded-full" />
        Desconectado
      </span>
    );
  }

  return (
    <span className="flex items-center gap-1 text-sm text-muted-foreground">
      <span className="w-2 h-2 bg-gray-400 rounded-full animate-pulse" />
      Conectando...
    </span>
  );
}
