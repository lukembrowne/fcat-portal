"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ProcessConfirmDialog } from "../process-confirm-dialog";

export function ProcessButton({
  deploymentId,
  isAdmin,
  hasImages = true,
  hasVideos = false,
}: {
  deploymentId: number;
  isAdmin: boolean;
  hasImages?: boolean;
  hasVideos?: boolean;
}) {
  const [dialogIds, setDialogIds] = useState<number[] | null>(null);
  const [started, setStarted] = useState(false);

  return (
    <div className="flex items-center gap-3">
      <Button
        onClick={() => setDialogIds([deploymentId])}
        disabled={started}
      >
        {started ? "Procesando..." : "Procesar"}
      </Button>
      {started && (
        <p className="text-sm text-muted-foreground">
          Progreso visible en el widget flotante
        </p>
      )}

      <ProcessConfirmDialog
        deploymentIds={dialogIds}
        isAdmin={isAdmin}
        hasImages={hasImages}
        hasVideos={hasVideos}
        onClose={() => setDialogIds(null)}
        onStarted={() => {
          setStarted(true);
          window.dispatchEvent(new Event("job-started"));
        }}
      />
    </div>
  );
}
