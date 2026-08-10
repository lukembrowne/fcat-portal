/**
 * Which stage a discarded species returns to when the discard is undone.
 *
 * `abandonCampaign` overwrites `status` and keeps no record of what it was, so
 * a restore has to reconstruct it. That is deliberate: the prior stage is fully
 * determined by rows that already exist, and storing a copy of it would be a
 * migration in service of one action — plus a second source of truth that can
 * disagree with the samples and reviews it claims to describe.
 *
 * Pure and database-free so the precedence can be covered exhaustively without
 * a fixture campaign, the same factoring as `fit-summary.ts` and
 * `review-progress.ts`.
 */

import type { CampaignStatus } from "@/lib/birdnet-validation/types";

export interface RestoreFacts {
  /** A threshold row for this campaign is currently applied portal-wide. */
  hasActiveThreshold: boolean;
  /** How many fits have been run, applied or not. */
  fitCount: number;
  /** True when the most recent fit produced no usable threshold. */
  latestFitUnusable: boolean;
  /** Reviews across all reviewers — any answer means review has started. */
  reviewCount: number;
  /** Set once the stratified draw has run. */
  sampledAt: Date | null;
  /** Drawn clips. */
  sampleCount: number;
}

/**
 * Highest-reached stage wins.
 *
 * Ordered most- to least-advanced rather than following the state machine's
 * edges: a campaign can hold a fit AND an active threshold AND reviews at once,
 * and restoring it to "reviewing" because reviews exist would hide a live
 * threshold behind an earlier-looking stage.
 */
export function deriveRestoredStatus(facts: RestoreFacts): CampaignStatus {
  if (facts.hasActiveThreshold) return "applied";
  if (facts.fitCount > 0) return facts.latestFitUnusable ? "unusable" : "fitted";
  if (facts.reviewCount > 0) return "reviewing";
  // Either signal means the draw happened. `sampledAt` is the one the draw
  // sets; the row count is checked too so a campaign whose clips exist but
  // whose timestamp somehow does not is still restored as drawn rather than
  // sent back to the failure state.
  if (facts.sampledAt != null || facts.sampleCount > 0) return "sampled";
  return "draft";
}
