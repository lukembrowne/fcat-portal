/**
 * Browser-side copies of clip notes typed before the clip was answered.
 *
 * Such a note has nowhere to go on the server — `setReviewNote` writes onto the
 * reviewer's review row, which only exists once there is an answer — so it
 * used to live in React state alone and a reload threw it away while the box
 * still said "Se guardará al responder". It is now mirrored here until the
 * answer lands and the note is saved for real.
 *
 * A convenience, not storage: every access is guarded, because storage can be
 * blocked or throw (private windows, cleared site data), and the page must
 * work exactly as before without it. Keyed by reviewer too, so a shared
 * computer never shows one reviewer's draft to another.
 */

const PREFIX = "fcat:birdnet-review-note:";

function keyFor(reviewerEmail: string, sampleId: number): string {
  return `${PREFIX}${reviewerEmail}:${sampleId}`;
}

export function readNoteDraft(reviewerEmail: string, sampleId: number): string | null {
  try {
    const value = window.localStorage.getItem(keyFor(reviewerEmail, sampleId));
    return value && value.trim() ? value : null;
  } catch {
    return null;
  }
}

/** Stores the draft, or removes it when blank. */
export function writeNoteDraft(reviewerEmail: string, sampleId: number, text: string): void {
  try {
    if (text.trim()) window.localStorage.setItem(keyFor(reviewerEmail, sampleId), text);
    else window.localStorage.removeItem(keyFor(reviewerEmail, sampleId));
  } catch {
    // Storage unavailable: the draft still lives in React state for the session.
  }
}

export function clearNoteDraft(reviewerEmail: string, sampleId: number): void {
  try {
    window.localStorage.removeItem(keyFor(reviewerEmail, sampleId));
  } catch {
    // Nothing to clear.
  }
}
