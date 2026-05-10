"use client";

import { useMemo } from "react";
import type { AnnotationDetection } from "@/types/annotation";

interface UseAnnotationPickerArgs {
  selectedBoxId: number | null;
  detections: AnnotationDetection[];
  isPanning: boolean;
  isZooming: boolean;
  bboxesHidden: boolean;
  isDialogOpen: boolean;
}

/**
 * Derives the picker popover's open gate and the state it needs to render,
 * out of the annotation page's broader state. The open gate closes the
 * popover during active zoom/pan gestures because CSS transforms don't fire
 * ResizeObserver, so Floating UI can't reposition the popover live. It
 * reopens automatically when the gesture settles because `selectedBoxId`
 * is unchanged.
 */
export function useAnnotationPicker({
  selectedBoxId,
  detections,
  isPanning,
  isZooming,
  bboxesHidden,
  isDialogOpen,
}: UseAnnotationPickerArgs) {
  const selectedDetection = useMemo(
    () => detections.find((d) => d.id === selectedBoxId) ?? null,
    [detections, selectedBoxId]
  );

  const currentSpecies = useMemo(() => {
    const ident = selectedDetection?.identification;
    if (!ident) return null;
    return ident.correctedSpecies || ident.species;
  }, [selectedDetection]);

  const open =
    selectedBoxId !== null &&
    !bboxesHidden &&
    !isPanning &&
    !isZooming &&
    !isDialogOpen;

  return { open, selectedDetection, currentSpecies };
}
