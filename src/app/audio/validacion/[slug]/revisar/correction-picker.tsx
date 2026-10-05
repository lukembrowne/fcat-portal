"use client";

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Loader2, Search, X } from "lucide-react";

import type { NameLang } from "@/app/audio/validacion/name-language";
import {
  correctionLabel,
  listPlacement,
  moveActive,
  resolvePickerKey,
  searchCorrections,
  type CorrectionEntry,
} from "./correction-search";
import type { CorrectionCommit } from "./review-flow";

interface CorrectionPickerProps {
  /** Null while the vocabulary is still loading. */
  index: CorrectionEntry[] | null;
  loadError: string | null;
  onRetryLoad: () => void;
  lang: NameLang;
  /** The species this reviewer already named for this clip, from client state. */
  chosen: string | null;
  /** Bumped by the page when "No" was JUST pressed on this clip: take focus. */
  focusSignal: number;
  /** Save (or clear, with null). A non-null success advances the page. */
  onCommit: (species: string | null) => Promise<CorrectionCommit>;
  /** "cambiar respuesta": bring the three answer buttons back. Sends nothing. */
  onChangeAnswer: () => void;
  onSkip: () => void;
  onBack: () => void;
}

/**
 * "¿Qué especie era?" — shown IN PLACE of the answer buttons on a clip answered
 * "No", under a compact "✕ Incorrecta · cambiar respuesta" line. It used to
 * appear below the buttons, which on a laptop is below the fold; it is sized
 * to take roughly the buttons' own height, and its suggestion list is an
 * overlay so typing never moves the navigation row underneath.
 *
 * A plain input + listbox rather than the cmdk combobox: the list is ~6.5k
 * BirdNET labels searched three ways, and — the constraint that decides it —
 * focus must never leave the input. The page's one-letter shortcuts are only
 * suppressed on editable targets, so a focused list item would let "s" answer
 * the NEXT clip. Rows are chosen by pointer (mousedown keeps focus) or by
 * ↑/↓ + Enter, tracked with `aria-activedescendant`.
 */
export function CorrectionPicker({
  index,
  loadError,
  onRetryLoad,
  lang,
  chosen,
  focusSignal,
  onCommit,
  onChangeAnswer,
  onSkip,
  onBack,
}: CorrectionPickerProps) {
  const inputId = useId();
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const [editing, setEditing] = useState(chosen === null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [focused, setFocused] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const results = useMemo(
    () => (index ? searchCorrections(index, query) : []),
    [index, query]
  );
  const chosenEntry = useMemo(
    () =>
      chosen && index ? (index.find((e) => e.scientificName === chosen) ?? null) : null,
    [chosen, index]
  );

  useEffect(() => {
    const input = inputRef.current;
    if (!(focusSignal > 0 && editing && input)) return;
    input.focus({ preventScroll: true });
    // Safety net: the slot sits where the buttons were, so this should not
    // fire — but a short window or a tall spectrogram can still push it out.
    const rect = input.getBoundingClientRect();
    // On a phone the buttons themselves sat below the fold. Scroll the whole
    // panel, not just the input, so the hint under it comes along.
    if (rect.top < 0 || rect.bottom > window.innerHeight) {
      (rootRef.current ?? input).scrollIntoView({ block: "nearest" });
    }
  }, [focusSignal, editing]);

  // Keep the highlighted row visible while arrowing through a long list.
  useEffect(() => {
    if (active < 0) return;
    const row = listRef.current?.children[active] as HTMLElement | undefined;
    row?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const choose = async (entry: CorrectionEntry | null) => {
    setSaving(true);
    setError(null);
    const result = await onCommit(entry?.scientificName ?? null);
    // On success with a species the page advances and this unmounts.
    setSaving(false);
    if (!result.ok) {
      // Keep the typed text so the reviewer can retry without retyping.
      setError(result.error);
      inputRef.current?.focus();
      return;
    }
    if (entry === null) {
      setEditing(true);
      setQuery("");
    }
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (saving) {
      if (event.key === "Enter") event.preventDefault();
      return;
    }
    const intent = resolvePickerKey(event.key, {
      query,
      activeIndex: active,
      resultCount: results.length,
    });
    if (!intent) return;
    event.preventDefault();
    switch (intent.kind) {
      case "move":
        setActive((a) => moveActive(a, intent.delta, results.length));
        break;
      case "choose":
        void choose(results[intent.index]);
        break;
      case "skip":
        onSkip();
        break;
      case "back":
        onBack();
        break;
      case "clear":
        setQuery("");
        setActive(-1);
        break;
      case "release":
        inputRef.current?.blur();
        break;
    }
  };

  // Closed on an empty box until the reviewer types or arrows down: the
  // suggestions would otherwise cover the skip hint and the page's own
  // navigation row on every "No", and most "No"s are skipped.
  const open = focused && editing && (query.trim() !== "" || active >= 0);

  // Open downward when ~6 rows fit, else flip upward; either way cap to the
  // room there is. Written straight to the element — a measurement, not state.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const list = listRef.current;
      const input = inputRef.current;
      if (!list || !input) return;
      const { side, maxHeight } = listPlacement(
        input.getBoundingClientRect(),
        window.innerHeight
      );
      list.style.maxHeight = `${maxHeight}px`;
      list.style.top = side === "below" ? "calc(100% + 4px)" : "auto";
      list.style.bottom = side === "above" ? "calc(100% + 4px)" : "auto";
      list.dataset.side = side;
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="space-y-1.5 rounded-md border border-rose-200 bg-rose-50/40 px-3 py-2 dark:border-rose-900 dark:bg-rose-950/20"
    >
      {/* The answer, collapsed to one line where the buttons were. */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
        <span className="inline-flex items-center gap-1.5">
          <X
            className="h-3.5 w-3.5 text-rose-700 dark:text-rose-400"
            aria-hidden="true"
          />
          <span className="font-medium">Incorrecta</span>
          <span aria-hidden="true" className="text-muted-foreground">
            ·
          </span>
          <button
            type="button"
            onClick={onChangeAnswer}
            className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            cambiar respuesta
          </button>
        </span>
        <button
          type="button"
          onClick={onSkip}
          className="text-muted-foreground hover:text-foreground hover:underline"
        >
          Seguir sin indicarla
        </button>
      </div>

      {/* Above the input, not below: the open list would cover it, and a
          failed save leaves the list open with the typed text. */}
      {error ? (
        <p
          role="alert"
          className="rounded border border-rose-300 bg-rose-50 p-2 text-xs text-rose-900"
        >
          {error}
        </p>
      ) : null}

      {!editing && chosen ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>
            Era{" "}
            <strong>{chosenEntry ? correctionLabel(chosenEntry, lang) : chosen}</strong>{" "}
            <span className="italic text-muted-foreground">{chosen}</span>
          </span>
          <button
            type="button"
            onClick={() => {
              setEditing(true);
              // Rendered on the next commit; focus once it exists.
              window.setTimeout(() => inputRef.current?.focus(), 0);
            }}
            className="rounded-md border bg-background px-2 py-0.5 text-xs hover:bg-muted"
          >
            Cambiar
          </button>
          <button
            type="button"
            onClick={() => void choose(null)}
            disabled={saving}
            className="inline-flex items-center gap-1 rounded-md border bg-background px-2 py-0.5 text-xs hover:bg-muted disabled:opacity-50"
          >
            <X className="h-3 w-3" /> Quitar
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <label htmlFor={inputId} className="shrink-0 text-sm font-medium">
            ¿Qué especie era?{" "}
            <span className="font-normal text-muted-foreground">(opcional)</span>
          </label>
          <div className="relative min-w-[12rem] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={inputRef}
              id={inputId}
              type="text"
              role="combobox"
              aria-expanded={open}
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
              autoComplete="off"
              spellCheck={false}
              enterKeyHint="next"
              // Short enough to fit a 390 px phone. The full hint stays as the
              // title, which is also the input's accessible description (its
              // accessible name is the "¿Qué especie era?" label).
              placeholder="Buscar especie…"
              title="Nombre científico, español o inglés"
              value={query}
              readOnly={saving}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(e.target.value.trim() ? 0 : -1);
                setError(null);
              }}
              onKeyDown={onKeyDown}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              className="h-9 w-full rounded-md border border-input bg-background pl-8 pr-8 text-base outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm"
            />
            {saving ? (
              <Loader2 className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
            ) : null}

            {open ? (
              <ul
                ref={listRef}
                id={listId}
                role="listbox"
                // Placement (side + max height) is set by the layout effect.
                className="absolute top-[calc(100%+4px)] z-30 max-h-72 w-full overflow-auto rounded-md border bg-popover py-1 text-sm shadow-md"
              >
                {index === null ? (
                  <li className="flex items-center gap-2 px-3 py-2 text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Cargando especies…
                  </li>
                ) : results.length === 0 ? (
                  <li className="px-3 py-2 text-muted-foreground">
                    Ninguna especie de BirdNET coincide
                  </li>
                ) : (
                  results.map((entry, i) => (
                    <li
                      key={entry.scientificName}
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={i === active}
                      // mousedown, not click: the input must keep focus, or the
                      // page shortcuts wake up mid-choice.
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => void choose(entry)}
                      onMouseMove={() => setActive(i)}
                      className={`flex cursor-pointer flex-wrap items-baseline gap-x-2 px-3 py-1.5 ${
                        i === active ? "bg-muted" : ""
                      }`}
                    >
                      <span className="font-medium">{correctionLabel(entry, lang)}</span>
                      <span className="text-xs italic text-muted-foreground">
                        {entry.scientificName}
                      </span>
                      {entry.detected ? (
                        <span className="ml-auto text-[10px] text-muted-foreground">
                          detectada en tus proyectos
                        </span>
                      ) : null}
                    </li>
                  ))
                )}
              </ul>
            ) : null}
          </div>
        </div>
      )}

      {editing ? (
        // Keyboard-only advice: hidden on a phone, where it wrapped to three
        // lines about keys the device does not have.
        <p className="hidden text-[11px] leading-tight text-muted-foreground sm:block">
          ↑ ↓ para elegir · Enter guarda · con el cuadro vacío, Enter o → sigue sin
          indicarla · Esc suelta el teclado
        </p>
      ) : null}

      {loadError ? (
        <p className="text-xs text-rose-800">
          {loadError}{" "}
          <button type="button" onClick={onRetryLoad} className="underline">
            Reintentar
          </button>
        </p>
      ) : null}
    </div>
  );
}
