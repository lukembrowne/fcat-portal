"use client";

import { useState, useTransition, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { createProcessingJob, getMLStatus } from "../actions";
import { ML_DEFAULTS } from "@/lib/ml-defaults";

export function ProcessButton({ deploymentId }: { deploymentId: number }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
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

      router.push(`/camera-trap/process?jobId=${result.data.jobId}`);
    });
  };

  const mlUnavailable = mlStatus !== null && !mlStatus.available;

  return (
    <div className="flex items-center gap-3">
      <Button
        onClick={handleProcess}
        disabled={isPending || mlUnavailable}
      >
        {isPending ? "Iniciando..." : "Procesar Imágenes"}
      </Button>
      {mlUnavailable && (
        <p className="text-sm text-amber-600 max-w-xs">
          ML no disponible: {mlStatus.message}
        </p>
      )}
    </div>
  );
}
