"use client";

import { useCallback, useMemo, useRef } from "react";
import type { Dispatch, MouseEvent, SetStateAction } from "react";
import type { Row, RowSelectionState } from "@tanstack/react-table";

/**
 * Pure helper: given an existing selection map, an anchor id, a current id,
 * the ordered list of visible ids, and whether to add or remove — return
 * the new selection map. Returns `null` to mean "no anchored range applies,
 * fall back to toggling just `currentId`."
 *
 * Extracted so we can unit-test the selection algebra without a React tree.
 */
export function computeRangeSelection(
  prev: RowSelectionState,
  anchorId: number | null,
  currentId: number,
  orderedIds: number[],
  checked: boolean
): RowSelectionState | null {
  if (anchorId === null || anchorId === currentId) return null;
  const fromIdx = orderedIds.indexOf(anchorId);
  const toIdx = orderedIds.indexOf(currentId);
  if (fromIdx === -1 || toIdx === -1) return null;
  const [start, end] = fromIdx < toIdx ? [fromIdx, toIdx] : [toIdx, fromIdx];
  const rangeIds = orderedIds.slice(start, end + 1);
  const next = { ...prev };
  for (const id of rangeIds) {
    if (checked) next[String(id)] = true;
    else delete next[String(id)];
  }
  return next;
}

/**
 * Shift+click row range selection over an ordered list of row IDs.
 *
 * Pairs with `@tanstack/react-table`'s `rowSelection` state. The page owns the
 * state; this hook contributes a Radix-compatible click handler pair plus an
 * imperative setter for the currently-visible row order. Refs keep the cell
 * renderer's `useMemo` stable across selection changes.
 */
export interface UseRowRangeSelectionApi<TData extends { id: number }> {
  /** Spread onto each row checkbox's `onClick`. Captures `shiftKey` so the
   *  subsequent `onCheckedChange` knows whether to expand to a range. */
  onCheckboxClick: (e: MouseEvent) => void;
  /** Spread onto each row checkbox's `onCheckedChange`. When the prior click
   *  captured Shift and there is a previously-selected anchor, toggles every
   *  row between the anchor and the current row inclusive; otherwise toggles
   *  just the current row. */
  handleCheckedChange: (row: Row<TData>, checked: boolean) => void;
  /** Call whenever the visible/filtered row order changes (e.g. inside a
   *  `useMemo` that produces the flat ordered list of IDs across groups). */
  setVisibleOrderedIds: (ids: number[]) => void;
}

export function useRowRangeSelection<TData extends { id: number }>(
  setRowSelection: Dispatch<SetStateAction<RowSelectionState>>
): UseRowRangeSelectionApi<TData> {
  const lastSelectedIdRef = useRef<number | null>(null);
  const shiftClickRef = useRef(false);
  const visibleOrderedIdsRef = useRef<number[]>([]);

  const onCheckboxClick = useCallback((e: MouseEvent) => {
    e.stopPropagation();
    // Radix Checkbox fires onClick before onCheckedChange, so stash the
    // modifier key for the change handler.
    shiftClickRef.current = e.shiftKey;
  }, []);

  const handleCheckedChange = useCallback(
    (row: Row<TData>, checked: boolean) => {
      const rowId = row.original.id;
      if (shiftClickRef.current) {
        let applied = false;
        setRowSelection((prev) => {
          const next = computeRangeSelection(
            prev,
            lastSelectedIdRef.current,
            rowId,
            visibleOrderedIdsRef.current,
            checked
          );
          if (next) {
            applied = true;
            return next;
          }
          return prev;
        });
        if (!applied) row.toggleSelected(checked);
      } else {
        row.toggleSelected(checked);
      }
      lastSelectedIdRef.current = rowId;
      shiftClickRef.current = false;
    },
    [setRowSelection]
  );

  const setVisibleOrderedIds = useCallback((ids: number[]) => {
    visibleOrderedIdsRef.current = ids;
  }, []);

  return useMemo(
    () => ({ onCheckboxClick, handleCheckedChange, setVisibleOrderedIds }),
    [onCheckboxClick, handleCheckedChange, setVisibleOrderedIds]
  );
}
