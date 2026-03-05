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
import { getCompressionPreviewBatch } from "./drive-actions";

interface ProcessConfirmDialogProps {
  deploymentIds: number[] | null;
  isAdmin: boolean;
  onClose: () => void;
  onStarted: () => void;
}

export function ProcessConfirmDialog({
  deploymentIds,
  isAdmin,
  onClose,
  onStarted,
}: ProcessConfirmDialogProps) {
  const [compressFirst, setCompressFirst] = useState(isAdmin);
  const [starting, setStarting] = useState(false);
  const [preview, setPreview] = useState<{ count: number; totalSizeMB: number } | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);

  const count = deploymentIds?.length ?? 0;
  const isBatch = count > 1;

  // Fetch compression preview stats when checkbox is checked
  useEffect(() => {
    if (!deploymentIds || !isAdmin || !compressFirst) {
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
  }, [deploymentIds, isAdmin, compressFirst]);

  const handleConfirm = async () => {
    if (!deploymentIds || deploymentIds.length === 0) return;
    setStarting(true);
    const result = await queueProcessing(deploymentIds, {
      compressFirst: isAdmin && compressFirst,
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
            Se iniciará el análisis ML de las imágenes{isBatch ? ` de ${count} instalaciones` : ""}.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
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

          {isAdmin && compressFirst && (
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
              ) : preview && preview.count > 0 ? (
                <p className="text-xs font-medium">
                  {preview.count} imágenes JPEG ({preview.totalSizeMB} MB total) se comprimirán y reemplazarán en Drive
                </p>
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
