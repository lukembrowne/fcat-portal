"use client";

import { AnalyzeAudioDialog } from "./analyze-audio-dialog";

interface BatchAnalyzeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedIds: number[];
  selectedCount: number;
  onComplete: () => void;
}

/**
 * Batch entry point for the selection toolbar. Delegates to the shared
 * `AnalyzeAudioDialog`, which detects batch mode from `deploymentIds.length`.
 * Kept as a thin wrapper for backwards compatibility with existing callers.
 */
export function BatchAnalyzeDialog({
  open,
  onOpenChange,
  selectedIds,
  onComplete,
}: BatchAnalyzeDialogProps) {
  return (
    <AnalyzeAudioDialog
      open={open}
      onOpenChange={onOpenChange}
      deploymentIds={selectedIds}
      onComplete={onComplete}
    />
  );
}
