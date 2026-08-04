"use client";

/**
 * One species card on /biochoco/fichas-especies.
 *
 * The text box is ALWAYS mounted and always editable — no modal, no "Editar"
 * round-trip. The card is shaped like the public finca card
 * (`public/biochoco/[token]/species-showcase.tsx`) so the author composes in
 * roughly the shape a landowner reads.
 *
 * Saving is EXPLICIT rather than on-blur — which is where this deliberately
 * diverges from the shared `EditableField` in `@/components/editable-cell`.
 * That component saves numeric/text cells on blur, which is fine for a grants
 * table; `publicContent` publishes live to public finca pages, so a stray blur
 * must not put a half-written paragraph in front of landowners.
 */

import { useState, useTransition, useEffect, useRef } from "react";
import { Check, Loader2, Eye, EyeOff, PawPrint } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FormatSpeciesContent } from "@/lib/landowner/format-species-content";
import { SPECIES_CONTENT_MAX, type SpeciesContentRow } from "./content-types";
import { displayName, typeLabel } from "./list-view";
import { deriveStatus, isDirty, overBy, SAVED_WINDOW_MS } from "./card-state";
import { updateSpeciesContent } from "./actions";

interface Props {
  species: SpeciesContentRow;
  /** Lets the parent pin dirty cards and arm the beforeunload guard. */
  onDirtyChange: (id: number, dirty: boolean) => void;
  /** Optimistic parent update so the badge + header counter stay in sync. */
  onSaved: (id: number, publicContent: string | null) => void;
}

export function SpeciesCard({ species, onDirtyChange, onSaved }: Props) {
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState(species.publicContent ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  // A biochoco editor without camera-trap access gets 403s from the image
  // route; fall back to the placeholder rather than a broken-image icon.
  const [thumbFailed, setThumbFailed] = useState(false);
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Adopt a new server value when one arrives, but never clobber unsaved text.
  // Render-time state adjustment, mirroring `useFieldSave` in
  // `@/components/editable-cell` — React's recommended alternative to an effect.
  const [lastStored, setLastStored] = useState(species.publicContent);
  if (species.publicContent !== lastStored) {
    setLastStored(species.publicContent);
    if (!isDirty(draft, lastStored)) setDraft(species.publicContent ?? "");
  }

  const dirty = isDirty(draft, species.publicContent);
  const over = overBy(draft);
  const status = deriveStatus({
    draft,
    stored: species.publicContent,
    pending,
    error,
    saved,
  });

  useEffect(() => {
    onDirtyChange(species.id, dirty);
  }, [species.id, dirty, onDirtyChange]);

  useEffect(() => {
    // Unmounting (filter change, "Mostrar más" reset) must not leave a timer
    // pointed at a dead setState.
    return () => {
      if (savedTimer.current) clearTimeout(savedTimer.current);
    };
  }, []);

  function handleChange(value: string) {
    setDraft(value);
    // A rejection describes the text that was sent, not the text being typed.
    if (error) setError(null);
  }

  function save() {
    // Guards Cmd+Enter too, not just the button.
    if (!dirty || pending || over > 0) return;
    setError(null);
    startTransition(async () => {
      const result = await updateSpeciesContent(species.id, {
        publicContent: draft,
      });
      if (result.success) {
        const stored = result.data.publicContent;
        setDraft(stored ?? "");
        setSaved(true);
        if (savedTimer.current) clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setSaved(false), SAVED_WINDOW_MS);
        // The action already calls revalidatePath, so the next navigation is
        // fresh; no router.refresh() here — with ~63 cards on screen it would
        // re-run the whole list query after every single save for a UI the
        // optimistic update has already corrected.
        onSaved(species.id, stored);
      } else {
        setError(result.error);
      }
    });
  }

  function discard() {
    setDraft(species.publicContent ?? "");
    setError(null);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      save();
    } else if (e.key === "Escape") {
      e.preventDefault();
      discard();
      textareaRef.current?.blur();
    }
    // Plain Enter inserts a newline — fichas are multi-paragraph prose, so the
    // EditableField "Enter saves" behaviour would be actively wrong here.
  }

  const name = displayName(species);
  const preview = draft.trim();

  return (
    <article className="rounded-lg border bg-card shadow-xs">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-3">
        {species.representativeImageId != null && !thumbFailed ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={`/api/ct-images/${species.representativeImageId}?size=thumb`}
            alt=""
            aria-hidden
            loading="lazy"
            onError={() => setThumbFailed(true)}
            className="h-10 w-10 shrink-0 rounded object-cover"
          />
        ) : (
          <span
            aria-hidden
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-muted text-muted-foreground"
          >
            <PawPrint className="h-4 w-4" />
          </span>
        )}
        <h2 className="font-semibold leading-tight">{name}</h2>
        <span className="font-serif text-xs italic text-muted-foreground">
          {species.scientificName}
        </span>
        <Badge variant="secondary" className="text-xs">
          {typeLabel(species)}
        </Badge>
        <span className="text-xs tabular-nums text-muted-foreground">
          {/* es-EC, not es: Spain's CLDR sets minimumGroupingDigits=2, so
              plain "es" renders 1204 ungrouped. Ecuador groups from 1000. */}
          {species.detectionCount > 0
            ? `${species.detectionCount.toLocaleString("es-EC")} registros`
            : "—"}
        </span>
        <span className="ml-auto">
          {species.hasContent ? (
            <Badge className="bg-emerald-100 text-xs text-emerald-800 hover:bg-emerald-100">
              Con ficha
            </Badge>
          ) : (
            <Badge variant="outline" className="text-xs text-muted-foreground">
              Sin ficha
            </Badge>
          )}
        </span>
      </header>

      <div className="space-y-2 px-4 py-3">
        <Textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          // No maxLength on purpose — it silently truncates a pasted draft.
          // Going over is allowed; `overBy` warns and blocks the save instead.
          aria-invalid={over > 0}
          // `rows` + min-height are the fallback for browsers without CSS
          // `field-sizing: content` (which the shared Textarea relies on to
          // grow); without them the box would collapse to one line there.
          rows={4}
          className="min-h-[6rem] resize-y text-sm"
          aria-label={`Ficha de ${name}`}
          placeholder={
            "Ej: La guatusa dispersa semillas y ayuda a la regeneración del bosque.\n\nPara perros, gatos, gallinas, ganado o cerdos, puede incluir un consejo de manejo:\n- Vacunar y esterilizar"
          }
        />

        {showPreview && preview && (
          <section className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-3 dark:border-emerald-900/50 dark:bg-emerald-950/30">
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-emerald-900 dark:text-emerald-200">
              Así se verá en la página de la finca
            </p>
            <div className="space-y-2 text-sm text-emerald-950/90 dark:text-emerald-100/90">
              <FormatSpeciesContent text={preview} />
            </div>
          </section>
        )}

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
          <button
            type="button"
            onClick={() => setShowPreview((v) => !v)}
            className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
          >
            {showPreview ? (
              <EyeOff className="h-3.5 w-3.5" />
            ) : (
              <Eye className="h-3.5 w-3.5" />
            )}
            Vista previa
          </button>

          {/* Counts the trimmed length — the same value the server enforces —
              so the counter can never disagree with the Guardar button. */}
          <span
            className={`tabular-nums ${
              over > 0
                ? "font-medium text-destructive"
                : draft.trim().length > SPECIES_CONTENT_MAX - 100
                  ? "text-amber-600"
                  : "text-muted-foreground"
            }`}
          >
            {draft.trim().length}/{SPECIES_CONTENT_MAX}
          </span>

          {status === "saving" && (
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Guardando…
            </span>
          )}
          {status === "saved" && (
            <span className="inline-flex items-center gap-1 text-emerald-600">
              <Check className="h-3.5 w-3.5" />
              Guardado
            </span>
          )}

          {(status === "dirty" || status === "error") && (
            <span className="ml-auto flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                onClick={discard}
              >
                Descartar
              </Button>
              <Button
                type="button"
                size="sm"
                className="h-7 text-xs"
                onClick={save}
                disabled={over > 0}
                title={
                  over > 0 ? "Recorta el texto para poder guardar" : undefined
                }
              >
                Guardar
              </Button>
            </span>
          )}
        </div>

        {over > 0 && (
          <p className="text-xs text-destructive" role="alert">
            Te pasaste por {over.toLocaleString("es-EC")}{" "}
            {over === 1 ? "carácter" : "caracteres"}. Recorta el texto para poder
            guardar.
          </p>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
    </article>
  );
}
