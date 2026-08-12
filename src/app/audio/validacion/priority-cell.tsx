"use client";

/**
 * The review priority of one species: a coloured pill that is also its own
 * editor.
 *
 * A native `<select>` rather than the popover the notes cell uses, and the
 * difference is the shape of the value. A note is free text that wants room to
 * type and an explicit Guardar; a priority is one of three known values, and
 * anything more than a single click to change it is friction paid on every row
 * of a triage pass down the list. The select carries keyboard navigation, type
 * ahead and the platform's own touch picker for free.
 *
 * `appearance-none` strips the platform chevron so the control renders as the
 * same pill a viewer sees — the tone is the meaning, and a species' urgency
 * must not look different depending on who is reading. A chevron appears on
 * hover instead, which is where the affordance is actually needed.
 *
 * Saves optimistically for the same reason `notes-cell.tsx` does:
 * `updateCampaignPriority` revalidates a page that counts detections across
 * every species (~3 s in dev), and holding the pill on its old value until
 * that lands reads as a control that ignored the click.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, Loader2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  CAMPAIGN_PRIORITIES,
  type CampaignPriority,
} from "@/lib/birdnet-validation/types";
import { PRIORITY_HINT, PRIORITY_LABEL, priorityLabel, priorityTone } from "./labels";
import { updateCampaignPriority } from "./actions";

export function PriorityCell({
  campaignId,
  displayName,
  priority,
  canEdit,
}: {
  campaignId: number;
  /** Names the control for a screen reader; a wide table loses which row it is. */
  displayName: string;
  priority: string;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Shown immediately on change, dropped once the refreshed prop catches up
  // (render-time state adjustment, React's recommended alternative to an
  // effect) — otherwise a change made on the species page would never reach
  // this cell.
  const [optimistic, setOptimistic] = useState<string | undefined>(undefined);
  const [lastPriority, setLastPriority] = useState(priority);
  if (priority !== lastPriority) {
    setLastPriority(priority);
    setOptimistic(undefined);
  }
  const shown = optimistic ?? priority;

  if (!canEdit) {
    return <PriorityTag priority={shown} />;
  }

  const change = (next: string) => {
    if (next === shown) return;
    const previous = shown;
    setOptimistic(next);
    setSaving(true);
    setError(null);
    void updateCampaignPriority(campaignId, next)
      .then((result) => {
        if (!result.success) {
          setOptimistic(previous);
          setError(result.error);
          return;
        }
        router.refresh();
      })
      .catch(() => {
        setOptimistic(previous);
        setError("Error inesperado");
      })
      .finally(() => setSaving(false));
  };

  return (
    <span className="inline-flex flex-col items-start gap-0.5">
      <span className="group/priority relative inline-flex items-center">
        <select
          value={shown}
          onChange={(e) => change(e.target.value)}
          aria-label={`Prioridad de ${displayName}`}
          title={PRIORITY_HINT[shown as CampaignPriority] ?? undefined}
          className={`appearance-none rounded-md border px-2 py-0.5 pr-5 text-xs font-medium ${priorityTone(
            shown
          )} cursor-pointer hover:brightness-95`}
        >
          {/* A level the schema gained but this list has not would otherwise
              render as a blank select showing none of its options. */}
          {!CAMPAIGN_PRIORITIES.includes(shown as CampaignPriority) ? (
            <option value={shown}>{shown}</option>
          ) : null}
          {CAMPAIGN_PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {PRIORITY_LABEL[p]}
            </option>
          ))}
        </select>
        <span className="pointer-events-none absolute right-1 flex items-center">
          {saving ? (
            <Loader2 className="h-3 w-3 animate-spin opacity-70" />
          ) : (
            <ChevronDown className="h-3 w-3 opacity-40 transition-opacity group-hover/priority:opacity-90" />
          )}
        </span>
      </span>
      {error ? (
        <span className="max-w-[10rem] text-[11px] text-rose-700">{error}</span>
      ) : null}
    </span>
  );
}

/**
 * The read-only pill, in the shared `Badge` shape every other tag in the portal
 * uses. Never wraps: "Prioridad media" broken across two lines is what stretches
 * a dense table row.
 */
export function PriorityTag({ priority }: { priority: string }) {
  return (
    <Badge
      variant="outline"
      title={PRIORITY_HINT[priority as CampaignPriority] ?? undefined}
      className={`whitespace-nowrap ${priorityTone(priority)}`}
    >
      {priorityLabel(priority)}
    </Badge>
  );
}
