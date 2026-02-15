"use client";

import { useEffect, useRef } from "react";

export const SHORTCUTS = [
  { key: "←/→", description: "Imagen anterior/siguiente", category: "navigation" },
  { key: "1-9", description: "Seleccionar detección", category: "navigation" },
  { key: "Esc", description: "Deseleccionar", category: "navigation" },
  { key: "Enter", description: "Verificar todo y avanzar", category: "annotation" },
  { key: "v", description: "Verificar detección", category: "annotation" },
  { key: "r", description: "Rechazar detección", category: "annotation" },
] as const;

interface AnnotationShortcutOptions {
  enabled?: boolean;
  onVerify?: () => void;
  onReject?: () => void;
  onQuickVerifyAll?: () => void;
  onNext?: () => void;
  onPrev?: () => void;
  onSelectDetection?: (index: number) => void;
  onDeselect?: () => void;
  detectionCount?: number;
}

export function useAnnotationShortcuts(opts: AnnotationShortcutOptions) {
  const optsRef = useRef(opts);

  useEffect(() => {
    optsRef.current = opts;
  });

  useEffect(() => {
    if (!opts.enabled) return;

    function handleKeyDown(e: KeyboardEvent) {
      // Skip in editable fields
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement ||
        (e.target as HTMLElement).isContentEditable ||
        (e.target as HTMLElement).getAttribute("role") === "combobox"
      ) {
        return;
      }

      // Escape works everywhere
      if (e.key === "Escape") {
        optsRef.current.onDeselect?.();
        return;
      }

      const hasModifier = e.metaKey || e.ctrlKey || e.altKey;

      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          optsRef.current.onPrev?.();
          break;
        case "ArrowRight":
          e.preventDefault();
          optsRef.current.onNext?.();
          break;
        case "Enter":
          if (!hasModifier) {
            e.preventDefault();
            optsRef.current.onQuickVerifyAll?.();
          }
          break;
        case "v":
          if (!hasModifier) {
            e.preventDefault();
            optsRef.current.onVerify?.();
          }
          break;
        case "r":
          if (!hasModifier) {
            e.preventDefault();
            optsRef.current.onReject?.();
          }
          break;
        default:
          if (!hasModifier && /^[1-9]$/.test(e.key)) {
            const index = parseInt(e.key, 10) - 1;
            if (
              optsRef.current.detectionCount &&
              index < optsRef.current.detectionCount
            ) {
              e.preventDefault();
              optsRef.current.onSelectDetection?.(index);
            }
          }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [opts.enabled]);
}
