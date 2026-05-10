"use client";

import { useEffect, useRef } from "react";

export const AUDIO_SHORTCUTS = [
  { key: "Espacio", description: "Reproducir/pausar", category: "playback" },
  { key: "←/→", description: "Retroceder/avanzar 5s", category: "playback" },
  { key: "Q/E o [ / ]", description: "Retroceder/avanzar 5s (alternativo)", category: "playback" },
  { key: "p", description: "Reproducir selección", category: "playback" },
  { key: "l", description: "Reproducir selección en bucle", category: "playback" },
  { key: "Shift + ←/→", description: "Archivo anterior/siguiente", category: "navigation" },
  { key: "n", description: "Saltar a la siguiente sin verificar", category: "navigation" },
  { key: "1-9", description: "Seleccionar detección / asignar especie", category: "navigation" },
  { key: "0", description: "Asignar especie #10", category: "annotation" },
  { key: "Esc", description: "Deseleccionar / limpiar búsqueda", category: "navigation" },
  { key: "Enter", description: "Verificar todo y avanzar", category: "annotation" },
  { key: "v", description: "Verificar detección", category: "annotation" },
  { key: "r", description: "Rechazar detección", category: "annotation" },
  { key: "d / ⌫ / Supr", description: "Eliminar detección", category: "annotation" },
  { key: "f", description: "Cambiar frecuencia máx", category: "navigation" },
  { key: "m", description: "Cambiar mapa de color", category: "navigation" },
  { key: "+/-", description: "Ganancia ±5 dB", category: "navigation" },
] as const;

interface AudioAnnotationShortcutOptions {
  enabled?: boolean;
  onPlayPause?: () => void;
  onSeekBack?: () => void;
  onSeekForward?: () => void;
  onPlaySelection?: () => void;
  onVerify?: () => void;
  onReject?: () => void;
  onQuickVerifyAll?: () => void;
  onNext?: () => void;
  onPrev?: () => void;
  onSelectDetection?: (index: number) => void;
  onDeselect?: () => void;
  onDeleteSelected?: () => void;
  onAssignSpeciesByIndex?: (index: number) => void;
  onCycleYMax?: () => void;
  onCycleColormap?: () => void;
  onAdjustGain?: (deltaDB: number) => void;
  onToggleLoop?: () => void;
  onJumpToNextUnverified?: () => void;
  detectionCount?: number;
  selectedDetectionId?: number | null;
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
  isDrawing?: boolean;
}

export function useAudioAnnotationShortcuts(opts: AudioAnnotationShortcutOptions) {
  const optsRef = useRef(opts);

  useEffect(() => {
    optsRef.current = opts;
  });

  useEffect(() => {
    if (!opts.enabled) return;

    function handleKeyDown(e: KeyboardEvent) {
      const o = optsRef.current;

      if (o.isDrawing) return;

      const searchInput = o.searchInputRef?.current;
      const isSearchFocused = searchInput && document.activeElement === searchInput;

      // Escape: clear search or deselect
      if (e.key === "Escape") {
        if (isSearchFocused && searchInput.value) {
          searchInput.value = "";
          searchInput.dispatchEvent(new Event("input", { bubbles: true }));
          return;
        }
        o.onDeselect?.();
        return;
      }

      const target = e.target as HTMLElement;
      const isInEditableField =
        (target instanceof HTMLInputElement && target !== searchInput) ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target.isContentEditable ||
        target.getAttribute("role") === "combobox";

      if (isInEditableField) return;

      // If search input is focused, only allow number keys for species assignment
      if (isSearchFocused) {
        const hasModifier = e.metaKey || e.ctrlKey || e.altKey;
        if (!hasModifier && o.selectedDetectionId != null && /^[0-9]$/.test(e.key)) {
          e.preventDefault();
          const index = e.key === "0" ? 9 : parseInt(e.key, 10) - 1;
          o.onAssignSpeciesByIndex?.(index);
          return;
        }
        return;
      }

      const hasModifier = e.metaKey || e.ctrlKey || e.altKey;

      switch (e.key) {
        // Playback
        case " ":
          e.preventDefault();
          o.onPlayPause?.();
          break;
        case "[":
        case "q":
          if (!hasModifier) {
            e.preventDefault();
            o.onSeekBack?.();
          }
          break;
        case "]":
        case "e":
          if (!hasModifier) {
            e.preventDefault();
            o.onSeekForward?.();
          }
          break;
        case "p":
          if (!hasModifier) {
            e.preventDefault();
            o.onPlaySelection?.();
          }
          break;

        // Navigation: plain arrow → seek; shift+arrow → file nav
        case "ArrowLeft":
          e.preventDefault();
          if (e.shiftKey) o.onPrev?.();
          else o.onSeekBack?.();
          break;
        case "ArrowRight":
          e.preventDefault();
          if (e.shiftKey) o.onNext?.();
          else o.onSeekForward?.();
          break;

        // Annotation
        case "Enter":
          if (!hasModifier) {
            e.preventDefault();
            o.onQuickVerifyAll?.();
          }
          break;
        case "v":
          if (!hasModifier) {
            e.preventDefault();
            o.onVerify?.();
          }
          break;
        case "r":
          if (!hasModifier) {
            e.preventDefault();
            o.onReject?.();
          }
          break;
        case "d":
        case "Delete":
        case "Backspace":
          if (!hasModifier) {
            e.preventDefault();
            o.onDeleteSelected?.();
          }
          break;
        case "l":
          if (!hasModifier) {
            e.preventDefault();
            o.onToggleLoop?.();
          }
          break;
        case "n":
          if (!hasModifier) {
            e.preventDefault();
            o.onJumpToNextUnverified?.();
          }
          break;
        case "f":
          if (!hasModifier) {
            e.preventDefault();
            o.onCycleYMax?.();
          }
          break;
        case "m":
          if (!hasModifier) {
            e.preventDefault();
            o.onCycleColormap?.();
          }
          break;
        case "+":
        case "=":
          if (!hasModifier) {
            e.preventDefault();
            o.onAdjustGain?.(5);
          }
          break;
        case "-":
        case "_":
          if (!hasModifier) {
            e.preventDefault();
            o.onAdjustGain?.(-5);
          }
          break;

        default:
          if (!hasModifier && /^[0-9]$/.test(e.key)) {
            if (o.selectedDetectionId != null) {
              e.preventDefault();
              const index = e.key === "0" ? 9 : parseInt(e.key, 10) - 1;
              o.onAssignSpeciesByIndex?.(index);
            } else if (/^[1-9]$/.test(e.key)) {
              const index = parseInt(e.key, 10) - 1;
              if (o.detectionCount && index < o.detectionCount) {
                e.preventDefault();
                o.onSelectDetection?.(index);
              }
            }
          }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [opts.enabled]);
}
