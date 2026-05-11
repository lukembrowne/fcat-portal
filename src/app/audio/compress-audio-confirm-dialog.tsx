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
import { Loader2 } from "lucide-react";
import {
  compressDeploymentAudio,
  getAudioCompressionPreviewAction,
} from "./compression-actions";
import { useConfirmPreview } from "@/hooks/use-confirm-preview";

interface CompressAudioConfirmDialogProps {
  deploymentId: number | null;
  onClose: () => void;
  onStarted: () => void;
}

async function previewForOne(id: number) {
  return getAudioCompressionPreviewAction([id]);
}

export function CompressAudioConfirmDialog({
  deploymentId,
  onClose,
  onStarted,
}: CompressAudioConfirmDialogProps) {
  const preview = useConfirmPreview(deploymentId, previewForOne);
  const [starting, setStarting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleConfirm = async () => {
    if (!deploymentId) return;
    setStarting(true);
    setErrorMsg(null);
    const result = await compressDeploymentAudio(deploymentId);
    setStarting(false);
    if (result.success) {
      onStarted();
      onClose();
    } else {
      setErrorMsg(result.error);
    }
  };

  return (
    <Dialog
      open={!!deploymentId}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Comprimir audio a FLAC</DialogTitle>
          <DialogDescription>
            {preview ? (
              <>
                Se comprimirán <strong>{preview.count} archivos WAV</strong> (
                {preview.totalSizeMB} MB en total) a formato FLAC sin pérdida.
              </>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Cargando información...
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 text-sm text-muted-foreground">
          <p>
            El audio decodificado es <strong>idéntico al original</strong> — las
            detecciones BirdNET y los índices acústicos no cambiarán.
          </p>
          {preview && preview.count > 0 && (
            <p>
              Ahorro estimado:{" "}
              <strong>~{preview.estimatedSavedMB} MB</strong> (la compresión
              real depende del contenido sonoro; típicamente entre 40 y 60 %).
            </p>
          )}
          <p>
            Los archivos originales se reemplazan en Google Drive y se
            preservan como versión anterior. Si necesitas revertir, usa
            &quot;Revertir compresión&quot; en esta misma instalación.
          </p>
        </div>

        {errorMsg && (
          <p className="text-sm text-destructive">{errorMsg}</p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={starting}>
            Cancelar
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={starting || !preview || preview.count === 0}
          >
            {starting
              ? "Iniciando..."
              : `Comprimir ${preview?.count ?? 0} archivos`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
