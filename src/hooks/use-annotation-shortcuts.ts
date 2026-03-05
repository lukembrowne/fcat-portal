"use client";

import { useEffect, useRef } from "react";

export const SHORTCUTS = [
  { key: "←/→", description: "Imagen anterior/siguiente", category: "navigation" },
  { key: "1-9", description: "Seleccionar detección / asignar especie", category: "navigation" },
  { key: "0", description: "Asignar especie #10", category: "annotation" },
  { key: "Esc", description: "Deseleccionar / volver a cuadrícula", category: "navigation" },
  { key: "Enter", description: "Verificar todo y avanzar", category: "annotation" },
  { key: "v", description: "Verificar detección", category: "annotation" },
  { key: "r", description: "Rechazar detección", category: "annotation" },
  { key: "d / ⌫ / Supr", description: "Eliminar detección", category: "annotation" },
  { key: "b", description: "Confirmar/desconfirmar imagen vacía", category: "annotation" },
  { key: "s", description: "Destacar/quitar destacado", category: "annotation" },
  { key: "i", description: "Marcar como instalación", category: "annotation" },
  { key: "t", description: "Marcar como recogida (retiro)", category: "annotation" },
  { key: "h", description: "Ocultar/mostrar cajas", category: "annotation" },
  { key: "z", description: "Restablecer zoom", category: "navigation" },
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
  onEscapeBack?: () => void;
  onDeleteSelected?: () => void;
  onToggleConfirmedBlank?: () => void;
  onToggleStarred?: () => void;
  onToggleSetupDeployment?: () => void;
  onToggleSetupRetrieval?: () => void;
  onToggleBboxes?: () => void;
  onResetZoom?: () => void;
  onAssignSpeciesByIndex?: (index: number) => void;
  isDialogOpen?: boolean;
  detectionCount?: number;
  selectedDetectionId?: number | null;
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
  isDrawing?: boolean;
}

export function useAnnotationShortcuts(opts: AnnotationShortcutOptions) {
  const optsRef = useRef(opts);

  useEffect(() => {
    optsRef.current = opts;
  });

  useEffect(() => {
    if (!opts.enabled) return;

    function handleKeyDown(e: KeyboardEvent) {
      const o = optsRef.current;

      // Suppress all shortcuts while drawing a bbox
      if (o.isDrawing) return;

      // Check if the search input is focused
      const searchInput = o.searchInputRef?.current;
      const isSearchFocused = searchInput && document.activeElement === searchInput;

      // Escape: three-level behavior
      if (e.key === "Escape") {
        if (isSearchFocused && searchInput.value) {
          searchInput.value = "";
          searchInput.dispatchEvent(new Event("input", { bubbles: true }));
          return;
        }
        if (o.selectedDetectionId != null) {
          o.onDeselect?.();
          return;
        }
        // Nothing selected — navigate back to grid
        o.onEscapeBack?.();
        return;
      }

      // Skip most shortcuts in editable fields (except search input for number keys)
      const target = e.target as HTMLElement;
      const isInEditableField =
        (target instanceof HTMLInputElement && target !== searchInput) ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        target.isContentEditable ||
        target.getAttribute("role") === "combobox";

      if (isInEditableField) return;

      // If search input is focused, only allow number keys (for species assignment)
      // and navigation keys
      if (isSearchFocused) {
        const hasModifier = e.metaKey || e.ctrlKey || e.altKey;
        if (!hasModifier && o.selectedDetectionId != null && /^[0-9]$/.test(e.key)) {
          e.preventDefault();
          const index = e.key === "0" ? 9 : parseInt(e.key, 10) - 1;
          o.onAssignSpeciesByIndex?.(index);
          return;
        }
        // Let other keys pass through to the input
        return;
      }

      const hasModifier = e.metaKey || e.ctrlKey || e.altKey;

      switch (e.key) {
        case "ArrowLeft":
          e.preventDefault();
          o.onPrev?.();
          break;
        case "ArrowRight":
          e.preventDefault();
          o.onNext?.();
          break;
        case "Enter":
          if (!hasModifier && !o.isDialogOpen) {
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
        case "b":
          if (!hasModifier && !o.isDialogOpen) {
            e.preventDefault();
            o.onToggleConfirmedBlank?.();
          }
          break;
        case "s":
          if (!hasModifier && !o.isDialogOpen) {
            e.preventDefault();
            o.onToggleStarred?.();
          }
          break;
        case "i":
          if (!hasModifier && !o.isDialogOpen) {
            e.preventDefault();
            o.onToggleSetupDeployment?.();
          }
          break;
        case "t":
          if (!hasModifier && !o.isDialogOpen) {
            e.preventDefault();
            o.onToggleSetupRetrieval?.();
          }
          break;
        case "h":
          if (!hasModifier && !o.isDialogOpen) {
            e.preventDefault();
            o.onToggleBboxes?.();
          }
          break;
        case "z":
          if (!hasModifier && !o.isDialogOpen) {
            e.preventDefault();
            o.onResetZoom?.();
          }
          break;
        case "d":
        case "Delete":
        case "Backspace":
          if (!hasModifier && !o.isDialogOpen) {
            e.preventDefault();
            o.onDeleteSelected?.();
          }
          break;
        default:
          if (!hasModifier && /^[0-9]$/.test(e.key)) {
            if (o.selectedDetectionId != null) {
              // Detection selected → assign species by index
              e.preventDefault();
              const index = e.key === "0" ? 9 : parseInt(e.key, 10) - 1;
              o.onAssignSpeciesByIndex?.(index);
            } else if (/^[1-9]$/.test(e.key)) {
              // No detection selected → select detection by number
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
