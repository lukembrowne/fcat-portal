import { Badge } from "@/components/ui/badge";
import { stageLabel, stageTone } from "./labels";

/**
 * The stage of one species, as a coloured pill.
 *
 * Uses the shared `Badge` primitive so the shape matches every other tag in the
 * portal, with the per-stage tone supplied by `stageTone` — the colours are
 * meaning, not decoration, and live in `labels.ts` next to the wording so the
 * two cannot drift.
 */
export function StageTag({ status, title }: { status: string; title?: string }) {
  return (
    <Badge
      variant="outline"
      title={title}
      // Never wraps: an unusable fit's reason used to render inside the table
      // cell and stretched the Estado column past every other one.
      className={`whitespace-nowrap ${stageTone(status)}`}
    >
      {stageLabel(status)}
    </Badge>
  );
}
