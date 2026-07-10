"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { triggerOccupancyRun, type LatestOccupancyRunInfo } from "./actions";

export function RunControl({
  isAdmin,
  info,
}: {
  isAdmin: boolean;
  info: LatestOccupancyRunInfo;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const active = info.activeJob;

  const trigger = () => {
    setError(null);
    startTransition(async () => {
      const res = await triggerOccupancyRun();
      if (!res.success) setError(res.error);
      else {
        // Pop the shared floating progress toast immediately instead of waiting
        // for its next poll (mirrors the camera-trap / audio job triggers).
        window.dispatchEvent(new Event("job-started"));
        router.refresh();
      }
    });
  };

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="text-sm text-muted-foreground">
        {active ? (
          <span>
            Actualizando modelos… {active.processedImages ?? 0} de {active.totalImages ?? "?"}
            {active.statusMessage ? ` — ${active.statusMessage}` : ""}
          </span>
        ) : info.run ? (
          <span>
            Última actualización:{" "}
            {info.run.completedAt ? new Date(info.run.completedAt).toLocaleString("es-EC") : "—"} ·{" "}
            {info.run.nEligible} especies modeladas de {info.run.nModels}
          </span>
        ) : (
          <span>Aún no se han ajustado modelos.</span>
        )}
      </div>
      {isAdmin ? (
        <div className="flex items-center gap-2">
          {error ? <span className="text-xs text-red-600">{error}</span> : null}
          <Button onClick={trigger} disabled={pending || !!active} size="sm">
            {pending ? "Encolando…" : active ? "En curso…" : "Actualizar modelos"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
