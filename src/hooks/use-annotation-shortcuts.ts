"use client";

import { useEffect, useRef } from "react";

export const SHORTCUTS = [
  { key: "←/→", description: "Imagen anterior/siguiente", category: "navigation" },
  { key: "1-9", description: "Seleccionar detección / asignar especie frecuente", category: "navigation" },
  { key: "0", description: "Última especie: en la caja, o todas (sin selección)", category: "annotation" },
  { key: "Esc", description: "Cerrar selector / deseleccionar", category: "navigation" },
  { key: "v", description: "Verificar todo y avanzar", category: "annotation" },
  { key: "d / ⌫ / Supr", description: "Eliminar detección", category: "annotation" },
  { key: "b", description: "Confirmar/desconfirmar imagen vacía", category: "annotation" },
  { key: "s", description: "Destacar/quitar destacado", category: "annotation" },
  { key: "i", description: "Marcar como instalación", category: "annotation" },
  { key: "t", description: "Marcar como recogida (retiro)", category: "annotation" },
  { key: "h", description: "Ocultar/mostrar cajas", category: "annotation" },
  { key: "z", description: "Restablecer zoom", category: "navigation" },
  { key: "\\", description: "Reducir brillo (100% → 70% → 50%)", category: "navigation" },
] as const;

interface AnnotationShortcutOptions {
  enabled?: boolean;
  onQuickVerifyAll?: () => void;
  onNext?: () => void;
  onPrev?: () => void;
  onSelectDetection?: (index: number) => void;
  onDeselect?: () => void;
  onDeleteSelected?: () => void;
  onToggleConfirmedBlank?: () => void;
  onToggleStarred?: () => void;
  onToggleSetupDeployment?: () => void;
  onToggleSetupRetrieval?: () => void;
  onToggleBboxes?: () => void;
  onResetZoom?: () => void;
  onCycleBrightness?: () => void;
  onAssignSpeciesByIndex?: (index: number) => void;
  onAssignLastSpecies?: () => void;
  /** No detection selected + "0" pressed: assign the last species to all
   *  (animal) boxes in the image and verify them. The animal-only filtering
   *  lives in the handler, not here. */
  onAssignLastSpeciesToAll?: () => void;
  isDialogOpen?: boolean;
  /** True when the contextual species picker popover is open. While open,
   *  Radix owns Esc — the global handler must early-return so it does not
   *  also fire onDeselect on the same keystroke (and onEscapeBack on the
   *  next, which used to navigate back to the gallery). */
  isPickerOpen?: boolean;
  detectionCount?: number;
  selectedDetectionId?: number | null;
  /**
   * When the popover's typeahead is focused, the popover owns digit keys
   * (frequent-species hotkeys) via its own onKeyDown. We still need this ref
   * to skip the global "in editable field" guard so left/right image
   * navigation keeps working.
   */
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
  isDrawing?: boolean;
}

/**
 * Intent produced by resolving a digit key (0-9) against the current
 * selection state. Extracted as a pure function so the branch logic is
 * unit-testable without a DOM (the Vitest environment is `node`).
 */
export type DigitKeyAction =
  | { type: "assignLast" }
  | { type: "assignByIndex"; index: number }
  | { type: "assignLastToAll" }
  | { type: "selectDetection"; index: number }
  | { type: "none" };

/**
 * Pure resolver for digit-key behavior:
 *
 *   Detection selected:  0 → repeat last species on that box
 *                        1-9 → assign frecuente slot
 *   No detection:        0 → assign last species to ALL boxes (handler filters
 *                            to animals)
 *                        1-9 → select detection by number (when in range)
 */
export function resolveDigitKeyAction(
  key: string,
  ctx: {
    selectedDetectionId: number | null | undefined;
    detectionCount: number | undefined;
  }
): DigitKeyAction {
  if (!/^[0-9]$/.test(key)) return { type: "none" };

  if (ctx.selectedDetectionId != null) {
    if (key === "0") return { type: "assignLast" };
    return { type: "assignByIndex", index: parseInt(key, 10) - 1 };
  }

  // No detection selected.
  if (key === "0") return { type: "assignLastToAll" };
  const index = parseInt(key, 10) - 1;
  if (ctx.detectionCount && index < ctx.detectionCount) {
    return { type: "selectDetection", index };
  }
  return { type: "none" };
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

      // Check if the popover's typeahead is focused. When it is, we still
      // want number-key species assignment and left/right image navigation
      // to work — but everything else (text editing, Esc, Enter, Delete) is
      // owned by the typeahead / popover and flows through naturally.
      const searchInput = o.searchInputRef?.current;
      const isSearchFocused = searchInput && document.activeElement === searchInput;

      // Escape: when the picker is open, Radix owns it — early-return so the
      // global handler does not also fire on the same keystroke. When closed,
      // Esc only deselects an outstanding selection. Never navigates away.
      if (e.key === "Escape") {
        if (o.isPickerOpen) return;
        if (o.selectedDetectionId != null) {
          o.onDeselect?.();
        }
        return;
      }

      // Skip most shortcuts in editable fields (except the popover search).
      // The search input is a cmdk combobox, so it also matches the
      // role="combobox" check below — exempt it explicitly so the
      // isSearchFocused branch can run.
      const target = e.target as HTMLElement;
      const isInEditableField =
        target !== searchInput &&
        ((target instanceof HTMLInputElement) ||
          target instanceof HTMLTextAreaElement ||
          target instanceof HTMLSelectElement ||
          target.isContentEditable ||
          target.getAttribute("role") === "combobox");

      if (isInEditableField) return;

      if (isSearchFocused) {
        // Digits are handled by the popover's own onKeyDown. Only image
        // navigation passes through here while the typeahead is focused.
        const hasModifier = e.metaKey || e.ctrlKey || e.altKey;
        if (!hasModifier && e.key === "ArrowLeft") {
          e.preventDefault();
          o.onPrev?.();
          return;
        }
        if (!hasModifier && e.key === "ArrowRight") {
          e.preventDefault();
          o.onNext?.();
          return;
        }
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
        case "v":
          if (!hasModifier && !o.isDialogOpen) {
            e.preventDefault();
            o.onQuickVerifyAll?.();
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
        case "\\":
          if (!hasModifier && !o.isDialogOpen) {
            e.preventDefault();
            o.onCycleBrightness?.();
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
            const action = resolveDigitKeyAction(e.key, {
              selectedDetectionId: o.selectedDetectionId,
              detectionCount: o.detectionCount,
            });
            switch (action.type) {
              case "assignLast":
                e.preventDefault();
                o.onAssignLastSpecies?.();
                break;
              case "assignByIndex":
                e.preventDefault();
                o.onAssignSpeciesByIndex?.(action.index);
                break;
              case "assignLastToAll":
                // No detection selected + "0": assign last species to all
                // (animal) boxes and verify.
                e.preventDefault();
                o.onAssignLastSpeciesToAll?.();
                break;
              case "selectDetection":
                e.preventDefault();
                o.onSelectDetection?.(action.index);
                break;
              case "none":
                break;
            }
          }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [opts.enabled]);
}
