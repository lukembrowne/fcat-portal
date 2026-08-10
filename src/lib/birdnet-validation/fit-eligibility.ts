/**
 * Which reviews a campaign's science reads.
 *
 * Under full overlap every rostered reviewer answers every clip, so a sample
 * carries several outcomes and something has to choose. This module is the
 * single place that chooses, and every scientific consumer — the logistic fit,
 * bin coverage, site coverage, campaign totals, the rug plot — routes through
 * it. That matters because the number the coverage chart shows and the number
 * the fit consumes must not be able to drift apart.
 *
 * The rule: the campaign's designated primary reviewer. When none is
 * designated and exactly one person has answered, that person is used, so a
 * single-reviewer campaign (how most start) behaves exactly as before. When
 * none is designated and several people have answered, this REFUSES.
 *
 * The refusal is the point. Pooling every review would hand the model N rows
 * per clip instead of one — pseudo-replication. The threshold's standard error
 * scales roughly as 1/sqrt(n), so three reviewers would report an interval
 * about 42% tighter than the data supports, and nothing would raise an error.
 * The CI is the number that tells you whether 200 clips per species was
 * enough; a silently inflated one defeats the whole measurement.
 */

import "server-only";

import { eq, sql } from "drizzle-orm";

import { db } from "@/db";
import {
  birdnetValidationCampaigns,
  birdnetValidationReviews,
  birdnetValidationSamples,
} from "@/db/schema";
import type { FitEligibilityReason, ReviewOutcome } from "./types";

export interface EligibleReview {
  sampleId: number;
  confidence: number;
  binIndex: number;
  outcome: ReviewOutcome;
}

export type FitEligibility =
  | { ok: true; reviewerEmail: string; reviews: EligibleReview[] }
  | { ok: false; reason: FitEligibilityReason };

/**
 * Resolve which single reviewer's answers this campaign's fit reads.
 *
 * Returns the email rather than taking one, so callers cannot accidentally
 * pass a reviewer the campaign has not designated.
 */
export async function resolveFitReviewer(
  campaignId: number
): Promise<{ ok: true; reviewerEmail: string } | { ok: false; reason: FitEligibilityReason }> {
  const [campaign] = await db
    .select({ primary: birdnetValidationCampaigns.primaryReviewerEmail })
    .from(birdnetValidationCampaigns)
    .where(eq(birdnetValidationCampaigns.id, campaignId));

  if (campaign?.primary) {
    return { ok: true, reviewerEmail: campaign.primary };
  }

  const distinct = await db
    .selectDistinct({ email: birdnetValidationReviews.reviewerEmail })
    .from(birdnetValidationReviews)
    .innerJoin(
      birdnetValidationSamples,
      eq(birdnetValidationSamples.id, birdnetValidationReviews.sampleId)
    )
    .where(eq(birdnetValidationSamples.campaignId, campaignId));

  if (distinct.length === 0) return { ok: false, reason: "nothing_reviewed" };
  if (distinct.length > 1) return { ok: false, reason: "no_primary_reviewer" };
  return { ok: true, reviewerEmail: distinct[0].email };
}

/**
 * The campaign's fit-eligible reviews: exactly one row per answered sample.
 *
 * `uncertain` rows are included here and dropped by the consumers that need to
 * — the fit excludes them from the regression, while progress counts report
 * them. Filtering at this layer would make the uncertain rate unreportable.
 */
export async function resolveFitEligibleReviews(
  campaignId: number
): Promise<FitEligibility> {
  const resolved = await resolveFitReviewer(campaignId);
  if (!resolved.ok) return resolved;

  const reviews = await db
    .select({
      sampleId: birdnetValidationSamples.id,
      confidence: birdnetValidationSamples.confidence,
      binIndex: birdnetValidationSamples.binIndex,
      outcome: birdnetValidationReviews.outcome,
    })
    .from(birdnetValidationSamples)
    .innerJoin(
      birdnetValidationReviews,
      eq(birdnetValidationReviews.sampleId, birdnetValidationSamples.id)
    )
    .where(
      sql`${birdnetValidationSamples.campaignId} = ${campaignId}
          AND ${birdnetValidationReviews.reviewerEmail} = ${resolved.reviewerEmail}`
    );

  return {
    ok: true,
    reviewerEmail: resolved.reviewerEmail,
    reviews: reviews.map((r) => ({
      ...r,
      outcome: r.outcome as ReviewOutcome,
    })),
  };
}

export interface EligibleTotals {
  reviewed: number;
  correct: number;
  incorrect: number;
  uncertain: number;
}

/** Campaign-level counts over the fit-eligible set. Zeros when unresolvable. */
export function summarizeEligible(reviews: EligibleReview[]): EligibleTotals {
  return {
    reviewed: reviews.length,
    correct: reviews.filter((r) => r.outcome === "correct").length,
    incorrect: reviews.filter((r) => r.outcome === "incorrect").length,
    uncertain: reviews.filter((r) => r.outcome === "uncertain").length,
  };
}
