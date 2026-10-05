"use client";

/**
 * "Añadir especie" on the suggestions-only page of a species nobody is
 * validating yet. Same write as the panel on the index (`createCampaign`, which
 * also draws the sample), just with the species already chosen — the reader
 * got here by listening to the clips that argue for it.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Plus } from "lucide-react";

import { createCampaign } from "@/app/audio/validacion/actions";

export function AddSuggestedSpeciesButton({
  species,
  disabledReason = null,
}: {
  species: string;
  /**
   * Set when there is nothing to draw (see `addSuggestedSpeciesState`): the
   * button stays visible but inert, with the reason beside it.
   */
  disabledReason?: string | null;
}) {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const add = () => {
    setSubmitting(true);
    setError(null);
    void createCampaign({ species })
      .then((result) => {
        if (!result.success) {
          setError(result.error);
          return;
        }
        if (result.data.drawError) {
          setError(
            `Especie añadida, pero no se pudo extraer la muestra: ${result.data.drawError}`
          );
        }
        // The page re-renders as the full species view either way.
        startTransition(() => router.refresh());
      })
      .catch(() => setError("Error inesperado"))
      .finally(() => setSubmitting(false));
  };

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <button
        type="button"
        onClick={add}
        disabled={submitting || disabledReason != null}
        title={disabledReason ?? undefined}
        className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm text-background hover:opacity-90 disabled:opacity-60"
      >
        {submitting ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Plus className="h-3.5 w-3.5" />
        )}
        Añadir especie a validación
      </button>
      {disabledReason ? (
        <span className="text-xs text-muted-foreground">{disabledReason}</span>
      ) : null}
      {error ? <span className="text-xs text-rose-700">{error}</span> : null}
    </span>
  );
}
