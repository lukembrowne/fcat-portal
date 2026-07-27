"use client";

import { useState, useCallback, useTransition } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, AlertTriangle } from "lucide-react";
import { deleteDeployments, getDeploymentsCascadeStats } from "./actions";
import { useConfirmPreview } from "@/hooks/use-confirm-preview";

interface DeleteConfirmDialogProps {
  deploymentId: number | null;
  deploymentName: string;
  onClose: () => void;
  onDeleted: () => void;
}

export function DeleteConfirmDialog({
  deploymentId,
  deploymentName,
  onClose,
  onDeleted,
}: DeleteConfirmDialogProps) {
  const fetchStats = useCallback(
    (id: number) => getDeploymentsCascadeStats([id]),
    []
  );
  const stats = useConfirmPreview(deploymentId, fetchStats, { raw: true });
  const [deleting, startDeleting] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleDelete = () => {
    if (!deploymentId) return;
    startDeleting(async () => {
      setError(null);
      const result = await deleteDeployments([deploymentId]);
      if (result.success) {
        onDeleted();
        onClose();
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <Dialog open={!!deploymentId} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            Eliminar Instalación
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-1.5">
              <p>
                Se eliminará <strong>{deploymentName}</strong> y todos sus
                registros del portal (detecciones, identificaciones, etc.).
                Esta acción no se puede deshacer.
              </p>
              <p className="text-muted-foreground">
                Los archivos originales en Google Drive no serán afectados.
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>

        {stats ? (
          <div className="rounded-md border p-3 text-sm space-y-1">
            <p>
              <span className="font-medium">{stats.totalImages}</span> registros de imágenes
            </p>
            <p>
              <span className="font-medium">{stats.totalDetections}</span> detecciones
            </p>
            {stats.totalVerified > 0 && (
              <p className="text-destructive font-medium">
                {stats.totalVerified} identificaciones verificadas se perderán
              </p>
            )}
            {stats.hasUploadCounts && (
              <p className="text-amber-600 dark:text-amber-500 font-medium">
                Los conteos de archivos subidos (BioChocó) también se perderán
              </p>
            )}
          </div>
        ) : deploymentId ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Calculando datos asociados...
          </div>
        ) : null}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={deleting || !stats}
          >
            {deleting && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
            Eliminar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
