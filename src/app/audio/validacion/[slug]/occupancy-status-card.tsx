"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { triggerOccupancyRun } from "@/app/ocupacion/actions";
import { describeThresholdEs } from "@/lib/occupancy/threshold-drift";
import type { SpeciesOccupancyThresholdView } from "@/app/audio/validacion/actions";

/**
 * Closes the loop between applying a threshold and the models that consume it.
 *
 * Applying a threshold rewrites every species count, chart and export on read —
 * but NOT the occupancy models, which are fitted numbers stored per run. Without
 * this card the decision looks complete while `/ocupacion` quietly keeps serving
 * an estimate built from the old filter.
 *
 * `canRun` is decided on the server from the caller's camera-trap role. The
 * button is hidden rather than disabled for anyone else: `triggerOccupancyRun`
 * redirects on a permission failure, so a visible-but-unauthorized button would
 * bounce the reviewer out of the page they were working in.
 */
export function OccupancyStatusCard({
  status,
  canRun,
}: {
  status: SpeciesOccupancyThresholdView;
  canRun: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  const router = useRouter();

  const trigger = () => {
    setError(null);
    startTransition(async () => {
      const res = await triggerOccupancyRun();
      if (!res.success) setError(res.error);
      else {
        setQueued(true);
        // Same signal the /ocupacion trigger sends, so the shared floating job
        // toast appears here too instead of on the next poll.
        window.dispatchEvent(new Event("job-started"));
        router.refresh();
      }
    });
  };

  const running = status.runInProgress || queued;

  if (!status.stale) {
    return (
      <p className="text-xs text-muted-foreground">
        Los modelos de ocupación (
        {status.runCompletedAt
          ? new Date(status.runCompletedAt).toLocaleDateString("es-EC")
          : "sin fecha"}
        ) ya usan{" "}
        {describeThresholdEs(status.atRun, status.globalThreshold, status.nowSource)} para
        esta especie.
      </p>
    );
  }

  return (
    <Card className="border-amber-300 bg-amber-50/60">
      <CardHeader>
        <CardTitle className="text-base text-amber-900">
          Los modelos de ocupación aún no usan esta decisión
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm text-amber-950">
        <p>
          El último cálculo de ocupación (
          {status.runCompletedAt
            ? new Date(status.runCompletedAt).toLocaleDateString("es-EC")
            : "sin fecha"}
          ) leyó las detecciones de esta especie con{" "}
          <strong>{describeThresholdEs(status.atRun, status.globalThreshold)}</strong>, y hoy
          rige{" "}
          <strong>
            {describeThresholdEs(status.now, status.globalThreshold, status.nowSource)}
          </strong>
          .
          {status.hasAudioModel
            ? " Su modelo de audio sigue mostrando el resultado anterior."
            : " Con el umbral nuevo puede que ahora haya datos suficientes para modelarla."}
        </p>
        <p className="text-xs">
          Volver a correr los modelos recalcula <em>todas</em> las especies (unos minutos);
          si va a validar varias, conviene hacerlo al final.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {canRun ? (
            <Button size="sm" onClick={trigger} disabled={pending || running}>
              {pending
                ? "Encolando…"
                : running
                  ? "Actualización en curso…"
                  : "Actualizar modelos de ocupación"}
            </Button>
          ) : null}
          <Link
            href="/ocupacion"
            className="text-xs font-medium text-sky-800 hover:underline"
          >
            Ir a Ocupación
          </Link>
          {status.hasAudioModel ? (
            <Link
              href={`/ocupacion/${encodeURIComponent(status.species)}?stream=audio`}
              className="text-xs font-medium text-sky-800 hover:underline"
            >
              Ver el modelo de esta especie
            </Link>
          ) : null}
          {error ? <span className="text-xs text-red-700">{error}</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}
