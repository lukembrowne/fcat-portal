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
import { queueIncrementalProcessing } from "./actions";

interface ProcessIncrementalDialogProps {
  deploymentId: number | null;
  pendingImageCount: number;
  deploymentStatus: string;
  onClose: () => void;
  onStarted: () => void;
}

export function ProcessIncrementalDialog({
  deploymentId,
  pendingImageCount,
  deploymentStatus,
  onClose,
  onStarted,
}: ProcessIncrementalDialogProps) {
  const [starting, setStarting] = useState(false);

  const handleConfirm = async () => {
    if (!deploymentId) return;
    setStarting(true);
    const result = await queueIncrementalProcessing(deploymentId);
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

  return (
    <Dialog
      open={!!deploymentId}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Procesar imágenes nuevas</DialogTitle>
          <DialogDescription>
            Se analizarán <strong>{pendingImageCount} imágenes nuevas</strong> con ML.
            Las detecciones, identificaciones y verificaciones existentes se
            preservarán.
          </DialogDescription>
        </DialogHeader>
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
              `Procesar ${pendingImageCount} ${pendingImageCount === 1 ? "nueva" : "nuevas"}`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
