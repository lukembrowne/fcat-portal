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
import { Loader2 } from "lucide-react";
import { getCompressionPreview, compressDeploymentImages } from "./drive-actions";

interface CompressConfirmDialogProps {
  deploymentId: number | null;
  onClose: () => void;
  onStarted: () => void;
}

export function CompressConfirmDialog({
  deploymentId,
  onClose,
  onStarted,
}: CompressConfirmDialogProps) {
  const [preview, setPreview] = useState<{ count: number; totalSizeMB: number } | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    if (!deploymentId) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    getCompressionPreview(deploymentId).then((result) => {
      if (!cancelled && result.success) {
        setPreview(result.data);
      }
    });
    return () => { cancelled = true; };
  }, [deploymentId]);

  const handleConfirm = async () => {
    if (!deploymentId) return;
    setStarting(true);
    const result = await compressDeploymentImages(deploymentId);
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
          <DialogTitle>Comprimir imágenes</DialogTitle>
          <DialogDescription>
            {preview ? (
              <>
                Se comprimirán <strong>{preview.count} imágenes JPEG</strong> ({preview.totalSizeMB} MB total)
                re-codificándolas a calidad 85.
              </>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Cargando información...
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          Los originales se preservan como revisiones en Google Drive y pueden restaurarse con &quot;Deshacer Compresión&quot;.
          Las revisiones se eliminan automáticamente después de <strong>30 días</strong>.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={starting || !preview || preview.count === 0}
          >
            {starting ? "Iniciando..." : `Comprimir ${preview?.count ?? 0} Imágenes`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
