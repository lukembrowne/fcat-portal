"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import {
  drawSample,
  runFit,
  applyThreshold,
  revertThreshold,
  abandonCampaign,
  deleteCampaign,
  restoreCampaign,
} from "@/app/audio/validacion/actions";

type Action =
  | { kind: "draw" }
  | { kind: "fit" }
  | { kind: "apply"; thresholdId: number }
  | { kind: "revert"; thresholdId: number }
  | { kind: "abandon" }
  | { kind: "delete" }
  | { kind: "restore" };

interface CampaignControlsProps {
  campaignId: number;
  canEdit: boolean;
  hasSamples: boolean;
  hasDrawnSample: boolean;
  status: string;
  latestThresholdId: number | null;
  latestIsUsable: boolean;
  latestIsActive: boolean;
  /**
   * The latest row is a "needs no filter" decision, not a fit. Only changes the
   * button copy — applying and reverting are the same operation either way —
   * but "Aplicar umbral" on a row that exists to say there is no umbral reads
   * as the opposite of what it does.
   */
  latestIsNoFilter?: boolean;
  /** Distinct people with at least one answer. Zero means delete is offerable. */
  reviewerCount: number;
  species: string;
}

export function CampaignControls({
  campaignId,
  canEdit,
  hasSamples,
  hasDrawnSample,
  status,
  latestThresholdId,
  latestIsUsable,
  latestIsActive,
  latestIsNoFilter = false,
  reviewerCount,
  species,
}: CampaignControlsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<Action["kind"] | null>(null);
  const [message, setMessage] = useState<{ tone: "ok" | "err"; text: string } | null>(
    null
  );

  if (!canEdit) return null;

  const run = (action: Action) => {
    setBusy(action.kind);
    setMessage(null);
    void (async () => {
      try {
        let result;
        switch (action.kind) {
          case "draw":
            result = await drawSample(campaignId);
            break;
          case "fit":
            result = await runFit(campaignId);
            break;
          case "apply":
            result = await applyThreshold(action.thresholdId);
            break;
          case "revert":
            result = await revertThreshold(action.thresholdId);
            break;
          case "abandon": {
            const reason = window.prompt("Motivo para descartar esta especie:");
            if (!reason) {
              setBusy(null);
              return;
            }
            result = await abandonCampaign(campaignId, reason);
            break;
          }
          case "delete": {
            const ok = window.confirm(
              `¿Eliminar ${species} de la lista? Se borran sus clips muestreados. No se puede deshacer.`
            );
            if (!ok) {
              setBusy(null);
              return;
            }
            result = await deleteCampaign(campaignId);
            break;
          }
          case "restore":
            result = await restoreCampaign(campaignId);
            break;
        }

        if (!result.success) {
          setMessage({ tone: "err", text: result.error });
        } else if (action.kind === "delete") {
          // The page this renders on no longer has a campaign behind it.
          router.push("/audio/validacion");
          return;
        } else if (action.kind === "fit") {
          const data = result.data as { usable: boolean; reason: string | null };
          setMessage(
            data.usable
              ? { tone: "ok", text: "Modelo ajustado" }
              : { tone: "err", text: data.reason ?? "El ajuste no produjo un umbral" }
          );
        } else {
          setMessage({ tone: "ok", text: "Listo" });
        }
        startTransition(() => router.refresh());
      } catch {
        setMessage({ tone: "err", text: "Error inesperado" });
      } finally {
        setBusy(null);
      }
    })();
  };

  const disabled = busy !== null || pending;
  const abandoned = status === "abandoned";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {!hasDrawnSample && !abandoned ? (
          <Btn onClick={() => run({ kind: "draw" })} disabled={disabled} busy={busy === "draw"}>
            Extraer muestra
          </Btn>
        ) : null}

        {hasSamples && !abandoned ? (
          <Btn onClick={() => run({ kind: "fit" })} disabled={disabled} busy={busy === "fit"}>
            Ajustar modelo
          </Btn>
        ) : null}

        {latestThresholdId != null && latestIsUsable && !latestIsActive ? (
          <Btn
            onClick={() => run({ kind: "apply", thresholdId: latestThresholdId })}
            disabled={disabled}
            busy={busy === "apply"}
            primary
          >
            {latestIsNoFilter ? "Aplicar «sin filtro»" : "Aplicar umbral"}
          </Btn>
        ) : null}

        {latestThresholdId != null && latestIsActive ? (
          <Btn
            onClick={() => run({ kind: "revert", thresholdId: latestThresholdId })}
            disabled={disabled}
            busy={busy === "revert"}
          >
            {latestIsNoFilter ? "Volver al umbral global" : "Revertir umbral"}
          </Btn>
        ) : null}

        {!abandoned ? (
          <Btn onClick={() => run({ kind: "abandon" })} disabled={disabled} busy={busy === "abandon"}>
            Descartar especie
          </Btn>
        ) : (
          <Btn onClick={() => run({ kind: "restore" })} disabled={disabled} busy={busy === "restore"}>
            Recuperar especie
          </Btn>
        )}

        {/* Offered only while nothing has been reviewed. `deleteCampaign`
            enforces the same rule server-side; this just avoids showing a
            button that can only fail. */}
        {reviewerCount === 0 ? (
          <Btn onClick={() => run({ kind: "delete" })} disabled={disabled} busy={busy === "delete"}>
            Eliminar de la lista
          </Btn>
        ) : null}
      </div>

      {message ? (
        <p
          className={`text-xs ${
            message.tone === "ok" ? "text-emerald-700" : "text-rose-700"
          }`}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}

function Btn({
  onClick,
  disabled,
  busy,
  primary,
  children,
}: {
  onClick: () => void;
  disabled: boolean;
  busy: boolean;
  primary?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm disabled:opacity-50 ${
        primary ? "bg-foreground text-background hover:opacity-90" : "hover:bg-muted"
      }`}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
      {children}
    </button>
  );
}
