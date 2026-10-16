"use client";

import { useEffect, useRef } from "react";

import { MAX_REVIEW_NOTE_LENGTH } from "@/lib/birdnet-validation/review-notes";

export type NoteStatus =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

/**
 * The reviewer's free-text note on the current clip — call type, a second
 * species in the background, anything peculiar.
 *
 * Controlled by the review client, which owns the drafts (so a note typed on a
 * clip and left with → is still there on ←) and decides when to save: on blur
 * once the clip is answered, or right after the answer when typed before it.
 * This component only reports edits and blur.
 *
 * Typing here never answers the clip: `isEditableTarget` already suppresses
 * the page shortcuts inside a textarea. Esc and Ctrl/⌘+Enter both blur, which
 * hands the keyboard back to the shortcuts (and saves an answered clip's note).
 */
export function ClipNote({
  value,
  onChange,
  onBlur,
  answered,
  dirty,
  status,
  focusSignal,
}: {
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  /** Whether the clip has an answer yet — notes are saved onto the answer. */
  answered: boolean;
  /** Whether the text differs from what the server holds. */
  dirty: boolean;
  status: NoteStatus;
  /** Bumped by the T shortcut; a change (not the initial value) focuses the field. */
  focusSignal: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Focus on a CHANGE of the signal, never on mount: the field remounts per
  // clip, and focusing on arrival would swallow the answer keys on every clip.
  const seenSignal = useRef(focusSignal);

  useEffect(() => {
    if (focusSignal === seenSignal.current) return;
    seenSignal.current = focusSignal;
    ref.current?.focus();
  }, [focusSignal]);

  const hint =
    status.kind === "error"
      ? status.message
      : status.kind === "saving"
        ? "Guardando…"
        : dirty && !answered && value.trim()
          ? "Se guardará al responder"
          : status.kind === "saved" && !dirty
            ? "Nota guardada"
            : "";

  return (
    <div className="space-y-1">
      <label className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
        <span>
          Nota sobre este clip{" "}
          <span className="opacity-70">(opcional · T para escribir, Esc para salir)</span>
        </span>
        {/* Fixed-height slot so the status appearing never shifts the page. */}
        <span
          className={`min-h-[1rem] text-[11px] ${
            status.kind === "error" ? "text-rose-700" : ""
          }`}
          aria-live="polite"
        >
          {hint}
        </span>
      </label>
      <textarea
        ref={ref}
        value={value}
        maxLength={MAX_REVIEW_NOTE_LENGTH}
        rows={2}
        placeholder="Tipo de llamada, otra especie de fondo, algo peculiar…"
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        onKeyDown={(e) => {
          if (e.key === "Escape" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
            e.preventDefault();
            e.currentTarget.blur();
          }
        }}
        className="w-full resize-y rounded-md border bg-background px-2 py-1.5 text-sm placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-foreground/40"
      />
    </div>
  );
}
