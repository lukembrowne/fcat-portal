"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { triggerOccupancyRun, type LatestOccupancyRunInfo } from "./actions";
import { speciesSlug } from "@/lib/species-slug";
import { shortThresholdEs, type ThresholdChange } from "@/lib/occupancy/threshold-drift";

function ChangeLine({ change }: { change: ThresholdChange }) {
  return (
    <li>
      <Link
        href={`/ocupacion/${encodeURIComponent(change.species)}?stream=audio`}
        className="font-medium italic hover:underline"
      >
        {change.species}
      </Link>
      : {shortThresholdEs(change.atRun)} → {shortThresholdEs(change.now)}{" "}
      <Link
        href={`/audio/validacion/${speciesSlug(change.species)}`}
        className="text-muted-foreground hover:underline"
      >
        (validación)
      </Link>
    </li>
  );
}

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
  const changes = info.thresholdChanges;

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
    <div className="space-y-2">
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

      {/* A threshold applied in /audio/validacion changes which detections a run
          would read, but does nothing to models already fitted. Warned here
          because this is where the button that fixes it lives. */}
      {changes.length > 0 ? (
        <div className="rounded-md border border-amber-500/60 bg-amber-50/50 dark:bg-amber-950/20 p-3 space-y-1">
          <p className="text-xs font-medium text-amber-800 dark:text-amber-300">
            {changes.length === 1
              ? "1 especie tiene un umbral de confianza distinto al que usaron estos modelos."
              : `${changes.length} especies tienen un umbral de confianza distinto al que usaron estos modelos.`}{" "}
            Sus resultados de audio corresponden al filtro anterior hasta que se vuelvan a
            correr los modelos.
          </p>
          <ul className="text-xs text-amber-700 dark:text-amber-400 list-disc pl-5 space-y-0.5">
            {changes.slice(0, 8).map((c) => (
              <ChangeLine key={c.species} change={c} />
            ))}
          </ul>
          {changes.length > 8 ? (
            <p className="text-xs text-amber-700 dark:text-amber-400">
              …y {changes.length - 8} más.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
