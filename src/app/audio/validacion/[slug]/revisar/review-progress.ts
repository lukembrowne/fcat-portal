/**
 * What to show when a reviewer runs out of clips in the current batch.
 *
 * The queue loads a page of clips at a time against a sample many times larger.
 * The screen used to render "Cola completada" the moment the page was exhausted
 * — indistinguishable from having finished the species, with no way forward,
 * while 150 clips remained.
 *
 * Pure so both states can be covered without rendering; the component owns only
 * the copy and the refresh.
 */

import { MIN_REVIEWS_FOR_FIT } from "@/lib/birdnet-validation/types";

export type BatchState = "more-available" | "complete";

/**
 * Whether more clips remain for this reviewer beyond the exhausted batch.
 *
 * Compares the reviewer's OWN completed count against the sample size. Under
 * full overlap every reviewer answers every clip, so the denominator is shared
 * but the numerator is personal — using the campaign-wide count would tell
 * someone they were finished because a colleague was.
 */
export function batchState(reviewedByMe: number, sampled: number): BatchState {
  // `>=`, not `===`: a sample can shrink, and offering to load a next batch
  // that would come back empty is worse than declaring completion.
  return reviewedByMe >= sampled ? "complete" : "more-available";
}

/** How many clips are still unanswered by this reviewer. Never negative. */
export function remainingForReviewer(reviewedByMe: number, sampled: number): number {
  return Math.max(0, sampled - reviewedByMe);
}

/**
 * 1-indexed position within the current batch, for display.
 *
 * Safe only because queue order carries no score information — see
 * `presentationOrder`. Under the previous confidence-ordered queue this readout
 * would have been a direct proxy for the score band.
 */
export function queuePosition(index: number, batchLength: number): number {
  if (batchLength <= 0) return 0;
  return Math.min(batchLength, Math.max(0, index) + 1);
}

/**
 * Identity of the batch of clips currently loaded.
 *
 * Used as the review client's React `key`, so a new batch REMOUNTS it. That is
 * not a cosmetic choice — it is the fix for two bugs that shared one cause.
 * `index` and the session's `answers` are client state, and `router.refresh()`
 * replaces the clips and the server's review count underneath them:
 *
 *  - The header and completion screen add the session's answers to the server's
 *    count. Once the server caught up, every answer was counted twice — the
 *    "20 de 10" on the completion screen.
 *  - After the last clip of a batch, `index` equals the batch length. Loading
 *    the next batch left it there, so `done` stayed true and the reviewer was
 *    stuck on the completion screen with no way back into the queue.
 *
 * Remounting resets both to the values that match what the server just sent.
 * Nothing is lost: every answer was written the moment it was given.
 *
 * Keyed on the ids rather than the length alone — a reload after a partial
 * batch returns a shorter list starting at the same clip, and a length-only key
 * would miss a same-size batch of different clips entirely.
 */
export function batchKey(items: Array<{ sampleId: number }>): string {
  if (items.length === 0) return "empty";
  return `${items.length}:${items.map((i) => i.sampleId).join(",")}`;
}

/**
 * Whether this reviewer has answered enough for the logistic fit to be worth
 * offering at the end of a batch.
 *
 * Mirrors the fit's own refusal: `uncertain` answers are excluded from the
 * model, so counting them here would advertise a fit that then comes back
 * "muestra insuficiente".
 */
export function canFit(reviewedByMe: number, uncertainByMe: number): boolean {
  return Math.max(0, reviewedByMe - uncertainByMe) >= MIN_REVIEWS_FOR_FIT;
}
