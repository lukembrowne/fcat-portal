"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Info } from "lucide-react";
import { queueIncrementalProcessing } from "./actions";

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

  const handleConfirm = async () => {
    if (!deploymentId) return;
    setStarting(true);
    const result = await queueIncrementalProcessing(deploymentId, {
      frameExtractionRate: pendingVideoCount > 0 ? frameRate : undefined,
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
        {(hasVideos && pendingVideoCount > 0) && (
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
          <Button onClick={handleConfirm} disabled={starting}>
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
