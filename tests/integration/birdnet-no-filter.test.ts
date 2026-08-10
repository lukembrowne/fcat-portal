/**
 * Integration tests for "this species needs no confidence filter".
 *
 * The case: every review comes back correct, so the logistic fit hits complete
 * separation and refuses. That is the right refusal — there is no error to
 * model — but it used to be the end of the road, and the consequence was
 * invisible. A species with no APPLIED threshold falls back to the global 0.70,
 * so the portal kept discarding the low-scoring detections the reviewer had just
 * confirmed were correct (13,854 of 24,913 for `Ortalis erythroptera` on the dev
 * database). `markSpeciesNoFilter` is how that decision gets recorded.
 *
 * Two properties carry the weight here:
 *
 *  1. It REFUSES on any species that is not unanimous. Applied to a species
 *     BirdNET never gets right, "keep everything" is the worst possible action,
 *     so the guard lives on the server rather than in a hidden button.
 *  2. It never claims to be a fit. `source = "no_filter"`, no coefficients, its
 *     own event type — the audit trail must not present a person's decision as
 *     a model's output.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

import * as schema from "@/db/schema";
import { SCORE_FLOOR } from "@/lib/birdnet-validation/types";
import {
  mockRequirePermission,
  setupAuthMocks,
  testUser,
} from "../helpers/mock-auth";
import {
  createTestDb,
  setupIntegrationDbMock,
  testDbRef,
  type TestDb,
} from "../helpers/test-db";

setupAuthMocks();
setupIntegrationDbMock();

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/habitat-lookup", () => ({
  loadSiteHabitatMap: vi.fn(async () => new Map<string, string>()),
}));
vi.mock("@/lib/camera-trap-auth", () => ({
  getUserCameraTrapProjects: vi.fn(async () => "all"),
}));

let db: TestDb;
let deploymentId: number;

const SPECIES = "Ortalis erythroptera";

const actions = () => import("@/app/audio/validacion/actions");

/** A campaign with `n` samples already drawn, spread across the score range. */
function campaignWithSamples(n: number): number {
  const [campaign] = db
    .insert(schema.birdnetValidationCampaigns)
    .values({
      species: SPECIES,
      targetSampleSize: n,
      binCount: 9,
      seed: 12345,
      status: "sampled",
      sampledAt: new Date(),
      createdBy: testUser.email,
      primaryReviewerEmail: testUser.email,
    })
    .returning()
    .all();

  for (let i = 0; i < n; i++) {
    const confidence = 0.1 + (0.89 * i) / Math.max(1, n - 1);
    const [file] = db
      .insert(schema.audioFiles)
      .values({
        deploymentId,
        filename: `nf-${i}.flac`,
        driveFileId: `drive-nf-${i}`,
        duration: 60,
      })
      .returning()
      .all();
    const [detection] = db
      .insert(schema.audioDetections)
      .values({
        audioFileId: file.id,
        startTime: 10,
        endTime: 13,
        minFreq: 0,
        maxFreq: 15000,
        confidence,
      })
      .returning()
      .all();
    const [ident] = db
      .insert(schema.audioIdentifications)
      .values({ audioDetectionId: detection.id, species: SPECIES, confidence })
      .returning()
      .all();
    db.insert(schema.birdnetValidationSamples)
      .values({
        campaignId: campaign.id,
        audioIdentificationId: ident.id,
        confidence,
        binIndex: Math.min(8, Math.floor((confidence - 0.1) / 0.1)),
        deploymentId,
        siteName: "NF-001",
        orderIndex: i,
      })
      .run();
  }

  return campaign.id;
}

/** Answer the first `n` clips, `incorrect` of them wrong. */
function review(campaignId: number, n: number, incorrect = 0) {
  const rows = db
    .select()
    .from(schema.birdnetValidationSamples)
    .where(eq(schema.birdnetValidationSamples.campaignId, campaignId))
    .all()
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .slice(0, n);

  rows.forEach((sample, i) => {
    db.insert(schema.birdnetValidationReviews)
      .values({
        sampleId: sample.id,
        reviewerEmail: testUser.email,
        outcome: i < incorrect ? "incorrect" : "correct",
      })
      .run();
  });
  db.insert(schema.birdnetValidationCampaignReviewers)
    .values({
      campaignId,
      reviewerEmail: testUser.email,
      addedBy: testUser.email,
    })
    .run();
}

const thresholds = () =>
  db.select().from(schema.birdnetSpeciesThresholds).all();

beforeEach(() => {
  vi.clearAllMocks();
  mockRequirePermission.mockResolvedValue(testUser);

  db = createTestDb();
  testDbRef.current = db;

  const [ctProject] = db
    .insert(schema.cameraTrapProjects)
    .values({ name: "NoFilterProject" })
    .returning()
    .all();
  const [deployment] = db
    .insert(schema.deployments)
    .values({
      projectId: "camera-trap",
      name: "NF-001",
      siteName: "NF-001",
      status: "scanned",
      cameraTrapProjectId: ctProject.id,
    })
    .returning()
    .all();
  deploymentId = deployment.id;
});

describe("markSpeciesNoFilter", () => {
  it("records a floor threshold and applies it when every review is correct", async () => {
    const { markSpeciesNoFilter } = await actions();
    const campaignId = campaignWithSamples(40);
    review(campaignId, 30);

    const result = await markSpeciesNoFilter(campaignId);

    expect(result.success).toBe(true);
    const [row] = thresholds();
    expect(row.source).toBe("no_filter");
    expect(row.thresholdConf95).toBe(SCORE_FLOOR);
    expect(row.isActive).toBe(true);
    expect(row.nReviewed).toBe(30);
    expect(row.nCorrect).toBe(30);
    expect(row.appliedBy).toBe(testUser.email);
  });

  it("claims no model: no coefficients, no interval, no unusable reason", async () => {
    // The audit trail must never let a person's decision be read back as
    // something the logistic fit produced.
    const { markSpeciesNoFilter } = await actions();
    const campaignId = campaignWithSamples(40);
    review(campaignId, 25);

    await markSpeciesNoFilter(campaignId);

    const [row] = thresholds();
    expect(row.intercept).toBeNull();
    expect(row.slope).toBeNull();
    expect(row.converged).toBe(false);
    expect(row.ciLower95).toBeNull();
    expect(row.ciUpper95).toBeNull();
    expect(row.unusableReason).toBeNull();
  });

  it("keeps every detection: the floor sits at or below the lowest score BirdNET emits", async () => {
    // BirdNET suppresses below 0.1 and the data confirms it — min confidence is
    // exactly 0.1, zero rows beneath. So the floor is a true no-op filter rather
    // than a very permissive one.
    const { markSpeciesNoFilter } = await actions();
    const campaignId = campaignWithSamples(40);
    review(campaignId, 30);
    await markSpeciesNoFilter(campaignId);

    const [row] = thresholds();
    const confidences = db
      .select()
      .from(schema.audioIdentifications)
      .all()
      .map((r) => r.confidence!);
    expect(Math.min(...confidences)).toBeGreaterThanOrEqual(row.thresholdConf95!);
  });

  it("moves the campaign to applied", async () => {
    const { markSpeciesNoFilter } = await actions();
    const campaignId = campaignWithSamples(40);
    review(campaignId, 30);

    await markSpeciesNoFilter(campaignId);

    const [campaign] = db
      .select()
      .from(schema.birdnetValidationCampaigns)
      .where(eq(schema.birdnetValidationCampaigns.id, campaignId))
      .all();
    expect(campaign.status).toBe("applied");
  });

  it("REFUSES when any review is incorrect", async () => {
    // The all-wrong and mostly-wrong species are exactly where "keep
    // everything" is the damaging answer.
    const { markSpeciesNoFilter } = await actions();
    const campaignId = campaignWithSamples(40);
    review(campaignId, 30, 1);

    const result = await markSpeciesNoFilter(campaignId);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("todas las revisiones");
    expect(thresholds()).toHaveLength(0);
  });

  it("REFUSES below the minimum review count", async () => {
    const { markSpeciesNoFilter } = await actions();
    const campaignId = campaignWithSamples(40);
    review(campaignId, 5);

    const result = await markSpeciesNoFilter(campaignId);

    expect(result.success).toBe(false);
    expect(thresholds()).toHaveLength(0);
  });

  it("REFUSES on a discarded species", async () => {
    const { markSpeciesNoFilter, abandonCampaign } = await actions();
    const campaignId = campaignWithSamples(40);
    review(campaignId, 30);
    await abandonCampaign(campaignId, "prueba");

    const result = await markSpeciesNoFilter(campaignId);

    expect(result.success).toBe(false);
    expect(thresholds()).toHaveLength(0);
  });

  it("REFUSES when the fit-eligible reviewer cannot be resolved", async () => {
    // Same guard the fit uses. Pooling two reviewers' answers to reach
    // unanimity would be the same pseudo-replication, reached by a side door.
    const { markSpeciesNoFilter } = await actions();
    const campaignId = campaignWithSamples(40);
    review(campaignId, 30);

    db.update(schema.birdnetValidationCampaigns)
      .set({ primaryReviewerEmail: null })
      .where(eq(schema.birdnetValidationCampaigns.id, campaignId))
      .run();
    const [sample] = db
      .select()
      .from(schema.birdnetValidationSamples)
      .where(eq(schema.birdnetValidationSamples.campaignId, campaignId))
      .all();
    db.insert(schema.birdnetValidationReviews)
      .values({
        sampleId: sample.id,
        reviewerEmail: "otra@fcat-ecuador.org",
        outcome: "correct",
      })
      .run();

    const result = await markSpeciesNoFilter(campaignId);

    expect(result.success).toBe(false);
    expect(thresholds()).toHaveLength(0);
  });

  it("replaces a previously applied threshold rather than colliding with it", async () => {
    // The partial unique index permits one active row per species, so applying
    // this must deactivate whatever was in force.
    const { markSpeciesNoFilter } = await actions();
    const campaignId = campaignWithSamples(40);
    review(campaignId, 30);

    db.insert(schema.birdnetSpeciesThresholds)
      .values({
        campaignId,
        species: SPECIES,
        nReviewed: 30,
        nCorrect: 20,
        thresholdConf95: 0.8,
        isActive: true,
      })
      .run();

    const result = await markSpeciesNoFilter(campaignId);

    expect(result.success).toBe(true);
    const active = thresholds().filter((t) => t.isActive);
    expect(active).toHaveLength(1);
    expect(active[0].source).toBe("no_filter");
  });

  it("records a system event distinct from a threshold application", async () => {
    const { markSpeciesNoFilter } = await actions();
    const campaignId = campaignWithSamples(40);
    review(campaignId, 30);

    await markSpeciesNoFilter(campaignId);

    const events = db.select().from(schema.systemEvents).all();
    const event = events.find((e) => e.eventType === "birdnet_no_filter_applied");
    expect(event).toBeDefined();
    expect(event?.targetId).toBe(SPECIES);
    expect(event?.actorEmail).toBe(testUser.email);
  });
});

describe("revertThreshold on a no-filter decision", () => {
  it("returns the campaign to unusable, not to fitted", async () => {
    // "fitted" would invent a fit that never happened — the underlying attempt
    // is precisely the one that produced no threshold.
    const { markSpeciesNoFilter, revertThreshold } = await actions();
    const campaignId = campaignWithSamples(40);
    review(campaignId, 30);
    await markSpeciesNoFilter(campaignId);

    const [row] = thresholds();
    const result = await revertThreshold(row.id);

    expect(result.success).toBe(true);
    const [campaign] = db
      .select()
      .from(schema.birdnetValidationCampaigns)
      .where(eq(schema.birdnetValidationCampaigns.id, campaignId))
      .all();
    expect(campaign.status).toBe("unusable");
  });

  it("leaves the species back on the global default", async () => {
    const { markSpeciesNoFilter, revertThreshold } = await actions();
    const campaignId = campaignWithSamples(40);
    review(campaignId, 30);
    await markSpeciesNoFilter(campaignId);

    const [row] = thresholds();
    await revertThreshold(row.id);

    expect(thresholds().filter((t) => t.isActive)).toHaveLength(0);
  });
});
