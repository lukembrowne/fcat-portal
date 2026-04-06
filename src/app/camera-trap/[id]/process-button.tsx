"use client";

import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { getMLStatus } from "../actions";
import { ProcessConfirmDialog } from "../process-confirm-dialog";

export function ProcessButton({
  deploymentId,
  isAdmin,
}: {
  deploymentId: number;
  isAdmin: boolean;
}) {
  const [dialogIds, setDialogIds] = useState<number[] | null>(null);
  const [started, setStarted] = useState(false);
  const [mlStatus, setMlStatus] = useState<{
    available: boolean;
    message: string;
  } | null>(null);

  useEffect(() => {
    getMLStatus().then(setMlStatus);
  }, []);

  const mlUnavailable = mlStatus !== null && !mlStatus.available;

  return (
    <div className="flex items-center gap-3">
      <Button
        onClick={() => setDialogIds([deploymentId])}
        disabled={mlUnavailable || started}
      >
        {started ? "Procesando..." : "Procesar Imágenes"}
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

      <ProcessConfirmDialog
        deploymentIds={dialogIds}
        isAdmin={isAdmin}
        onClose={() => setDialogIds(null)}
        onStarted={() => {
          setStarted(true);
          window.dispatchEvent(new Event("job-started"));
        }}
      />
    </div>
  );
}
