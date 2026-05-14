"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";
import { batchCompressDeploymentAudio } from "./compression-actions";
import { getAudioCompressionPreviewAction } from "./preview-actions";

interface BatchCompressAudioDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedIds: number[];
  selectedCount: number;
  onComplete: () => void;
}

export function BatchCompressAudioDialog({
  open,
  onOpenChange,
  selectedIds,
  selectedCount,
  onComplete,
}: BatchCompressAudioDialogProps) {
  const [preview, setPreview] = useState<{
    count: number;
    totalSizeMB: number;
    estimatedSavedMB: number;
  } | null>(null);
  const [starting, setStarting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [summary, setSummary] = useState<
    | { enqueued: number; refused: { id: number; reason: string }[] }
    | null
  >(null);

  useEffect(() => {
    if (!open || selectedIds.length === 0) {
      setPreview(null);
      setSummary(null);
      setErrorMsg(null);
      return;
    }
    let cancelled = false;
    getAudioCompressionPreviewAction(selectedIds).then((res) => {
      if (cancelled) return;
      if (res.success) setPreview(res.data);
    });
    return () => {
      cancelled = true;
    };
  }, [open, selectedIds]);

  const handleConfirm = async () => {
    setStarting(true);
    setErrorMsg(null);
    const result = await batchCompressDeploymentAudio(selectedIds);
    setStarting(false);
    if (result.success) {
      setSummary(result.data);
      onComplete();
      if (result.data.refused.length === 0) {
        // All accepted — close after a brief beat so the user sees confirmation.
        setTimeout(() => onOpenChange(false), 800);
      }
    } else {
      setErrorMsg(result.error);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Comprimir audio a FLAC (lote)</DialogTitle>
          <DialogDescription>
            {summary ? (
              <>
                Se encolaron <strong>{summary.enqueued}</strong> trabajos. Solo
                un trabajo de compresión se ejecuta a la vez — los demás
                esperan turno.
              </>
            ) : preview ? (
              <>
                Se procesarán <strong>{selectedCount} instalación(es)</strong>{" "}
                con un total de <strong>{preview.count} archivos WAV</strong> (
                {preview.totalSizeMB} MB).
              </>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Cargando información...
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        {!summary && preview && preview.count > 0 && (
          <p className="text-sm text-muted-foreground">
            Ahorro estimado total:{" "}
            <strong>~{preview.estimatedSavedMB} MB</strong>. Solo un trabajo de
            compresión corre a la vez; los demás se ejecutarán en serie. Puedes
            revertir cualquier instalación desde su menú de acciones.
          </p>
        )}

        {summary && summary.refused.length > 0 && (
          <div className="rounded-md border p-3 text-sm">
            <p className="font-medium mb-1">
              {summary.refused.length} rechazados:
            </p>
            <ul className="text-xs text-muted-foreground space-y-0.5 max-h-32 overflow-auto">
              {summary.refused.map((r) => (
                <li key={r.id}>
                  #{r.id}: {r.reason}
                </li>
              ))}
            </ul>
          </div>
        )}

        {errorMsg && <p className="text-sm text-destructive">{errorMsg}</p>}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={starting}
          >
            {summary ? "Cerrar" : "Cancelar"}
          </Button>
          {!summary && (
            <Button
              onClick={handleConfirm}
              disabled={starting || !preview || preview.count === 0}
            >
              {starting
                ? "Iniciando..."
                : `Comprimir ${selectedCount} instalación(es)`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
