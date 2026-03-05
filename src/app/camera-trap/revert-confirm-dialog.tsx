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
import { getRevertPreview, revertCompression } from "./drive-actions";
import { useConfirmPreview } from "@/hooks/use-confirm-preview";

interface RevertConfirmDialogProps {
  deploymentId: number | null;
  onClose: () => void;
  onStarted: () => void;
}

export function RevertConfirmDialog({
  deploymentId,
  onClose,
  onStarted,
}: RevertConfirmDialogProps) {
  const preview = useConfirmPreview(deploymentId, getRevertPreview);
  const [starting, setStarting] = useState(false);

  const handleConfirm = async () => {
    if (!deploymentId) return;
    setStarting(true);
    const result = await revertCompression(deploymentId);
    setStarting(false);
    if (result.success) {
      onStarted();
      onClose();
    } else {
      alert(result.error);
    }
  };

  return (
    <Dialog open={!!deploymentId} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revertir compresión</DialogTitle>
          <DialogDescription>
            {preview ? (
              <>
                Se restaurarán <strong>{preview.count} imágenes</strong> a su tamaño original,
                aumentando el almacenamiento en ~{preview.savedMB} MB.
              </>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Cargando información...
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-amber-600">
          Google Drive elimina automáticamente las revisiones después de 30 días.
          Si la compresión se realizó hace más de 30 días, algunos originales podrían ya no estar disponibles.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={starting || !preview || preview.count === 0}
          >
            {starting ? "Iniciando..." : `Revertir ${preview?.count ?? 0} Imágenes`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
