"use client";

import { useState, useTransition } from "react";
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
import { clearAudioIndex } from "./actions";

interface BatchClearAudioIndexDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedIds: number[];
  selectedCount: number;
  onComplete: () => void;
}

/**
 * Admin-only confirm dialog for clearing the audio file index on a batch
 * of deployments. Does NOT touch Drive — just drops `audio_files` rows so
 * the next sync reindexes from scratch. Annotated rows are soft-deleted
 * (drive_file_id nulled, row preserved) to keep detection foreign keys
 * valid. Use case: schema drift / rename storm in Drive.
 */
export function BatchClearAudioIndexDialog({
  open,
  onOpenChange,
  selectedIds,
  selectedCount,
  onComplete,
}: BatchClearAudioIndexDialogProps) {
  const [running, startRunning] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleClear = () => {
    startRunning(async () => {
      setError(null);
      const result = await clearAudioIndex(selectedIds);
      if (!result.success) {
        setError(result.error);
        return;
      }
      const { hardDeleted, softDeleted } = result.data;
      onOpenChange(false);
      onComplete();
      alert(
        `Índice limpiado: ${hardDeleted} fila(s) eliminada(s), ` +
          `${softDeleted} preservada(s) por tener anotaciones. ` +
          `Usa "Sincronizar audio" para volver a indexar.`
      );
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            Limpiar índice de {selectedCount} instalaciones
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-1.5 text-sm text-muted-foreground">
              <p>
                Elimina las filas de <code>audio_files</code> para las
                instalaciones seleccionadas. <strong>No</strong> borra archivos
                de Google Drive.
              </p>
              <p>
                Las filas con detecciones manuales o de BirdNET se conservan
                (se desvinculan del archivo de Drive). El próximo
                &quot;Sincronizar audio&quot; volverá a indexar desde Drive.
              </p>
              <p className="text-destructive">
                Útil cuando el índice local quedó desfasado de Drive
                (renombrados masivos, migraciones). No es reversible sin
                re-sincronizar.
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            variant="destructive"
            onClick={handleClear}
            disabled={running}
          >
            {running && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
            Limpiar índice
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
