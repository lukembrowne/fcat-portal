"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { refreshOccupancyReadiness } from "./actions";

/**
 * Freshness + refresh control for the /ocupacion data-readiness snapshot. The
 * page renders instantly from a stored snapshot; this shows when it was last
 * generated, flags when live data has changed since, and lets editors/admins
 * recompute it on demand. Mirrors the model-run RunControl, but the refresh runs
 * inline (seconds) rather than enqueuing a background job.
 *
 * Copy is role-aware: the refresh button is editor/admin-only, so viewers see the
 * condition without a call to action they can't act on.
 */
export function ReadinessSnapshotControl({
  isEditor,
  stale,
  generatedAt,
}: {
  isEditor: boolean;
  stale: boolean;
  /** ISO string, or null on cold start (no snapshot yet). */
  generatedAt: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const refresh = () => {
    setError(null);
    startTransition(async () => {
      const res = await refreshOccupancyReadiness();
      if (!res.success) setError(res.error);
      else router.refresh();
    });
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-muted-foreground">
          {generatedAt ? (
            <span>
              Disponibilidad de datos — última actualización:{" "}
              {new Date(generatedAt).toLocaleString("es-EC")}
            </span>
          ) : (
            <span>Disponibilidad de datos aún no calculada.</span>
          )}
        </div>
        {isEditor ? (
          <div className="flex items-center gap-2">
            {error ? <span className="text-xs text-red-600">{error}</span> : null}
            <Button onClick={refresh} disabled={pending} size="sm" variant="outline">
              {pending ? "Actualizando…" : "Actualizar disponibilidad"}
            </Button>
          </div>
        ) : null}
      </div>
      {stale ? (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          Hay datos nuevos desde la última actualización
          {isEditor ? " — actualizar" : "."}
        </p>
      ) : null}
    </div>
  );
}
