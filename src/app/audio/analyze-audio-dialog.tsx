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
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2, AudioWaveform } from "lucide-react";
import {
  createAudioAnalysisJob,
  batchCreateAudioAnalysisJobs,
} from "./actions";

type Mode = "single" | "batch";

interface AnalyzeAudioDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Single-deployment mode passes one id; batch passes many. */
  deploymentIds: number[];
  /** Friendly subject — used in the title/description. */
  subjectLabel?: string;
  hasExistingBirdnet?: boolean;
  onComplete?: () => void;
}

export function AnalyzeAudioDialog({
  open,
  onOpenChange,
  deploymentIds,
  subjectLabel,
  hasExistingBirdnet = false,
  onComplete,
}: AnalyzeAudioDialogProps) {
  const mode: Mode = deploymentIds.length > 1 ? "batch" : "single";
  const [includeBirdnet, setIncludeBirdnet] = useState(true);
  const [includeIndices, setIncludeIndices] = useState(true);
  const [running, startRunning] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const canSubmit = includeBirdnet || includeIndices;

  const title =
    mode === "batch"
      ? `Analizar ${deploymentIds.length} instalaciones`
      : subjectLabel
        ? `Analizar ${subjectLabel}`
        : "Analizar instalación";

  const handleStart = () => {
    if (!canSubmit) {
      setError("Selecciona al menos un análisis");
      return;
    }
    startRunning(async () => {
      setError(null);

      if (
        includeBirdnet &&
        hasExistingBirdnet &&
        !window.confirm(
          "Se reemplazarán las detecciones BirdNET previas. Las anotaciones manuales se conservarán. ¿Continuar?"
        )
      ) {
        return;
      }

      if (mode === "batch") {
        const result = await batchCreateAudioAnalysisJobs(deploymentIds, {
          includeBirdnet,
          includeIndices,
        });
        if (!result.success) {
          setError(result.error);
          return;
        }
        const { enqueued, skipped, noFiles, errorMessages } = result.data;
        const parts: string[] = [`${enqueued} análisis encolado(s)`];
        if (skipped > 0) parts.push(`${skipped} ya en curso`);
        if (noFiles > 0) parts.push(`${noFiles} sin archivos`);
        if (errorMessages.length > 0)
          parts.push(`${errorMessages.length} error(es)`);
        window.dispatchEvent(new Event("job-started"));
        onOpenChange(false);
        onComplete?.();
        alert(parts.join(". ") + ".");
        return;
      }

      const result = await createAudioAnalysisJob({
        deploymentId: deploymentIds[0],
        includeBirdnet,
        includeIndices,
      });
      if (!result.success) {
        setError(result.error);
        return;
      }
      window.dispatchEvent(new Event("job-started"));
      onOpenChange(false);
      onComplete?.();
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AudioWaveform className="h-5 w-5" />
            {title}
          </DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-1.5 text-sm text-muted-foreground">
              <p>
                Cada lote descarga, analiza y libera los archivos antes de
                pasar al siguiente. El progreso aparece en el indicador
                inferior derecho.
              </p>
              {includeBirdnet && hasExistingBirdnet && (
                <p>
                  Las detecciones BirdNET previas se reemplazarán. Las
                  anotaciones manuales se conservan.
                </p>
              )}
            </div>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <label className="flex items-start gap-3 cursor-pointer">
            <Checkbox
              checked={includeBirdnet}
              onCheckedChange={(v) => setIncludeBirdnet(v === true)}
              className="mt-0.5"
            />
            <div>
              <div className="text-sm font-medium">BirdNET (especies)</div>
              <div className="text-xs text-muted-foreground">
                Identificación automática de aves por archivo
              </div>
            </div>
          </label>

          <label className="flex items-start gap-3 cursor-pointer">
            <Checkbox
              checked={includeIndices}
              onCheckedChange={(v) => setIncludeIndices(v === true)}
              className="mt-0.5"
            />
            <div>
              <div className="text-sm font-medium">Índices acústicos</div>
              <div className="text-xs text-muted-foreground">
                Saturación, ACI, entropías, eventos
              </div>
            </div>
          </label>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={handleStart} disabled={running || !canSubmit}>
            {running && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
            Iniciar análisis
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
