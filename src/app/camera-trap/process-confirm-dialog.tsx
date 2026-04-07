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
import { Loader2, Info } from "lucide-react";
import { queueProcessing } from "./actions";
import { getCompressionPreviewBatch } from "./preview-actions";

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

  const handleConfirm = async () => {
    if (!deploymentIds || deploymentIds.length === 0) return;
    setStarting(true);
    const result = await queueProcessing(deploymentIds, {
      compressFirst: isAdmin && hasImages && compressFirst,
      frameExtractionRate: hasVideos ? frameRate : undefined,
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
          <Button onClick={handleConfirm} disabled={starting}>
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

function describeTargets(hasImages: boolean, hasVideos: boolean): string {
  if (hasImages && hasVideos) return "de las imágenes y videos";
  if (hasVideos) return "de los videos";
  return "de las imágenes";
}
