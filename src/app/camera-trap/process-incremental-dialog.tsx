"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Info, CheckCircle2, XCircle, Clock } from "lucide-react";
import { queueIncrementalProcessing } from "./actions";
import { probeVideoTimestamp } from "./video-timestamp-actions";
import type { VideoTimestampProbe, VideoTimestampMethod } from "./video-timestamp-actions";
import { ActiveModelsInfo } from "./active-models-info";

interface ProcessIncrementalDialogProps {
  deploymentId: number | null;
  pendingImageCount: number;
  pendingVideoCount?: number;
  hasVideos?: boolean;
  deploymentStatus: string;
  onClose: () => void;
  onStarted: () => void;
}

export function ProcessIncrementalDialog({
  deploymentId,
  pendingImageCount,
  pendingVideoCount = 0,
  hasVideos = false,
  deploymentStatus,
  onClose,
  onStarted,
}: ProcessIncrementalDialogProps) {
  const [starting, setStarting] = useState(false);
  const [frameRate, setFrameRate] = useState<number>(1.0);

  // Video timestamp probe state
  const [timestampMethod, setTimestampMethod] = useState<VideoTimestampMethod>("metadata");
  const [probe, setProbe] = useState<VideoTimestampProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);

  const showVideoOptions = hasVideos && pendingVideoCount > 0;

  // Auto-probe video timestamp when dialog opens with pending videos
  useEffect(() => {
    if (!deploymentId || !showVideoOptions) {
      setProbe(null);
      setProbeError(null);
      return;
    }
    let cancelled = false;
    setProbing(true);
    setProbe(null);
    setProbeError(null);
    probeVideoTimestamp(deploymentId).then((result) => {
      if (cancelled) return;
      setProbing(false);
      if (result.success) {
        setProbe(result.data);
        if (result.data.creationTime) {
          setTimestampMethod("metadata");
        } else if (result.data.filenameTimestamp) {
          setTimestampMethod("filename_folder");
        } else {
          setTimestampMethod("none");
        }
      } else {
        setProbeError(result.error);
      }
    });
    return () => { cancelled = true; };
  }, [deploymentId, showVideoOptions]);

  const handleConfirm = async () => {
    if (!deploymentId) return;
    setStarting(true);
    const result = await queueIncrementalProcessing(deploymentId, {
      frameExtractionRate: pendingVideoCount > 0 ? frameRate : undefined,
      videoTimestampMethod: showVideoOptions ? timestampMethod : undefined,
    });
    setStarting(false);
    if (result.success) {
      onStarted();
      onClose();
    } else {
      alert(result.error);
    }
  };

  const wasVerified =
    deploymentStatus === "verified" || deploymentStatus === "verified_empty";

  const summaryParts: string[] = [];
  if (pendingImageCount > 0) {
    summaryParts.push(
      `${pendingImageCount} ${pendingImageCount === 1 ? "imagen nueva" : "imágenes nuevas"}`,
    );
  }
  if (pendingVideoCount > 0) {
    summaryParts.push(
      `${pendingVideoCount} ${pendingVideoCount === 1 ? "video nuevo" : "videos nuevos"}`,
    );
  }
  const summary = summaryParts.join(" y ");
  const totalNew = pendingImageCount + pendingVideoCount;

  return (
    <Dialog
      open={!!deploymentId}
      onOpenChange={(open) => {
        if (!open) {
          setFrameRate(1.0);
          setProbe(null);
          setProbeError(null);
          setTimestampMethod("metadata");
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Procesar archivos nuevos</DialogTitle>
          <DialogDescription>
            Se analizarán <strong>{summary}</strong> con ML.
            Las detecciones, identificaciones y verificaciones existentes se
            preservarán.
          </DialogDescription>
        </DialogHeader>
        <div className="pt-1">
          <ActiveModelsInfo />
        </div>
        {showVideoOptions && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <label htmlFor="frame-rate-inc" className="text-sm font-medium leading-none">
                Cuadros por segundo (videos)
              </label>
              <select
                id="frame-rate-inc"
                value={frameRate}
                onChange={(e) => setFrameRate(Number(e.target.value))}
                className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              >
                <option value={0.5}>0.5 fps — 1 cuadro cada 2 segundos (más rápido)</option>
                <option value={1}>1 fps — 1 cuadro por segundo (recomendado)</option>
                <option value={2}>2 fps — 2 cuadros por segundo (más detalle)</option>
                <option value={4}>4 fps — 4 cuadros por segundo (máximo detalle)</option>
              </select>
              <p className="text-xs text-muted-foreground flex items-start gap-1.5">
                <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                Tasas más altas detectan animales rápidos pero aumentan el tiempo de procesamiento.
              </p>
            </div>

            <VideoTimestampSection
              probing={probing}
              probe={probe}
              probeError={probeError}
              method={timestampMethod}
              onMethodChange={setTimestampMethod}
            />
          </div>
        )}
        {wasVerified && (
          <p className="text-sm text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-md px-3 py-2">
            Esta instalación está marcada como verificada. Su estado pasará a
            <strong> &quot;Por Revisar&quot;</strong> porque contendrá imágenes sin revisar.
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={starting}>
            Cancelar
          </Button>
          <Button onClick={handleConfirm} disabled={starting || probing}>
            {starting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                Iniciando...
              </>
            ) : (
              `Procesar ${totalNew} ${totalNew === 1 ? "nuevo" : "nuevos"}`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VideoTimestampSection({
  probing,
  probe,
  probeError,
  method,
  onMethodChange,
}: {
  probing: boolean;
  probe: VideoTimestampProbe | null;
  probeError: string | null;
  method: VideoTimestampMethod;
  onMethodChange: (m: VideoTimestampMethod) => void;
}) {
  return (
    <div className="space-y-2 rounded-md border p-3">
      <label className="text-sm font-medium leading-none">
        Marca de tiempo de videos
      </label>

      {probing && (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Loader2 className="h-3 w-3 animate-spin" />
          Probando metadatos de un video de muestra...
        </p>
      )}

      {probeError && (
        <p className="text-xs text-destructive flex items-center gap-1.5">
          <XCircle className="h-3 w-3 shrink-0" />
          {probeError}
        </p>
      )}

      {probe && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Archivo de prueba: <span className="font-mono">{probe.sampleFilename}</span>
          </p>

          {/* Option: Metadata */}
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              name="ts-method-inc"
              value="metadata"
              checked={method === "metadata"}
              onChange={() => onMethodChange("metadata")}
              disabled={!probe.creationTime}
              className="mt-0.5"
            />
            <div className="text-sm">
              <span className={!probe.creationTime ? "text-muted-foreground" : ""}>
                Metadatos del video
              </span>
              {probe.creationTime ? (
                <span className="flex items-center gap-1 text-xs text-emerald-600 mt-0.5">
                  <CheckCircle2 className="h-3 w-3" />
                  {formatTimestamp(probe.creationTime)}
                </span>
              ) : (
                <span className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
                  <XCircle className="h-3 w-3" />
                  Sin metadatos de fecha en el archivo
                </span>
              )}
            </div>
          </label>

          {/* Option: Filename + folder */}
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              name="ts-method-inc"
              value="filename_folder"
              checked={method === "filename_folder"}
              onChange={() => onMethodChange("filename_folder")}
              disabled={!probe.filenameTimestamp}
              className="mt-0.5"
            />
            <div className="text-sm">
              <span className={!probe.filenameTimestamp ? "text-muted-foreground" : ""}>
                Nombre de archivo + carpeta
              </span>
              {probe.filenameTime && probe.folderDate ? (
                <span className="flex items-center gap-1 text-xs text-emerald-600 mt-0.5">
                  <CheckCircle2 className="h-3 w-3" />
                  {probe.folderDate} {probe.filenameTime}
                  <span className="text-muted-foreground">
                    (carpeta: {probe.folderName})
                  </span>
                </span>
              ) : probe.filenameTime ? (
                <span className="flex items-center gap-1 text-xs text-amber-600 mt-0.5">
                  <Clock className="h-3 w-3" />
                  Hora: {probe.filenameTime} — carpeta no tiene fecha
                  {probe.folderName && (
                    <span className="text-muted-foreground">({probe.folderName})</span>
                  )}
                </span>
              ) : (
                <span className="flex items-center gap-1 text-xs text-muted-foreground mt-0.5">
                  <XCircle className="h-3 w-3" />
                  Nombre no contiene hora (HHMMSS)
                </span>
              )}
            </div>
          </label>

          {/* Option: None */}
          <label className="flex items-start gap-2 cursor-pointer">
            <input
              type="radio"
              name="ts-method-inc"
              value="none"
              checked={method === "none"}
              onChange={() => onMethodChange("none")}
              className="mt-0.5"
            />
            <span className="text-sm">Sin marca de tiempo</span>
          </label>
        </div>
      )}
    </div>
  );
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("es-EC", {
      day: "numeric",
      month: "short",
      year: "numeric",
    }) + ", " + d.toLocaleTimeString("es-EC", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}
