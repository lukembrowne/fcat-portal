"use client";

/**
 * "This species needs no filter" — the action for a fit that refused because
 * every review was correct.
 *
 * Its own component rather than another branch in `CampaignControls` because it
 * belongs beside the evidence that justifies it: the sentence saying how many
 * detections the global 0.70 is discarding is the argument for pressing it, and
 * a button three cards away from its reason gets pressed for the wrong reasons.
 *
 * Confirms first. It takes effect across the whole portal immediately — species
 * counts, charts, exports and occupancy inputs all read the applied threshold —
 * and unlike a fitted threshold there is no intermediate screen to review.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { markSpeciesNoFilter } from "@/app/audio/validacion/actions";

export function NoFilterButton({
  campaignId,
  displayName,
  droppedByGlobal,
}: {
  campaignId: number;
  displayName: string;
  /** Detections the global default is currently discarding, for the prompt. */
  droppedByGlobal: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = () => {
    const ok = window.confirm(
      `¿Marcar ${displayName} como especie sin filtro de confianza?\n\n` +
        `Se conservarán todas sus detecciones en todo el portal` +
        (droppedByGlobal > 0
          ? `, incluidas las ${droppedByGlobal.toLocaleString("es-EC")} que el umbral global descarta hoy`
          : "") +
        `.\n\nSe puede revertir.`
    );
    if (!ok) return;

    setBusy(true);
    setError(null);
    void markSpeciesNoFilter(campaignId)
      .then((result) => {
        if (!result.success) setError(result.error);
        else startTransition(() => router.refresh());
      })
      .catch(() => setError("Error inesperado"))
      .finally(() => setBusy(false));
  };

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={run}
        disabled={busy || pending}
        className="inline-flex items-center gap-1.5 rounded-md border border-emerald-600 bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-50"
      >
        {busy || pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        Marcar sin filtro y conservar todo
      </button>
      {error ? <p className="text-[11px] text-rose-700">{error}</p> : null}
    </div>
  );
}
