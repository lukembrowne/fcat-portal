/**
 * Per-clip reviewer notes: free text a reviewer attaches to their OWN review
 * of one sampled clip — the call type ("canto", "alarma"), a second species in
 * the background, anything peculiar about the recording.
 *
 * Pure, so the server action and the review client share one definition of
 * what a note is. Lives on `birdnet_validation_reviews.notes`, one per
 * (sample, reviewer), so a colleague's note can never be overwritten. A note
 * changes no count, fit or export filter; it is read only by the species
 * page's "Notas de revisión", `/desacuerdos` and the correct-detections CSV.
 */

/** Longest note accepted. Generous for a comment, small enough to stay a note. */
export const MAX_REVIEW_NOTE_LENGTH = 2000;

/**
 * Trim, and collapse blank to null — the column holds either a note or nothing,
 * never an empty string that a "has a note?" check would count.
 */
export function normalizeReviewNote(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  return trimmed ? trimmed : null;
}

/** Whether the typed text differs from what the server holds. */
export function noteIsDirty(draft: string | undefined, saved: string | null | undefined): boolean {
  return normalizeReviewNote(draft) !== (saved ?? null);
}
