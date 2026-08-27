/**
 * How a reviewer is named and counted on screen.
 *
 * Its own module, deliberately. These two functions lived in
 * `reviewer-roster.tsx`, which carries a `"use client"` directive — so
 * importing `reviewerLabel` into the server-rendered `AgreementPanel` did not
 * import the function at all, it imported a client reference, and calling it
 * during a server render threw:
 *
 *   Attempted to call reviewerLabel() from the server but reviewerLabel is on
 *   the client.
 *
 * That crashed the whole species page, but only once a primary reviewer was
 * designated AND a second person had co-reviewed clips — the one moment the
 * agreement table has a row to draw. A species reviewed by one person never
 * hit it, which is why it survived to a collaborator's first full run.
 *
 * Nothing here touches React, so it stays plain TypeScript that either side of
 * the boundary can call.
 */

/**
 * Display label for a reviewer: their portal name when we have one, else the
 * email. Reviewers may be external accounts with no `users` row.
 */
export function reviewerLabel(reviewer: { email: string; name: string | null }): string {
  return reviewer.name?.trim() || reviewer.email;
}

/** "45 / 200" plus a percentage, or a Spanish placeholder before any sample. */
export function formatReviewerProgress(reviewed: number, sampled: number): string {
  if (sampled === 0) return "sin muestra";
  const pct = Math.round((reviewed / sampled) * 100);
  return `${reviewed} / ${sampled} (${pct}%)`;
}
