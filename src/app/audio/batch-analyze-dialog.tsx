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
import { Loader2, AudioWaveform } from "lucide-react";
import { batchCreateBirdNETJobs } from "./actions";

interface BatchAnalyzeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedIds: number[];
  selectedCount: number;
  onComplete: () => void;
}

/**
 * Confirm dialog for "Analizar con BirdNET" on the audio batch toolbar.
 * Enqueues one BirdNET job per selected deployment. The action skips
 * deployments that already have an active BirdNET job or zero audio
 * files; the result message summarises both buckets.
 */
export function BatchAnalyzeDialog({
  open,
  onOpenChange,
  selectedIds,
  selectedCount,
  onComplete,
}: BatchAnalyzeDialogProps) {
  const [running, startRunning] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const handleStart = () => {
    startRunning(async () => {
      setError(null);
      const result = await batchCreateBirdNETJobs(selectedIds);
      if (!result.success) {
        setError(result.error);
        return;
      }
      const { enqueued, skipped, noFiles, errorMessages } = result.data;
      const parts: string[] = [`${enqueued} análisis encolado(s)`];
      if (skipped > 0) parts.push(`${skipped} ya en curso`);
      if (noFiles > 0) parts.push(`${noFiles} sin archivos`);
      if (errorMessages.length > 0) parts.push(`${errorMessages.length} error(es)`);
      // Surface via the floating job widget — it'll pick up the new jobs
      // within the polling cadence.
      window.dispatchEvent(new Event("job-started"));
      onOpenChange(false);
      onComplete();
      // Caller is responsible for surfacing the summary if needed; we
      // alert here so the user sees the breakdown even if they navigate.
      alert(parts.join(". ") + ".");
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AudioWaveform className="h-5 w-5" />
            Analizar {selectedCount} instalaciones con BirdNET
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-1.5 text-sm text-muted-foreground">
              <p>
                Se encolará un análisis BirdNET por cada instalación
                seleccionada. Los análisis ya en curso para una instalación
                no se duplicarán.
              </p>
              <p>
                El progreso aparece en el indicador inferior derecho. Las
                detecciones anteriores generadas por BirdNET se reemplazarán;
                las verificaciones manuales se mantienen.
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={handleStart} disabled={running}>
            {running && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
            Iniciar análisis
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
