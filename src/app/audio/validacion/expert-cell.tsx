"use client";

/**
 * The "Requiere experto" tag of one species: a pill that is also its own
 * toggle for an editor, and a read-only pill (or nothing) for a viewer.
 *
 * A button with `aria-pressed` rather than a checkbox: the value is binary and
 * the control has to look like the tag a viewer sees, so tagged species read
 * the same whoever is looking. Saves optimistically for the same reason
 * `priority-cell.tsx` does — the revalidated table takes seconds to arrive.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  EXPERT_HINT,
  EXPERT_LABEL,
  EXPERT_OFF_TONE,
  EXPERT_SHORT_LABEL,
  EXPERT_TONE,
} from "./labels";
import { updateCampaignNeedsExpert } from "./actions";

export function ExpertCell({
  campaignId,
  displayName,
  needsExpert,
  canEdit,
  full = false,
}: {
  campaignId: number;
  /** Names the control for a screen reader; a wide table loses which row it is. */
  displayName: string;
  needsExpert: boolean;
  canEdit: boolean;
  /** Full label ("Requiere experto") where no column header gives context. */
  full?: boolean;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Render-time state adjustment, as in PriorityCell: the optimistic value is
  // dropped once the refreshed prop catches up, so a change made elsewhere
  // (the species page vs. the table) still reaches this cell.
  const [optimistic, setOptimistic] = useState<boolean | undefined>(undefined);
  const [lastValue, setLastValue] = useState(needsExpert);
  if (needsExpert !== lastValue) {
    setLastValue(needsExpert);
    setOptimistic(undefined);
  }
  const shown = optimistic ?? needsExpert;
  const label = full ? EXPERT_LABEL : EXPERT_SHORT_LABEL;

  if (!canEdit) {
    return shown ? (
      <ExpertTag label={label} />
    ) : full ? null : (
      <span className="text-muted-foreground">—</span>
    );
  }

  const toggle = () => {
    const next = !shown;
    setOptimistic(next);
    setSaving(true);
    setError(null);
    void updateCampaignNeedsExpert(campaignId, next)
      .then((result) => {
        if (!result.success) {
          setOptimistic(!next);
          setError(result.error);
          return;
        }
        router.refresh();
      })
      .catch(() => {
        setOptimistic(!next);
        setError("Error inesperado");
      })
      .finally(() => setSaving(false));
  };

  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <button
        type="button"
        onClick={toggle}
        disabled={saving}
        aria-pressed={shown}
        aria-label={`${EXPERT_LABEL}: ${displayName}`}
        title={
          shown
            ? `${EXPERT_HINT} Clic para quitar la etiqueta.`
            : `Marcar: ${EXPERT_HINT}`
        }
        className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md border px-2 py-0.5 text-xs font-medium hover:brightness-95 ${
          shown ? EXPERT_TONE : EXPERT_OFF_TONE
        }`}
      >
        {saving ? <Loader2 className="h-3 w-3 animate-spin opacity-70" /> : null}
        {shown ? label : full ? `Marcar: ${EXPERT_LABEL.toLowerCase()}` : "No"}
      </button>
      {error ? (
        <span className="max-w-[10rem] text-[11px] text-rose-700">{error}</span>
      ) : null}
    </span>
  );
}

/** The read-only pill, in the shared `Badge` shape. */
export function ExpertTag({ label = EXPERT_LABEL }: { label?: string }) {
  return (
    <Badge
      variant="outline"
      title={EXPERT_HINT}
      className={`whitespace-nowrap ${EXPERT_TONE}`}
    >
      {label}
    </Badge>
  );
}
