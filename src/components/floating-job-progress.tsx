"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import Link from "next/link";
import { X, Minus, ChevronUp, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { cancelJob, cancelQueue } from "@/app/camera-trap/actions";

interface ActiveJob {
  jobId: number;
  deploymentId: number;
  deploymentName: string;
  status: string;
  totalImages: number;
  processedImages: number;
  statusMessage: string | null;
}

interface SSEData {
  jobId: number;
  status: string;
  processed: number;
  total: number;
  failed: number;
  statusMessage?: string;
}

const POLL_INTERVAL = 3000;

export function FloatingJobProgress() {
  const [allJobs, setAllJobs] = useState<ActiveJob[]>([]);
  const [sseData, setSseData] = useState<SSEData | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [showQueue, setShowQueue] = useState(false);

  const eventSourceRef = useRef<EventSource | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastJobIdRef = useRef<number | null>(null);

  // Derived state
  const processingJob = allJobs.find((j) => j.status === "processing") ?? null;
  const pendingJobs = allJobs.filter((j) => j.status === "pending");
  const totalQueueSize = allJobs.length;
  const currentQueuePosition =
    processingJob && totalQueueSize > 1
      ? totalQueueSize - pendingJobs.length
      : 0;
  const hasQueue = totalQueueSize > 1;
  const activeJob = processingJob ?? allJobs[0] ?? null;

  // Poll /api/active-jobs for active jobs
  const pollActiveJobs = useCallback(async () => {
    try {
      const res = await fetch("/api/active-jobs");
      if (!res.ok) return;
      const jobs: ActiveJob[] = await res.json();

      setAllJobs(jobs);

      if (jobs.length > 0) {
        // Find the currently processing job (or highest ID)
        const current =
          jobs.find((j) => j.status === "processing") ??
          jobs.reduce((a, b) => (a.jobId > b.jobId ? a : b));

        // New job discovered — reset dismissed state
        if (current.jobId !== lastJobIdRef.current) {
          lastJobIdRef.current = current.jobId;
          setDismissed(false);
          setMinimized(false);
          setSseData(null);
          setCancelling(false);
        }
      }
    } catch {
      // Silently ignore polling errors
    }
  }, []);

  // Polling loop
  useEffect(() => {
    const poll = () => {
      pollActiveJobs();
      pollTimerRef.current = setTimeout(poll, POLL_INTERVAL);
    };
    poll();

    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [pollActiveJobs]);

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
        setSseData(data);

        if (["completed", "failed", "cancelled"].includes(data.status)) {
          es.close();
          eventSourceRef.current = null;
        }
      } catch {
        // Ignore parse errors
      }
    };

    es.onerror = () => {
      es.close();
      eventSourceRef.current = null;
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [processingJob?.jobId]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Nothing to show
  const hasJob = activeJob || (sseData && !dismissed);
  if (!hasJob || dismissed) return null;

  const jobId = sseData?.jobId || activeJob?.jobId;
  const deploymentName = activeJob?.deploymentName || "Instalación";
  const isTerminal =
    status === "completed" || status === "failed" || status === "cancelled";
  const isAnalyzing = status === "processing" && (sseData?.processed ?? 0) > 0;
  const processed = sseData?.processed ?? activeJob?.processedImages ?? 0;
  const total = sseData?.total ?? activeJob?.totalImages ?? 0;
  const percentage = total > 0 ? Math.round((processed / total) * 100) : 0;

  const statusMessage = isTerminal
    ? status === "completed"
      ? "Completado"
      : status === "cancelled"
        ? "Cancelado"
        : "Fallido"
    : sseData?.statusMessage || activeJob?.statusMessage || "Esperando inicio...";

  const statusColor = isTerminal
    ? status === "completed"
      ? "text-green-600"
      : status === "cancelled"
        ? "text-orange-600"
        : "text-red-600"
    : "text-blue-600";

  const barColor = isTerminal
    ? status === "completed"
      ? "bg-green-500"
      : status === "cancelled"
        ? "bg-orange-500"
        : "bg-red-500"
    : "bg-primary";

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
      const result = await cancelJob(jobId);
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
            !isTerminal && "border-blue-300"
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
                : "bg-blue-500 animate-pulse"
            )}
          />
          <span>
            {hasQueue
              ? `Procesando ${currentQueuePosition} de ${totalQueueSize}`
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
          <p className="text-sm font-medium truncate">{deploymentName}</p>
          <p className="text-xs text-muted-foreground">
            {hasQueue
              ? `Procesando ${currentQueuePosition} de ${totalQueueSize}`
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
      <div className="px-3 py-3 space-y-3">
        {/* Status message */}
        <p className={cn("text-sm font-medium", statusColor)}>
          {statusMessage}
        </p>

        {/* Progress bar */}
        <div className="space-y-1">
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            {status === "processing" && !isAnalyzing ? (
              <div className="h-full w-full bg-primary/30 rounded-full relative overflow-hidden">
                <div className="absolute inset-0 bg-primary/60 rounded-full animate-pulse" />
              </div>
            ) : (
              <div
                className={cn(
                  "h-full transition-all duration-300 rounded-full",
                  barColor
                )}
                style={{ width: `${percentage}%` }}
              />
            )}
          </div>
          {(isAnalyzing || isTerminal) && (
            <p className="text-xs text-muted-foreground">
              {processed} de {total} imágenes · {percentage}%
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
                    {job.deploymentName}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex items-center gap-2">
          {!isTerminal && (
            <>
              <Link
                href={`/camera-trap/process?jobId=${jobId}`}
                className="text-xs text-primary hover:underline"
              >
                Ver detalles
              </Link>
              <span className="text-muted-foreground">·</span>
              <button
                onClick={handleCancel}
                disabled={cancelling}
                className="text-xs text-red-600 hover:underline disabled:opacity-50"
              >
                {cancelling
                  ? "Cancelando..."
                  : hasQueue
                    ? "Cancelar Cola"
                    : "Cancelar"}
              </button>
            </>
          )}
          {status === "completed" && (
            <Link
              href={`/camera-trap/results/${jobId}`}
              className="text-xs font-medium text-green-600 hover:underline"
            >
              Ver resultados
            </Link>
          )}
          {(status === "failed" || status === "cancelled") && (
            <Link
              href={`/camera-trap/process?jobId=${jobId}`}
              className="text-xs text-muted-foreground hover:underline"
            >
              Ver detalles
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
