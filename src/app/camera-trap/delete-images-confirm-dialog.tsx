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
import { toast } from "sonner";
import { deleteAllDeploymentImages } from "./actions";

interface DeleteImagesConfirmDialogProps {
  deploymentId: number | null;
  deploymentName: string;
  totalImages: number;
  onClose: () => void;
  onDeleted: () => void;
}

export function DeleteImagesConfirmDialog({
  deploymentId,
  deploymentName,
  totalImages,
  onClose,
  onDeleted,
}: DeleteImagesConfirmDialogProps) {
  const [deleting, setDeleting] = useState(false);

  const handleConfirm = async () => {
    if (!deploymentId) return;
    setDeleting(true);
    const result = await deleteAllDeploymentImages(deploymentId);
    setDeleting(false);
    if (result.success) {
      const { deleted, skipped, failed } = result.data;
      const parts = [`${deleted} eliminada${deleted === 1 ? "" : "s"}`];
      if (skipped > 0) parts.push(`${skipped} omitida${skipped === 1 ? "" : "s"} (con detecciones)`);
      if (failed > 0) parts.push(`${failed} con error`);
      toast.success(`Imágenes: ${parts.join(", ")}`);
      onDeleted();
      onClose();
    } else {
      toast.error(result.error);
    }
  };

  return (
    <Dialog open={!!deploymentId} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Eliminar imágenes de Drive</DialogTitle>
          <DialogDescription>
            Se enviarán a la papelera de Google Drive las <strong>{totalImages} imágenes</strong> de{" "}
            <strong>{deploymentName}</strong> y se quitarán del portal. La instalación NO se elimina.
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-amber-600">
          Recuperable durante 30 días desde la papelera de Drive. Las imágenes que ya tienen
          detecciones se omiten — elimina primero el trabajo de procesamiento si necesitas borrarlas también.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="destructive"
            onClick={handleConfirm}
            disabled={deleting || totalImages === 0}
          >
            {deleting ? "Eliminando..." : `Eliminar ${totalImages} imágenes`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
