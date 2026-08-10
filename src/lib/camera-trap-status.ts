/**
 * Pure gates for the "sin datos" (no_data) deployment status. Shared by the
 * actions menu and the detail page so their conditions can't drift, and
 * unit-testable without the "use server" actions module.
 */

/** A deployment can be marked "sin datos" only while it's still pre-processing
 * with zero media. The server action re-validates against live row counts. */
export function canMarkNoData(
  status: string,
  totalImages: number,
  totalVideos: number,
  isProcessing: boolean
): boolean {
  return (
    (status === "unscanned" || status === "scanned") &&
    totalImages === 0 &&
    totalVideos === 0 &&
    !isProcessing
  );
}

export function canUndoNoData(status: string): boolean {
  return status === "no_data";
}
