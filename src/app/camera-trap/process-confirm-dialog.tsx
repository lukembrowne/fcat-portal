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
import { Checkbox } from "@/components/ui/checkbox";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Loader2, Info, CheckCircle2, XCircle, Clock } from "lucide-react";
import { queueProcessing } from "./actions";
import { getCompressionPreviewBatch } from "./preview-actions";
import { probeVideoTimestamp } from "./video-timestamp-actions";
import type { VideoTimestampProbe, VideoTimestampMethod } from "./video-timestamp-actions";

interface ProcessConfirmDialogProps {
  deploymentIds: number[] | null;
  isAdmin: boolean;
  /** When true, show the compression checkbox (compression only applies to images). */
  hasImages?: boolean;
  /** When true, show the frame extraction rate control (only meaningful for video deployments). */
  hasVideos?: boolean;
  onClose: () => void;
  onStarted: () => void;
}

export function ProcessConfirmDialog({
  deploymentIds,
  isAdmin,
  hasImages = true,
  hasVideos = false,
  onClose,
  onStarted,
}: ProcessConfirmDialogProps) {
  const [compressFirst, setCompressFirst] = useState(isAdmin);
  const [frameRate, setFrameRate] = useState<number>(1.0);
  const [starting, setStarting] = useState(false);
  const [preview, setPreview] = useState<{ count: number; totalSizeMB: number } | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  // Video timestamp probe state
  const [timestampMethod, setTimestampMethod] = useState<VideoTimestampMethod>("metadata");
  const [probe, setProbe] = useState<VideoTimestampProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);

  const count = deploymentIds?.length ?? 0;
  const isBatch = count > 1;

  // Fetch compression preview stats when checkbox is checked
  useEffect(() => {
    if (!deploymentIds || !isAdmin || !compressFirst || !hasImages) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setLoadingPreview(true);
    getCompressionPreviewBatch(deploymentIds).then((result) => {
      if (cancelled) return;
      if (result.success) {
        setPreview(result.data);
      }
      setLoadingPreview(false);
    });
    return () => { cancelled = true; };
  }, [deploymentIds, isAdmin, compressFirst, hasImages]);

  // Auto-probe video timestamp when dialog opens with videos (single deployment only)
  useEffect(() => {
    if (!deploymentIds || !hasVideos || isBatch) {
      setProbe(null);
      setProbeError(null);
      return;
    }
    let cancelled = false;
    setProbing(true);
    setProbe(null);
    setProbeError(null);
    probeVideoTimestamp(deploymentIds[0]).then((result) => {
      if (cancelled) return;
      setProbing(false);
      if (result.success) {
        setProbe(result.data);
        // Auto-select the best method based on probe results
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
  }, [deploymentIds, hasVideos, isBatch]);

  const handleConfirm = async () => {
    if (!deploymentIds || deploymentIds.length === 0) return;
    setStarting(true);
    const result = await queueProcessing(deploymentIds, {
      compressFirst: isAdmin && hasImages && compressFirst,
      frameExtractionRate: hasVideos ? frameRate : undefined,
      videoTimestampMethod: hasVideos ? timestampMethod : undefined,
    });
    setStarting(false);
    if (result.success) {
      onStarted();
      onClose();
    } else {
      alert(result.error);
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      onClose();
      // Reset state for next open
      setCompressFirst(isAdmin);
      setFrameRate(1.0);
      setPreview(null);
      setProbe(null);
      setProbeError(null);
      setTimestampMethod("metadata");
    }
  };

  return (
    <Dialog open={!!deploymentIds} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isBatch
              ? `Procesar ${count} Instalaciones`
              : "Procesar Instalación"}
          </DialogTitle>
          <DialogDescription>
            Se iniciará el análisis ML {describeTargets(hasImages, hasVideos)}
            {isBatch ? ` de ${count} instalaciones` : ""}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {hasImages && (
            <div className="flex items-start gap-3">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="compress-first"
                        checked={isAdmin && compressFirst}
                        onCheckedChange={(checked) => setCompressFirst(!!checked)}
                        disabled={!isAdmin}
                      />
                      <label
                        htmlFor="compress-first"
                        className={`text-sm font-medium leading-none peer-disabled:cursor-not-allowed ${
                          !isAdmin ? "text-muted-foreground" : ""
                        }`}
                      >
                        Comprimir imágenes primero (recomendado)
                      </label>
                    </div>
                  </TooltipTrigger>
                  {!isAdmin && (
                    <TooltipContent>
                      <p>Solo administradores pueden comprimir</p>
                    </TooltipContent>
                  )}
                </Tooltip>
              </TooltipProvider>
            </div>
          )}

          {hasVideos && (
            <div className="space-y-1.5">
              <label htmlFor="frame-rate" className="text-sm font-medium leading-none">
                Cuadros por segundo (videos)
              </label>
              <select
                id="frame-rate"
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
                Tasas más altas detectan animales rápidos pero aumentan el tiempo de procesamiento. Solo aplica a videos.
              </p>
            </div>
          )}

          {hasVideos && !isBatch && (
            <VideoTimestampSection
              probing={probing}
              probe={probe}
              probeError={probeError}
              method={timestampMethod}
              onMethodChange={setTimestampMethod}
            />
          )}

          {hasImages && isAdmin && compressFirst && (
            <div className="ml-6 space-y-1">
              <p className="text-xs text-muted-foreground flex items-start gap-1.5">
                <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                Las imágenes se comprimen antes del análisis ML.
                Los originales se preservan como revisiones en Drive por 30 días.
              </p>
              {loadingPreview ? (
                <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Calculando...
                </p>
              ) : preview ? (
                preview.count > 0 ? (
                  <p className="text-xs font-medium">
                    {preview.count} imágenes JPEG ({preview.totalSizeMB} MB total) se comprimirán y reemplazarán en Drive
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No hay imágenes JPEG sin comprimir para esta selección.
                  </p>
                )
              ) : null}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button onClick={handleConfirm} disabled={starting || probing}>
            {starting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                Iniciando...
              </>
            ) : isBatch ? (
              `Procesar ${count} Instalaciones`
            ) : (
              "Procesar"
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
              name="ts-method"
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
              name="ts-method"
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
              name="ts-method"
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

function describeTargets(hasImages: boolean, hasVideos: boolean): string {
  if (hasImages && hasVideos) return "de las imágenes y videos";
  if (hasVideos) return "de los videos";
  return "de las imágenes";
}
