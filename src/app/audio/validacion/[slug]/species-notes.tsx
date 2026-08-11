"use client";

/**
 * The species' free-text notes, read in full and edited in place.
 *
 * In full, unlike the species table, which truncates to one line: this is the
 * page you open when the table's tooltip is not enough. `whitespace-pre-wrap`
 * because an imported cell can carry its own line breaks and re-flowing them
 * into a paragraph loses the list someone wrote.
 *
 * Editable here rather than from the table row: a note is a couple of
 * sentences, and a textarea inside a dense row would be the widest thing in
 * it. The table stays a list; this is the record.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Pencil } from "lucide-react";

import { updateCampaignNotes } from "@/app/audio/validacion/actions";

export function SpeciesNotes({
  campaignId,
  notes,
  canEdit,
}: {
  campaignId: number;
  notes: string | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(notes ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Nothing to show and nothing to do: a permanently empty "Notas" heading is
  // noise on a page that already carries a lot of it.
  if (!notes && !canEdit) return null;

  const save = () => {
    setSaving(true);
    setError(null);
    void updateCampaignNotes(campaignId, draft)
      .then((result) => {
        if (!result.success) {
          setError(result.error);
          return;
        }
        setEditing(false);
        startTransition(() => router.refresh());
      })
      .catch(() => setError("Error inesperado"))
      .finally(() => setSaving(false));
  };

  if (editing) {
    return (
      <div className="space-y-2 rounded-lg border bg-card p-3">
        <p className="text-sm font-medium">Notas</p>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          placeholder="Fuera de rango; no está en la lista de JF. REVISAR"
          className="w-full rounded border px-2 py-1 text-sm"
        />
        {error ? <p className="text-xs text-rose-700">{error}</p> : null}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-md bg-foreground px-3 py-1.5 text-sm text-background disabled:opacity-50"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Guardar
          </button>
          <button
            type="button"
            onClick={() => {
              // Back to what is stored, not to what was typed: leaving the
              // discarded draft in the box makes the next "Editar" look like
              // the save silently failed.
              setDraft(notes ?? "");
              setError(null);
              setEditing(false);
            }}
            disabled={saving}
            className="rounded-md border px-3 py-1.5 text-sm hover:bg-muted"
          >
            Cancelar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">Notas</p>
          <p
            className={`mt-0.5 whitespace-pre-wrap text-sm ${
              notes ? "text-stone-700" : "text-muted-foreground"
            }`}
          >
            {notes || "Sin notas."}
          </p>
        </div>
        {canEdit ? (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-1 text-xs hover:bg-muted"
          >
            <Pencil className="h-3 w-3" />
            Editar
          </button>
        ) : null}
      </div>
    </div>
  );
}
