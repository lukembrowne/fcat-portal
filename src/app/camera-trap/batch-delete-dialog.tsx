"use client";

import { useState, useEffect, useTransition, useRef } from "react";
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

interface BatchDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedIds: number[];
  selectedCount: number;
  onComplete: () => void;
}

export function BatchDeleteDialog({
  open,
  onOpenChange,
  selectedIds,
  selectedCount,
  onComplete,
}: BatchDeleteDialogProps) {
  const [stats, setStats] = useState<{
    totalImages: number;
    totalDetections: number;
    totalVerified: number;
  } | null>(null);
  const [deleting, startDeleting] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const prevSelectedKeyRef = useRef<string | null>(null);

  // Reset state when dialog opens with new selection
  const selectedKey = open ? selectedIds.join(",") : null;
  if (selectedKey !== prevSelectedKeyRef.current) {
    prevSelectedKeyRef.current = selectedKey;
    if (selectedKey) {
      setStats(null);
      setError(null);
    }
  }

  useEffect(() => {
    if (open && selectedIds.length > 0) {
      getDeploymentsCascadeStats(selectedIds).then(setStats);
    }
  }, [open, selectedIds]);

  const handleDelete = () => {
    startDeleting(async () => {
      setError(null);
      const result = await deleteDeployments(selectedIds);
      if (result.success) {
        onOpenChange(false);
        onComplete();
      } else {
        setError(result.error);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            Eliminar {selectedCount} Instalaciones
          </DialogTitle>
          <DialogDescription>
            Esta acción no se puede deshacer. Se eliminarán todos los datos
            asociados.
          </DialogDescription>
        </DialogHeader>

        {stats && (
          <div className="rounded-md border p-3 text-sm space-y-1">
            <p>
              <span className="font-medium">{stats.totalImages}</span> imágenes
            </p>
            <p>
              <span className="font-medium">{stats.totalDetections}</span>{" "}
              detecciones
            </p>
            {stats.totalVerified > 0 && (
              <p className="text-destructive font-medium">
                {stats.totalVerified} identificaciones verificadas se perderán
              </p>
            )}
          </div>
        )}

        {!stats && open && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Calculando datos asociados...
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={deleting || !stats}
          >
            {deleting && (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            )}
            Eliminar {selectedCount} Instalaciones
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
