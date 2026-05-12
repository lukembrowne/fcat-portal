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
  revertDeploymentAudioCompression,
  getAudioRevertPreviewAction,
} from "./compression-actions";
import { useConfirmPreview } from "@/hooks/use-confirm-preview";

interface RevertAudioCompressionConfirmDialogProps {
  deploymentId: number | null;
  onClose: () => void;
  onStarted: () => void;
}

export function RevertAudioCompressionConfirmDialog({
  deploymentId,
  onClose,
  onStarted,
}: RevertAudioCompressionConfirmDialogProps) {
  const preview = useConfirmPreview(deploymentId, getAudioRevertPreviewAction);
  const [starting, setStarting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const handleConfirm = async () => {
    if (!deploymentId) return;
    setStarting(true);
    setErrorMsg(null);
    const result = await revertDeploymentAudioCompression(deploymentId);
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
          <DialogTitle>Revertir compresión a WAV</DialogTitle>
          <DialogDescription>
            {preview ? (
              <>
                Se restaurarán <strong>{preview.count} archivos FLAC</strong> a
                la versión WAV anterior almacenada en Drive.
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
          {preview && preview.count > 0 && (
            <p>
              Se recuperarán aproximadamente{" "}
              <strong>{preview.reclaimableMB} MB</strong> de espacio en disco
              local; en Drive el archivo crecerá al tamaño original.
            </p>
          )}
          <p>
            Solo se revierten archivos con una versión WAV anclada
            (originalDriveRevisionId presente). Archivos que se omitieron por
            ser no-compresibles o que se autocuraron sin revisión anterior no
            son revertibles aquí.
          </p>
        </div>

        {errorMsg && <p className="text-sm text-destructive">{errorMsg}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={starting}>
            Cancelar
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={starting || !preview || preview.count === 0}
          >
            {starting
              ? "Iniciando..."
              : `Revertir ${preview?.count ?? 0} archivos`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
