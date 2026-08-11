"use client";

/**
 * The species table's notes cell: one truncated line, the full text on hover,
 * and click-to-edit in place.
 *
 * The column has to stay one line — these notes run to a couple of sentences
 * ("Range shows Andes. Possible? Not on JF list. CHECK") and wrapping even one
 * of them doubles the height of every row. So the full text lives on a hover
 * tooltip rather than a native `title`: `title` renders nothing until the
 * browser feels like it, collapses the line breaks an imported cell carries,
 * and cannot be styled to a readable width.
 *
 * Editing was the missing half. A note is a working annotation — "CHECK"
 * becomes "confirmed with JF" once someone has checked — and until now the only
 * place to change one was the species page. The reader who spots the stale note
 * is looking at the table, so the edit belongs there too.
 *
 * The editor is a Popover, NOT a textarea grown inside the cell or an absolute
 * overlay: the table scrolls horizontally inside `overflow-x-auto`, which
 * clips any in-flow overlay that reaches past the last row, and widening the
 * cell would re-lay-out every column while somebody types. A portaled popover
 * escapes the scroller and brings Escape-to-close and focus handling with it.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { updateCampaignNotes } from "./actions";

export function NotesCell({
  campaignId,
  displayName,
  notes,
  canEdit,
}: {
  campaignId: number;
  /** Titles the edit box, so a wide table cannot lose which row it belongs to. */
  displayName: string;
  notes: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [tipOpen, setTipOpen] = useState(false);
  const [draft, setDraft] = useState(notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Shown immediately on save, so the row does not sit on the old text until
  // the server round-trip lands. Dropped again once the refreshed prop catches
  // up (render-time state adjustment, React's recommended alternative to an
  // effect) — otherwise an edit made elsewhere, on the species page, would
  // never reach this cell.
  const [optimistic, setOptimistic] = useState<string | null | undefined>(undefined);
  const [lastNotes, setLastNotes] = useState(notes);
  if (notes !== lastNotes) {
    setLastNotes(notes);
    setOptimistic(undefined);
  }
  const shown = optimistic !== undefined ? optimistic : notes;
  const stored = shown ?? "";
  const dirty = draft.trim() !== stored.trim();

  const open = () => {
    setDraft(stored);
    setError(null);
    setTipOpen(false);
    setEditing(true);
  };

  // Back to what is stored, not to what was typed: leaving the discarded draft
  // in the box makes the next click look like the save silently failed.
  const cancel = () => {
    setDraft(stored);
    setError(null);
    setEditing(false);
  };

  /**
   * Closes on click and shows the new text at once, rather than holding the
   * box open until the write lands: `updateCampaignNotes` revalidates this
   * page, so the response carries a re-render of a table that counts
   * detections across every species — measured at ~3 s in dev. Waiting on that
   * with the editor open reads as a stuck button.
   *
   * A failure re-opens the editor with the typed text still in it and the
   * reason underneath, so nothing is lost and nothing is claimed to have been
   * saved that was not. The row keeps a spinner until then.
   */
  const save = () => {
    if (!dirty) {
      setEditing(false);
      return;
    }
    const next = draft.trim() || null;
    const previous = shown;
    setOptimistic(next);
    setEditing(false);
    setSaving(true);
    setError(null);
    void updateCampaignNotes(campaignId, draft)
      .then((result) => {
        if (!result.success) {
          setOptimistic(previous);
          setError(result.error);
          setEditing(true);
          return;
        }
        startTransition(() => router.refresh());
      })
      .catch(() => {
        setOptimistic(previous);
        setError("Error inesperado");
        setEditing(true);
      })
      .finally(() => setSaving(false));
  };

  const line = shown ? (
    <span className="block truncate text-xs text-muted-foreground">{shown}</span>
  ) : (
    <span className="text-xs text-muted-foreground">—</span>
  );

  // Viewers get the hover, not the edit: the affordance would be a lie, since
  // `updateCampaignNotes` requires editor either way.
  if (!canEdit) {
    if (!shown) return <span className="text-xs text-muted-foreground">—</span>;
    return (
      <NoteTooltip note={shown} open={tipOpen} onOpenChange={setTipOpen}>
        <span className="block cursor-default truncate text-xs text-muted-foreground">
          {shown}
        </span>
      </NoteTooltip>
    );
  }

  return (
    <Popover
      open={editing}
      onOpenChange={(next) => {
        if (next) open();
        else cancel();
      }}
    >
      <NoteTooltip note={shown} open={tipOpen && !editing} onOpenChange={setTipOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={
              shown ? `Editar las notas de ${displayName}` : `Añadir una nota a ${displayName}`
            }
            className="group/notes -mx-1 flex w-[calc(100%+0.5rem)] items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-muted"
          >
            <span className="min-w-0 flex-1">{line}</span>
            {saving ? (
              <Loader2 className="h-3 w-3 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <Pencil className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/notes:opacity-100" />
            )}
          </button>
        </PopoverTrigger>
      </NoteTooltip>

      <PopoverContent
        align="end"
        className="w-[24rem] max-w-[90vw] space-y-2 p-3"
        // A click outside is an ambiguous gesture, so it must not decide the
        // fate of typed text. With nothing typed it closes; with a pending
        // change it does not, and Guardar / Cancelar / Esc stay the only ways
        // out.
        onInteractOutside={(e) => {
          if (dirty) e.preventDefault();
        }}
      >
        <p className="truncate text-xs font-medium">Notas · {displayName}</p>
        <textarea
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Plain Enter inserts a line break: an imported cell can carry its
            // own list, and retyping one here must not submit halfway through.
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              save();
            }
          }}
          rows={4}
          placeholder="Fuera de rango; no está en la lista de JF. REVISAR"
          className="w-full resize-y rounded border bg-background px-2 py-1 text-sm"
        />
        {/* Only ever the reason a save came back rejected: the editor is
            closed while one is in flight, so there is no pending state to
            report here. */}
        {error ? <p className="text-xs text-rose-700">{error}</p> : null}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={save}
            className="rounded-md bg-foreground px-2.5 py-1 text-xs text-background"
          >
            Guardar
          </button>
          <button
            type="button"
            onClick={cancel}
            className="rounded-md border px-2.5 py-1 text-xs hover:bg-muted"
          >
            Cancelar
          </button>
          <span className="ml-auto text-[11px] text-muted-foreground">
            ⌘/Ctrl + Enter guarda
          </span>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * The full note on hover. `whitespace-pre-wrap` because an imported cell can
 * carry its own line breaks and re-flowing them into a paragraph loses the list
 * somebody wrote. A null note renders the child bare — there is nothing to
 * reveal, and an empty tooltip on every noteless row is worse than none.
 *
 * Open state is controlled by the caller so the tooltip can be held shut while
 * the editor is open: an uncontrolled one re-fires on the pointer movement that
 * follows the click and floats over the box being typed into.
 */
function NoteTooltip({
  note,
  open,
  onOpenChange,
  children,
}: {
  note: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactElement;
}) {
  if (!note) return children;
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip open={open} onOpenChange={onOpenChange}>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side="top" align="end" className="max-w-sm">
          <p className="whitespace-pre-wrap text-xs">{note}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
