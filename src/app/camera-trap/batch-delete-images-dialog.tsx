"use client";

import { useTransition, useState } from "react";
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
import { deleteImagesFromDrive } from "./actions";
import { useRouter } from "next/navigation";

interface BatchDeleteImagesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedIds: number[];
  selectedCount: number;
  onComplete: () => void;
}

export function BatchDeleteImagesDialog({
  open,
  onOpenChange,
  selectedIds,
  selectedCount,
  onComplete,
}: BatchDeleteImagesDialogProps) {
  const [deleting, startDeleting] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    deleted: number;
    failed: number;
  } | null>(null);
  const router = useRouter();

  const handleDelete = () => {
    startDeleting(async () => {
      setError(null);
      setResult(null);
      const res = await deleteImagesFromDrive(selectedIds);
      if (res.success) {
        setResult(res.data);
        onComplete();
        router.refresh();
        onOpenChange(false);
      } else {
        setError(res.error);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            Eliminar {selectedCount} imágenes de Drive
          </DialogTitle>
          <DialogDescription>
            Las imágenes se moverán a la papelera de Google Drive y se pueden
            recuperar durante 30 días. Los registros en la base de datos se
            eliminarán permanentemente.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md border p-3 text-sm space-y-1">
          <p>
            <span className="font-medium">{selectedCount}</span> imágenes sin
            detecciones serán eliminadas
          </p>
          <p className="text-muted-foreground text-xs">
            Solo se eliminarán imágenes que no tengan detecciones. Las imágenes
            con detecciones serán omitidas automáticamente.
          </p>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {result && (
          <div className="rounded-md border border-green-200 bg-green-50 p-3 text-sm space-y-1">
            <p className="font-medium text-green-700">
              {result.deleted} imágenes eliminadas
            </p>
            {result.failed > 0 && (
              <p className="text-amber-600">
                {result.failed} no se pudieron eliminar
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            variant="destructive"
            onClick={handleDelete}
            disabled={deleting}
          >
            {deleting && (
              <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
            )}
            Eliminar de Drive
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
