"use client";

import { useState, useTransition, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { createProcessingJob, processJob, getMLStatus } from "../actions";
import { ML_DEFAULTS } from "@/lib/ml-defaults";

export function ProcessButton({ deploymentId }: { deploymentId: number }) {
  const [isPending, startTransition] = useTransition();
  const [started, setStarted] = useState(false);
  const [mlStatus, setMlStatus] = useState<{
    available: boolean;
    message: string;
  } | null>(null);

  useEffect(() => {
    getMLStatus().then(setMlStatus);
  }, []);

  const handleProcess = () => {
    startTransition(async () => {
      const result = await createProcessingJob(deploymentId, ML_DEFAULTS);

      if (!result.success) {
        alert(`Error: ${result.error}`);
        return;
      }

      // Fire-and-forget: processJob runs in background
      processJob(result.data.jobId);
      setStarted(true);
      window.dispatchEvent(new Event("job-started"));
    });
  };

  const mlUnavailable = mlStatus !== null && !mlStatus.available;

  return (
    <div className="flex items-center gap-3">
      <Button
        onClick={handleProcess}
        disabled={isPending || mlUnavailable || started}
      >
        {isPending ? "Iniciando..." : started ? "Procesando..." : "Procesar Imágenes"}
      </Button>
      {started && (
        <p className="text-sm text-muted-foreground">
          Progreso visible en el widget flotante
        </p>
      )}
      {mlUnavailable && (
        <p className="text-sm text-amber-600 max-w-xs">
          ML no disponible: {mlStatus.message}
        </p>
      )}
    </div>
  );
}
