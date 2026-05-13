"use client";

import { useEffect, useRef } from "react";

/**
 * Audio-only keyboard shortcuts layered on top of `useAnnotationShortcuts`
 * (chrome). Handles playback (Space, Q/E, `[`/`]`, P, L), spectrogram
 * controls (F, M, +/-), and audio-specific annotation actions (V, R, N).
 *
 * Chrome keys (arrows for prev/next file, Enter verify-all, 1-9 species,
 * 0 last-species, Backspace/Delete, Esc) live in `useAnnotationShortcuts`
 * and must not be duplicated here.
 */
export const AUDIO_PLAYBACK_SHORTCUTS = [
  { key: "Espacio", description: "Reproducir/pausar", category: "playback" },
  { key: "Q/E o [ / ]", description: "Retroceder/avanzar 5s", category: "playback" },
  { key: "p", description: "Reproducir selección", category: "playback" },
  { key: "l", description: "Reproducir selección en bucle", category: "playback" },
  { key: "n", description: "Saltar a la siguiente sin verificar", category: "navigation" },
  { key: "v", description: "Verificar detección", category: "annotation" },
  { key: "r", description: "Rechazar detección", category: "annotation" },
  { key: "f", description: "Cambiar frecuencia máx", category: "navigation" },
  { key: "m", description: "Cambiar mapa de color", category: "navigation" },
  { key: "+/-", description: "Ganancia ±5 dB", category: "navigation" },
] as const;

interface AudioPlaybackShortcutOptions {
  enabled?: boolean;
  onPlayPause?: () => void;
  onSeekBack?: () => void;
  onSeekForward?: () => void;
  onPlaySelection?: () => void;
  onToggleLoop?: () => void;
  onJumpToNextUnverified?: () => void;
  onVerify?: () => void;
  onReject?: () => void;
  onCycleYMax?: () => void;
  onCycleColormap?: () => void;
  onAdjustGain?: (deltaDB: number) => void;
  /** Picker search input — when focused, suppress playback shortcuts so the
   *  user can type into the typeahead unhindered. The chrome hook still
   *  intercepts digits + arrows for species assignment / file nav. */
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
  /** Suppresses shortcuts while a bbox draw gesture is in flight. */
  isDrawing?: boolean;
  /** True when the contextual species picker popover is open. While open,
   *  these audio shortcuts must not fire (the user is interacting with the
   *  picker; Space/v/r etc. would be surprising). */
  isPickerOpen?: boolean;
}

export function useAudioPlaybackShortcuts(opts: AudioPlaybackShortcutOptions) {
  const optsRef = useRef(opts);

  useEffect(() => {
    optsRef.current = opts;
  });

  useEffect(() => {
    if (!opts.enabled) return;

    function handleKeyDown(e: KeyboardEvent) {
      const o = optsRef.current;
      if (o.isDrawing) return;
      if (o.isPickerOpen) return;

      const searchInput = o.searchInputRef?.current;
      const isSearchFocused =
        searchInput != null && document.activeElement === searchInput;
      if (isSearchFocused) return;

      const target = e.target as HTMLElement;
      const isInEditableField =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target.isContentEditable ||
        target.getAttribute("role") === "combobox";
      if (isInEditableField) return;

      const hasModifier = e.metaKey || e.ctrlKey || e.altKey;
      if (hasModifier) return;

      switch (e.key) {
        case " ":
          e.preventDefault();
          o.onPlayPause?.();
          break;
        case "[":
        case "q":
          e.preventDefault();
          o.onSeekBack?.();
          break;
        case "]":
        case "e":
          e.preventDefault();
          o.onSeekForward?.();
          break;
        case "p":
          e.preventDefault();
          o.onPlaySelection?.();
          break;
        case "l":
          e.preventDefault();
          o.onToggleLoop?.();
          break;
        case "n":
          e.preventDefault();
          o.onJumpToNextUnverified?.();
          break;
        case "v":
          e.preventDefault();
          o.onVerify?.();
          break;
        case "r":
          e.preventDefault();
          o.onReject?.();
          break;
        case "f":
          e.preventDefault();
          o.onCycleYMax?.();
          break;
        case "m":
          e.preventDefault();
          o.onCycleColormap?.();
          break;
        case "+":
        case "=":
          e.preventDefault();
          o.onAdjustGain?.(5);
          break;
        case "-":
        case "_":
          e.preventDefault();
          o.onAdjustGain?.(-5);
          break;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [opts.enabled]);
}
