"use client";

/**
 * Per-row destructive/recovery actions for the species table.
 *
 * Two actions, never a menu: they are mutually exclusive for most rows, and a
 * dropdown in a dense table cell costs a click to discover a single option.
 *
 * Delete is offered only when nobody has reviewed anything. `reviewerCount` is
 * the count of DISTINCT reviewers with at least one answer, so zero means the
 * campaign carries no review rows at all — the same condition `deleteCampaign`
 * enforces server-side. The button is a hint, not the guard; hiding it does not
 * make the action safe, the server check does.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RotateCcw, Trash2 } from "lucide-react";

import { deleteCampaign, restoreCampaign } from "./actions";

export function SpeciesRowActions({
  campaignId,
  species,
  displayName,
  status,
  reviewerCount,
}: {
  campaignId: number;
  species: string;
  displayName: string;
  status: string;
  reviewerCount: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"delete" | "restore" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const abandoned = status === "abandoned";
  const deletable = reviewerCount === 0;

  if (!abandoned && !deletable) return null;

  const run = (kind: "delete" | "restore") => {
    if (kind === "delete") {
      const ok = window.confirm(
        `¿Eliminar ${displayName} (${species}) de la lista? Se borran sus clips muestreados. No se puede deshacer.`
      );
      if (!ok) return;
    }

    setBusy(kind);
    setError(null);
    void (kind === "delete" ? deleteCampaign(campaignId) : restoreCampaign(campaignId))
      .then((result) => {
        if (!result.success) setError(result.error);
        else startTransition(() => router.refresh());
      })
      .catch(() => setError("Error inesperado"))
      .finally(() => setBusy(null));
  };

  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <span className="inline-flex items-center gap-1">
        {abandoned ? (
          <button
            type="button"
            onClick={() => run("restore")}
            disabled={busy !== null}
            title="Volver a validar esta especie"
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:opacity-50"
          >
            {busy === "restore" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RotateCcw className="h-3 w-3" />
            )}
            Recuperar
          </button>
        ) : null}

        {deletable ? (
          <button
            type="button"
            onClick={() => run("delete")}
            disabled={busy !== null}
            title="Quitar esta especie de la lista"
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-rose-700 hover:bg-rose-50 disabled:opacity-50"
          >
            {busy === "delete" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Trash2 className="h-3 w-3" />
            )}
            Eliminar
          </button>
        ) : null}
      </span>

      {error ? (
        <span className="max-w-[16rem] text-right text-[11px] text-rose-700">
          {error}
        </span>
      ) : null}
    </span>
  );
}
