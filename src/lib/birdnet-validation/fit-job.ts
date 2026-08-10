/**
 * Headless fit-and-persist core.
 *
 * Auth-agnostic so it can be driven from a server action, a batch job, or a
 * maintenance script — mirroring the `audio-compression-core.ts` split.
 *
 * A fit is fast (milliseconds in R once warm), so the single-campaign path is
 * called synchronously from an action rather than queued. The
 * `birdnet_threshold_fit` job type exists for the batch path that refits every
 * campaign at once.
 */

import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/db";
import {
  birdnetValidationCampaigns,
  birdnetValidationSamples,
  birdnetSpeciesThresholds,
  audioIdentifications,
} from "@/db/schema";
import { log } from "@/lib/log";
import { fitThresholds, type FitRequest, type FitResult } from "./fit-runner";
import {
  resolveFitEligibleReviews,
  summarizeEligible,
  type EligibleReview,
} from "./fit-eligibility";
import { FIT_ELIGIBILITY_REASON_ES, UNUSABLE_REASON_ES } from "./types";

export interface FitPersistResult {
  campaignId: number;
  species: string;
  usable: boolean;
  thresholdConf95: number | null;
  reason: string | null;
}

/**
 * Observations for the regression: the fit-eligible set minus `uncertain`.
 *
 * Uncertain reviews carry no signal about whether BirdNET was right, so
 * including them as either outcome would bias the fit. They are counted
 * separately and reported.
 *
 * Note the shape this operates on — one review per sample, already chosen by
 * `resolveFitEligibleReviews`. Feeding it the raw review rows would silently
 * multiply n by the reviewer count.
 */
function toObservations(reviews: EligibleReview[]) {
  return reviews
    .filter((r) => r.outcome !== "uncertain")
    .map((r) => ({
      conf: r.confidence,
      outcome: (r.outcome === "correct" ? 1 : 0) as 0 | 1,
    }));
}

/**
 * The BirdNET model version(s) behind this campaign's detections.
 *
 * Recorded on the fit because a threshold is only valid for the model that
 * produced the scores — a BirdNET upgrade invalidates it.
 *
 * EVERY distinct version, comma-separated, not one arbitrary row. This used to
 * take `limit(1)` with no ORDER BY, which is only correct if a sample never
 * spans versions. It does: on the dev database 63 of 69 sampled species drew
 * from both `birdnet-analyzer` (predictions made before version tracking
 * existed) and `birdnet-analyzer@2.4.0; model=V2.4`, in roughly half-and-half
 * proportions — so the fit claimed to be "valid for" whichever label the
 * unordered query happened to return. Two labels here are the SAME analyzer
 * (see scripts/backfill-birdnet-model-version.mjs, which restamps the bare
 * ones); listing them both is what lets a reader tell that case apart from a
 * genuine mid-sample upgrade, which would make the scores incomparable.
 */
export async function resolveModelVersion(campaignId: number): Promise<string | null> {
  const rows = await db
    .selectDistinct({ modelVersion: audioIdentifications.modelVersion })
    .from(birdnetValidationSamples)
    .innerJoin(
      audioIdentifications,
      eq(audioIdentifications.id, birdnetValidationSamples.audioIdentificationId)
    )
    .where(eq(birdnetValidationSamples.campaignId, campaignId));

  const versions = rows
    .map((r) => r.modelVersion)
    .filter((v): v is string => v != null && v.trim() !== "")
    .sort();

  return versions.length > 0 ? versions.join(", ") : null;
}

function persistOne(
  campaignId: number,
  species: string,
  result: FitResult,
  nUncertain: number,
  modelVersion: string | null,
  primaryReviewerEmail: string
): FitPersistResult {
  const t95 = result.usable ? result.thresholds["0.95"] : undefined;
  const reason = result.usable ? null : UNUSABLE_REASON_ES[result.reason];

  // Sequential awaits rather than db.transaction(async …): better-sqlite3
  // transactions must be synchronous.
  db.insert(birdnetSpeciesThresholds)
    .values({
      campaignId,
      species,
      nReviewed: result.nReviewed,
      nCorrect: result.nCorrect,
      nUncertain,
      intercept: result.usable ? result.intercept : null,
      slope: result.usable ? result.slope : null,
      converged: result.usable ? result.converged : false,
      thresholdConf90: result.usable ? result.thresholds["0.9"]?.conf ?? null : null,
      thresholdConf95: t95?.conf ?? null,
      thresholdConf99: result.usable ? result.thresholds["0.99"]?.conf ?? null : null,
      thresholdSe95: t95?.se ?? null,
      ciLower95: t95?.lower ?? null,
      ciUpper95: t95?.upper ?? null,
      unusableReason: reason,
      modelVersion,
      primaryReviewerEmail,
      isActive: false,
    })
    .run();

  return {
    campaignId,
    species,
    usable: result.usable,
    thresholdConf95: t95?.conf ?? null,
    reason,
  };
}

/**
 * Fit and persist every listed campaign in one warm R worker.
 *
 * A campaign's fit never overwrites its predecessor: each run inserts a new
 * threshold row (inactive by default), so the history of fits is preserved and
 * applying a threshold stays a separate, explicit act.
 */
export async function fitAndPersistCampaigns(
  campaignIds: number[]
): Promise<FitPersistResult[]> {
  if (campaignIds.length === 0) return [];

  const requests: FitRequest[] = [];
  const meta = new Map<
    number,
    {
      species: string;
      uncertain: number;
      modelVersion: string | null;
      reviewerEmail: string;
    }
  >();
  const refusals: FitPersistResult[] = [];

  for (const campaignId of campaignIds) {
    const [campaign] = await db
      .select({
        id: birdnetValidationCampaigns.id,
        species: birdnetValidationCampaigns.species,
      })
      .from(birdnetValidationCampaigns)
      .where(eq(birdnetValidationCampaigns.id, campaignId));
    if (!campaign) continue;

    const eligible = await resolveFitEligibleReviews(campaignId);
    if (!eligible.ok) {
      // Batch refits skip an ambiguous campaign rather than aborting the whole
      // run; the single-campaign action surfaces the reason to the caller.
      refusals.push({
        campaignId,
        species: campaign.species,
        usable: false,
        thresholdConf95: null,
        reason: FIT_ELIGIBILITY_REASON_ES[eligible.reason],
      });
      continue;
    }

    const totals = summarizeEligible(eligible.reviews);
    const observations = toObservations(eligible.reviews);
    const modelVersion = await resolveModelVersion(campaignId);

    meta.set(campaignId, {
      species: campaign.species,
      uncertain: totals.uncertain,
      modelVersion,
      reviewerEmail: eligible.reviewerEmail,
    });
    requests.push({ campaignId, species: campaign.species, observations });
  }

  if (requests.length === 0) return refusals;

  const started = Date.now();
  const results = await fitThresholds(requests);
  log.info(
    { n: requests.length, ms: Date.now() - started },
    "[birdnet-threshold] batch fit complete"
  );

  const persisted: FitPersistResult[] = [...refusals];
  for (const result of results) {
    const info = meta.get(result.campaignId);
    if (!info) continue;

    persisted.push(
      persistOne(
        result.campaignId,
        info.species,
        result,
        info.uncertain,
        info.modelVersion,
        info.reviewerEmail
      )
    );

    await db
      .update(birdnetValidationCampaigns)
      .set({ status: result.usable ? "fitted" : "unusable" })
      .where(eq(birdnetValidationCampaigns.id, result.campaignId));
  }

  return persisted;
}
