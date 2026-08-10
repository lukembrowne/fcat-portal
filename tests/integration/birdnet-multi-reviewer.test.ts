/**
 * Multi-reviewer validation: independent queues, non-destructive recording,
 * roster management, and the fit's one-observation-per-clip guarantee.
 *
 * The pseudo-replication test in the "fit input selection" block is the most
 * important one here. Pooling every reviewer's answers produces a plausible
 * fit rather than an error — n triples without the information tripling, and
 * the reported threshold interval comes out roughly 42% tighter than the data
 * supports. Nothing else in the suite would catch that.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
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

const mockHabitatMap = vi.fn();
vi.mock("@/lib/habitat-lookup", () => ({
  loadSiteHabitatMap: () => mockHabitatMap(),
}));

vi.mock("@/lib/camera-trap-auth", () => ({
  getUserCameraTrapProjects: vi.fn(async () => "all"),
}));

// The R worker is out of scope here; capture what the fit was asked to fit.
const mockFitThresholds = vi.fn();
vi.mock("@/lib/birdnet-validation/fit-runner", () => ({
  fitThresholds: (requests: unknown) => mockFitThresholds(requests),
}));

let db: TestDb;
let deploymentId: number;

const SPECIES = "Ramphastos ambiguus";
const JUAN = "juan@fcat-ecuador.org";
const GLORIA = "gloria@fcat-ecuador.org";
const GREGORY = "gregory@fcat-ecuador.org";

function asUser(email: string) {
  mockRequirePermission.mockResolvedValue({ ...testUser, email });
}

/** Insert `n` identifications for the species, spread across confidence. */
function seedDetections(n: number) {
  for (let i = 0; i < n; i++) {
    const confidence = 0.15 + (i % 9) * 0.09;
    const [file] = db
      .insert(schema.audioFiles)
      .values({
        deploymentId,
        filename: `f-${i}.flac`,
        driveFileId: `drive-${i}`,
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
        minFreq: 400,
        maxFreq: 9000,
        confidence,
      })
      .returning()
      .all();
    db.insert(schema.audioIdentifications)
      .values({ audioDetectionId: detection.id, species: SPECIES, confidence })
      .run();
  }
}

async function campaignWithSample(sampleSize: number) {
  // Creating the species draws its sample; there is no separate draw step.
  const { createCampaign } = await import("@/app/audio/validacion/actions");
  const created = await createCampaign({
    species: SPECIES,
    targetSampleSize: sampleSize,
  });
  if (!created.success) throw new Error(created.error);
  if (created.data.drawError) throw new Error(created.data.drawError);
  return created.data.campaignId;
}

function samplesOf(campaignId: number) {
  return db
    .select()
    .from(schema.birdnetValidationSamples)
    .where(eq(schema.birdnetValidationSamples.campaignId, campaignId))
    .orderBy(schema.birdnetValidationSamples.orderIndex)
    .all();
}

beforeEach(() => {
  vi.clearAllMocks();
  asUser(JUAN);
  mockHabitatMap.mockResolvedValue(new Map([["VAL-000", "bosque maduro"]]));

  db = createTestDb();
  testDbRef.current = db;

  const [ctProject] = db
    .insert(schema.cameraTrapProjects)
    .values({ name: "MultiReviewerTest" })
    .returning()
    .all();
  const [deployment] = db
    .insert(schema.deployments)
    .values({
      projectId: "camera-trap",
      name: "VAL-000",
      siteName: "VAL-000",
      status: "scanned",
      cameraTrapProjectId: ctProject.id,
    })
    .returning()
    .all();
  deploymentId = deployment.id;

  for (const email of [JUAN, GLORIA, GREGORY]) {
    db.insert(schema.users)
      .values({ email, name: email.split("@")[0] })
      .run();
  }
});

describe("recordReview — per-reviewer isolation", () => {
  it("keeps both answers when two reviewers disagree on the same clip", async () => {
    const { recordReview } = await import("@/app/audio/validacion/actions");
    seedDetections(30);
    const campaignId = await campaignWithSample(10);
    const [sample] = samplesOf(campaignId);

    asUser(JUAN);
    await recordReview(sample.id, "correct");
    asUser(GLORIA);
    await recordReview(sample.id, "incorrect");

    const rows = db
      .select()
      .from(schema.birdnetValidationReviews)
      .where(eq(schema.birdnetValidationReviews.sampleId, sample.id))
      .all();

    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.reviewerEmail === JUAN)?.outcome).toBe("correct");
    expect(rows.find((r) => r.reviewerEmail === GLORIA)?.outcome).toBe("incorrect");
  });

  it("lets a reviewer revise their own answer without touching anyone else's", async () => {
    const { recordReview } = await import("@/app/audio/validacion/actions");
    seedDetections(30);
    const campaignId = await campaignWithSample(10);
    const [sample] = samplesOf(campaignId);

    asUser(JUAN);
    await recordReview(sample.id, "correct");
    asUser(GLORIA);
    await recordReview(sample.id, "correct");
    await recordReview(sample.id, "incorrect");

    const rows = db
      .select()
      .from(schema.birdnetValidationReviews)
      .where(eq(schema.birdnetValidationReviews.sampleId, sample.id))
      .all();

    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.reviewerEmail === GLORIA)?.outcome).toBe("incorrect");
    expect(rows.find((r) => r.reviewerEmail === JUAN)?.outcome).toBe("correct");
  });

  it("does not move the timestamp when the same answer is recorded twice", async () => {
    const { recordReview } = await import("@/app/audio/validacion/actions");
    seedDetections(30);
    const campaignId = await campaignWithSample(10);
    const [sample] = samplesOf(campaignId);

    asUser(JUAN);
    await recordReview(sample.id, "correct");
    const first = db
      .select()
      .from(schema.birdnetValidationReviews)
      .all()[0].reviewedAt;

    await new Promise((r) => setTimeout(r, 1100));
    await recordReview(sample.id, "correct");
    const second = db
      .select()
      .from(schema.birdnetValidationReviews)
      .all()[0].reviewedAt;

    expect(second).toEqual(first);
  });

  it("auto-enrolls a reviewer who was never added to the roster", async () => {
    const { recordReview } = await import("@/app/audio/validacion/actions");
    seedDetections(30);
    const campaignId = await campaignWithSample(10);
    const [sample] = samplesOf(campaignId);

    asUser(GREGORY);
    await recordReview(sample.id, "correct");

    const roster = db
      .select()
      .from(schema.birdnetValidationCampaignReviewers)
      .where(eq(schema.birdnetValidationCampaignReviewers.campaignId, campaignId))
      .all();
    expect(roster.map((r) => r.reviewerEmail)).toContain(GREGORY);
  });

  it("rejects a caller without editor permission", async () => {
    const { recordReview } = await import("@/app/audio/validacion/actions");
    seedDetections(30);
    const campaignId = await campaignWithSample(10);
    const [sample] = samplesOf(campaignId);

    mockRequirePermission.mockRejectedValueOnce(new Error("REDIRECT:/"));
    await expect(recordReview(sample.id, "correct")).rejects.toThrow("REDIRECT");
    expect(db.select().from(schema.birdnetValidationReviews).all()).toHaveLength(0);
  });
});

describe("getReviewQueue — independent per-reviewer queues", () => {
  it("skips only the caller's own answered clips", async () => {
    const { recordReview, getReviewQueue } = await import(
      "@/app/audio/validacion/actions"
    );
    seedDetections(40);
    const campaignId = await campaignWithSample(12);
    const samples = samplesOf(campaignId);

    asUser(JUAN);
    for (const s of samples.slice(0, 5)) await recordReview(s.id, "correct");

    const juanQueue = await getReviewQueue(campaignId);
    if (!juanQueue.success) throw new Error(juanQueue.error);
    asUser(GLORIA);
    const gloriaQueue = await getReviewQueue(campaignId);
    if (!gloriaQueue.success) throw new Error(gloriaQueue.error);

    expect(juanQueue.data).toHaveLength(samples.length - 5);
    expect(gloriaQueue.data).toHaveLength(samples.length);
    // Juan resumes past his own answers; Gloria starts at the top.
    expect(juanQueue.data[0].sampleId).toBe(samples[5].id);
    expect(gloriaQueue.data[0].sampleId).toBe(samples[0].id);
  });

  it("serves every reviewer the same clips in the same order", async () => {
    const { getReviewQueue } = await import("@/app/audio/validacion/actions");
    seedDetections(40);
    const campaignId = await campaignWithSample(12);

    asUser(JUAN);
    const a = await getReviewQueue(campaignId);
    asUser(GREGORY);
    const b = await getReviewQueue(campaignId);
    if (!a.success || !b.success) throw new Error("queue load failed");

    expect(a.data.map((r) => r.sampleId)).toEqual(b.data.map((r) => r.sampleId));
  });

  it("never returns a review outcome to the review client", async () => {
    // Blinding: a reviewer must not learn what anyone else answered. Asserting
    // on payload shape rather than rendered output, because a field can reach
    // the client and simply not be displayed.
    const { recordReview, getReviewQueue } = await import(
      "@/app/audio/validacion/actions"
    );
    seedDetections(40);
    const campaignId = await campaignWithSample(12);
    const samples = samplesOf(campaignId);

    asUser(JUAN);
    await recordReview(samples[0].id, "correct");

    asUser(GLORIA);
    const queue = await getReviewQueue(campaignId);
    if (!queue.success) throw new Error(queue.error);

    const serialized = JSON.stringify(queue.data);
    expect(serialized).not.toContain("correct");
    for (const row of queue.data) {
      expect(row).not.toHaveProperty("reviewOutcome");
      expect(row).not.toHaveProperty("outcome");
      expect(row).not.toHaveProperty("reviewerEmail");
    }
  });

  it("carries clip geometry and a recording timestamp for the overlay", async () => {
    const { getReviewQueue } = await import("@/app/audio/validacion/actions");
    seedDetections(40);
    const campaignId = await campaignWithSample(12);

    const queue = await getReviewQueue(campaignId);
    if (!queue.success) throw new Error(queue.error);

    expect(queue.data.length).toBeGreaterThan(0);
    for (const row of queue.data) {
      expect(row.bandLeftPct).toBeGreaterThanOrEqual(0);
      expect(row.bandRightPct).toBeLessThanOrEqual(100);
      expect(row.bandRightPct).toBeGreaterThan(row.bandLeftPct);
      expect(row.clipSpanSeconds).toBeGreaterThan(0);
    }
  });

  it("adds no outcome field alongside the new geometry fields", async () => {
    // The blinding shape assertion above pins the fields that existed when it
    // was written; widening the payload must not smuggle one in.
    const { recordReview, getReviewQueue } = await import(
      "@/app/audio/validacion/actions"
    );
    seedDetections(40);
    const campaignId = await campaignWithSample(12);
    const samples = samplesOf(campaignId);

    asUser(JUAN);
    await recordReview(samples[0].id, "incorrect");

    asUser(GLORIA);
    const queue = await getReviewQueue(campaignId);
    if (!queue.success) throw new Error(queue.error);

    const allowed = new Set([
      "sampleId",
      "audioIdentificationId",
      "confidence",
      "binIndex",
      "siteName",
      "habitat",
      "isTriage",
      "orderIndex",
      "bandLeftPct",
      "bandRightPct",
      "clipSpanSeconds",
      "recordedAt",
    ]);
    for (const row of queue.data) {
      for (const key of Object.keys(row)) {
        expect(allowed.has(key), `unexpected field "${key}" in review queue`).toBe(true);
      }
    }
  });
});

describe("roster management", () => {
  it("reports zeros for a rostered reviewer who has not reviewed anything", async () => {
    // Reachable because `setPrimaryReviewer` enrols its target — designating
    // someone before they start is the remaining way onto the roster without a
    // review, now that the add-by-email form is gone. The row must survive the
    // LEFT JOIN with zeros rather than vanishing or reporting NaN.
    const { setPrimaryReviewer, getReviewerProgress } = await import(
      "@/app/audio/validacion/actions"
    );
    seedDetections(30);
    const campaignId = await campaignWithSample(10);

    await setPrimaryReviewer(campaignId, GLORIA);
    const progress = await getReviewerProgress(campaignId);
    if (!progress.success) throw new Error(progress.error);

    const gloria = progress.data.find((p) => p.email === GLORIA);
    expect(gloria).toBeDefined();
    expect(gloria?.reviewed).toBe(0);
    expect(gloria?.name).toBe("gloria");
  });

  it("keeps a removed reviewer's recorded reviews", async () => {
    const { recordReview, removeReviewer } = await import(
      "@/app/audio/validacion/actions"
    );
    seedDetections(30);
    const campaignId = await campaignWithSample(10);
    const [sample] = samplesOf(campaignId);

    asUser(GLORIA);
    await recordReview(sample.id, "incorrect");
    asUser(JUAN);
    const removed = await removeReviewer(campaignId, GLORIA);

    expect(removed.success).toBe(true);
    const reviews = db
      .select()
      .from(schema.birdnetValidationReviews)
      .where(eq(schema.birdnetValidationReviews.reviewerEmail, GLORIA))
      .all();
    expect(reviews).toHaveLength(1);
  });

  it("refuses to remove the designated primary reviewer", async () => {
    const { setPrimaryReviewer, removeReviewer } = await import(
      "@/app/audio/validacion/actions"
    );
    seedDetections(30);
    const campaignId = await campaignWithSample(10);

    await setPrimaryReviewer(campaignId, JUAN);
    const result = await removeReviewer(campaignId, JUAN);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("revisor principal");
  });

  it("records a system event when the primary reviewer changes", async () => {
    const { setPrimaryReviewer } = await import("@/app/audio/validacion/actions");
    seedDetections(30);
    const campaignId = await campaignWithSample(10);

    await setPrimaryReviewer(campaignId, JUAN);

    const events = db
      .select()
      .from(schema.systemEvents)
      .where(
        eq(schema.systemEvents.eventType, "birdnet_validation.primary_reviewer_changed")
      )
      .all();
    expect(events).toHaveLength(1);
    expect(events[0].targetId).toBe(String(campaignId));
    expect(events[0].summary).toContain(JUAN);
  });

  it("enrolls the designated primary automatically", async () => {
    const { setPrimaryReviewer } = await import("@/app/audio/validacion/actions");
    seedDetections(30);
    const campaignId = await campaignWithSample(10);

    await setPrimaryReviewer(campaignId, GREGORY);

    const roster = db
      .select()
      .from(schema.birdnetValidationCampaignReviewers)
      .where(
        and(
          eq(schema.birdnetValidationCampaignReviewers.campaignId, campaignId),
          eq(schema.birdnetValidationCampaignReviewers.reviewerEmail, GREGORY)
        )
      )
      .all();
    expect(roster).toHaveLength(1);
  });

  it("orders the roster with the primary first", async () => {
    const { recordReview, setPrimaryReviewer, getReviewerProgress } =
      await import("@/app/audio/validacion/actions");
    seedDetections(40);
    const campaignId = await campaignWithSample(12);
    const samples = samplesOf(campaignId);

    // Gloria reviews more than Juan, but Juan is primary. Both are enrolled by
    // reviewing — there is no other way onto the roster from the UI.
    asUser(GLORIA);
    for (const s of samples.slice(0, 6)) await recordReview(s.id, "correct");
    asUser(JUAN);
    await recordReview(samples[0].id, "correct");
    await setPrimaryReviewer(campaignId, JUAN);

    const progress = await getReviewerProgress(campaignId);
    if (!progress.success) throw new Error(progress.error);
    expect(progress.data[0].email).toBe(JUAN);
    expect(progress.data[0].isPrimary).toBe(true);
    expect(progress.data[1].email).toBe(GLORIA);
  });
});

describe("listCampaigns — index counts under multiple reviewers", () => {
  // The listing builds its counts from a correlated subquery. That shape has
  // silently returned zeros in this codebase before (prod, 2026-06-18) when an
  // outer column rendered unqualified and bound to the inner table, so these
  // assert on real numbers rather than just "no error".
  it("counts the primary's answers, not the sum across reviewers", async () => {
    const { recordReview, setPrimaryReviewer, listCampaigns } = await import(
      "@/app/audio/validacion/actions"
    );
    seedDetections(40);
    const campaignId = await campaignWithSample(10);
    const samples = samplesOf(campaignId);

    asUser(JUAN);
    for (const [i, s] of samples.entries()) {
      await recordReview(s.id, i < 6 ? "correct" : "incorrect");
    }
    asUser(GLORIA);
    for (const s of samples) await recordReview(s.id, "uncertain");
    asUser(JUAN);
    await setPrimaryReviewer(campaignId, JUAN);

    const result = await listCampaigns();
    if (!result.success) throw new Error(result.error);
    const row = result.data.find((c) => c.id === campaignId)!;

    expect(row.sampled).toBe(10);
    expect(row.reviewed).toBe(10); // not 20
    expect(row.correct).toBe(6);
    expect(row.incorrect).toBe(4);
    expect(row.uncertain).toBe(0); // Gloria's answers do not leak in
    expect(row.reviewerCount).toBe(2);
    expect(row.primaryReviewerEmail).toBe(JUAN);
  });

  it("falls back to the sole reviewer when no primary is designated", async () => {
    const { recordReview, listCampaigns } = await import(
      "@/app/audio/validacion/actions"
    );
    seedDetections(40);
    const campaignId = await campaignWithSample(10);
    const samples = samplesOf(campaignId);

    asUser(JUAN);
    for (const s of samples) await recordReview(s.id, "correct");

    const result = await listCampaigns();
    if (!result.success) throw new Error(result.error);
    const row = result.data.find((c) => c.id === campaignId)!;

    expect(row.reviewed).toBe(10);
    expect(row.correct).toBe(10);
    expect(row.reviewerCount).toBe(1);
  });

  it("reports zero reviewed when several reviewers answered with no primary", async () => {
    // Ambiguous, so nothing is counted — and the index shows the warning
    // marker rather than a number that pretends to mean something.
    const { recordReview, listCampaigns } = await import(
      "@/app/audio/validacion/actions"
    );
    seedDetections(40);
    const campaignId = await campaignWithSample(10);
    const samples = samplesOf(campaignId);

    for (const r of [JUAN, GLORIA]) {
      asUser(r);
      for (const s of samples) await recordReview(s.id, "correct");
    }

    const result = await listCampaigns();
    if (!result.success) throw new Error(result.error);
    const row = result.data.find((c) => c.id === campaignId)!;

    expect(row.reviewed).toBe(0);
    expect(row.reviewerCount).toBe(2);
    expect(row.primaryReviewerEmail).toBeNull();
  });
});

describe("getDisagreements", () => {
  it("returns only clips where answers differ, with every reviewer's answer", async () => {
    const { recordReview, getDisagreements } = await import(
      "@/app/audio/validacion/actions"
    );
    seedDetections(40);
    const campaignId = await campaignWithSample(12);
    const samples = samplesOf(campaignId);

    // Clip 0: two agree, one differs -> included.
    asUser(JUAN);
    await recordReview(samples[0].id, "correct");
    asUser(GLORIA);
    await recordReview(samples[0].id, "correct");
    asUser(GREGORY);
    await recordReview(samples[0].id, "incorrect");

    // Clip 1: unanimous -> excluded.
    for (const r of [JUAN, GLORIA, GREGORY]) {
      asUser(r);
      await recordReview(samples[1].id, "correct");
    }

    // Clip 2: only one reviewer -> excluded (nothing to disagree with).
    asUser(JUAN);
    await recordReview(samples[2].id, "incorrect");

    // Clip 3: correct vs uncertain -> included, uncertain is a real answer.
    asUser(JUAN);
    await recordReview(samples[3].id, "correct");
    asUser(GLORIA);
    await recordReview(samples[3].id, "uncertain");

    const result = await getDisagreements(campaignId);
    if (!result.success) throw new Error(result.error);

    const ids = result.data.map((d) => d.sampleId);
    expect(ids).toContain(samples[0].id);
    expect(ids).toContain(samples[3].id);
    expect(ids).not.toContain(samples[1].id);
    expect(ids).not.toContain(samples[2].id);

    const first = result.data.find((d) => d.sampleId === samples[0].id)!;
    expect(first.answers).toHaveLength(3);
    expect(first.answers.map((a) => a.outcome).sort()).toEqual([
      "correct",
      "correct",
      "incorrect",
    ]);
  });

  it("returns an empty list when everyone agrees", async () => {
    const { recordReview, getDisagreements } = await import(
      "@/app/audio/validacion/actions"
    );
    seedDetections(40);
    const campaignId = await campaignWithSample(10);
    const samples = samplesOf(campaignId);

    for (const r of [JUAN, GLORIA]) {
      asUser(r);
      for (const s of samples) await recordReview(s.id, "correct");
    }

    const result = await getDisagreements(campaignId);
    if (!result.success) throw new Error(result.error);
    expect(result.data).toHaveLength(0);
  });
});

describe("getAgreement", () => {
  it("scores each reviewer against the primary over co-reviewed clips", async () => {
    const { recordReview, setPrimaryReviewer, getAgreement } = await import(
      "@/app/audio/validacion/actions"
    );
    seedDetections(40);
    const campaignId = await campaignWithSample(10);
    const samples = samplesOf(campaignId);

    // Juan alternates; Gloria matches him except on the first two clips.
    asUser(JUAN);
    for (const [i, s] of samples.entries()) {
      await recordReview(s.id, i % 2 === 0 ? "correct" : "incorrect");
    }
    asUser(GLORIA);
    for (const [i, s] of samples.entries()) {
      const same = i % 2 === 0 ? "correct" : "incorrect";
      const flipped = i % 2 === 0 ? "incorrect" : "correct";
      await recordReview(s.id, i < 2 ? flipped : same);
    }
    asUser(JUAN);
    await setPrimaryReviewer(campaignId, JUAN);

    const result = await getAgreement(campaignId);
    if (!result.success) throw new Error(result.error);

    expect(result.data).toHaveLength(1);
    expect(result.data[0].email).toBe(GLORIA);
    expect(result.data[0].n).toBe(samples.length);
    expect(result.data[0].agreed).toBe(samples.length - 2);
  });

  it("returns nothing when no primary is designated", async () => {
    const { recordReview, getAgreement } = await import(
      "@/app/audio/validacion/actions"
    );
    seedDetections(40);
    const campaignId = await campaignWithSample(10);
    const samples = samplesOf(campaignId);

    for (const r of [JUAN, GLORIA]) {
      asUser(r);
      for (const s of samples) await recordReview(s.id, "correct");
    }

    const result = await getAgreement(campaignId);
    if (!result.success) throw new Error(result.error);
    expect(result.data).toHaveLength(0);
  });

  it("counts only clips the primary has also reached", async () => {
    const { recordReview, setPrimaryReviewer, getAgreement } = await import(
      "@/app/audio/validacion/actions"
    );
    seedDetections(40);
    const campaignId = await campaignWithSample(10);
    const samples = samplesOf(campaignId);

    // Gloria does all ten; Juan only the first four. A clip Juan has not
    // reached is not a disagreement.
    asUser(GLORIA);
    for (const s of samples) await recordReview(s.id, "correct");
    asUser(JUAN);
    for (const s of samples.slice(0, 4)) await recordReview(s.id, "correct");
    await setPrimaryReviewer(campaignId, JUAN);

    const result = await getAgreement(campaignId);
    if (!result.success) throw new Error(result.error);
    expect(result.data[0].n).toBe(4);
    expect(result.data[0].agreed).toBe(4);
  });
});

describe("fit input selection", () => {
  /** Every reviewer answers every clip. */
  async function fullOverlap(
    campaignId: number,
    reviewers: string[],
    outcomeFor: (reviewer: string, index: number) => "correct" | "incorrect"
  ) {
    const { recordReview } = await import("@/app/audio/validacion/actions");
    const samples = samplesOf(campaignId);
    for (const reviewer of reviewers) {
      asUser(reviewer);
      for (const [i, s] of samples.entries()) {
        await recordReview(s.id, outcomeFor(reviewer, i));
      }
    }
    asUser(JUAN);
    return samples;
  }

  it("sends one observation per clip, not one per review", async () => {
    // The load-bearing test. Pooling would hand R 3x the rows, shrinking the
    // threshold's standard error by ~1/sqrt(3) and reporting an interval far
    // tighter than 30 reviewed clips can support — with no error raised.
    const { runFit, setPrimaryReviewer } = await import(
      "@/app/audio/validacion/actions"
    );
    mockFitThresholds.mockResolvedValue([]);
    seedDetections(80);
    const campaignId = await campaignWithSample(30);
    const samples = await fullOverlap(campaignId, [JUAN, GLORIA, GREGORY], (_r, i) =>
      i % 2 === 0 ? "correct" : "incorrect"
    );
    await setPrimaryReviewer(campaignId, JUAN);

    await runFit(campaignId);

    expect(mockFitThresholds).toHaveBeenCalledTimes(1);
    const requests = mockFitThresholds.mock.calls[0][0];
    expect(requests[0].observations).toHaveLength(samples.length);
  });

  it("uses the primary reviewer's answers, not another reviewer's", async () => {
    const { runFit, setPrimaryReviewer } = await import(
      "@/app/audio/validacion/actions"
    );
    mockFitThresholds.mockResolvedValue([]);
    seedDetections(80);
    const campaignId = await campaignWithSample(30);
    // Juan says everything is correct; Gloria says everything is incorrect.
    await fullOverlap(campaignId, [JUAN, GLORIA], (r) =>
      r === JUAN ? "correct" : "incorrect"
    );
    await setPrimaryReviewer(campaignId, GLORIA);

    await runFit(campaignId);

    const requests = mockFitThresholds.mock.calls[0][0];
    expect(requests[0].observations.every((o: { outcome: number }) => o.outcome === 0)).toBe(
      true
    );
  });

  it("refuses to fit when several reviewers answered and no primary is designated", async () => {
    const { runFit } = await import("@/app/audio/validacion/actions");
    mockFitThresholds.mockResolvedValue([]);
    seedDetections(80);
    const campaignId = await campaignWithSample(30);
    await fullOverlap(campaignId, [JUAN, GLORIA], () => "correct");

    const result = await runFit(campaignId);

    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("revisor principal");
    expect(mockFitThresholds).not.toHaveBeenCalled();
    expect(db.select().from(schema.birdnetSpeciesThresholds).all()).toHaveLength(0);
  });

  it("fits a single reviewer's campaign with no primary designated", async () => {
    const { runFit } = await import("@/app/audio/validacion/actions");
    mockFitThresholds.mockResolvedValue([]);
    seedDetections(80);
    const campaignId = await campaignWithSample(30);
    await fullOverlap(campaignId, [JUAN], (_r, i) =>
      i % 2 === 0 ? "correct" : "incorrect"
    );

    await runFit(campaignId);

    expect(mockFitThresholds).toHaveBeenCalledTimes(1);
    const requests = mockFitThresholds.mock.calls[0][0];
    expect(requests[0].observations).toHaveLength(30);
  });

  it("counts only the primary's answers when a trainee has reviewed more", async () => {
    const { recordReview, runFit, setPrimaryReviewer } = await import(
      "@/app/audio/validacion/actions"
    );
    mockFitThresholds.mockResolvedValue([]);
    seedDetections(80);
    const campaignId = await campaignWithSample(30);
    const samples = samplesOf(campaignId);

    // Gloria does all 30; Juan does 22.
    asUser(GLORIA);
    for (const s of samples) await recordReview(s.id, "correct");
    asUser(JUAN);
    for (const [i, s] of samples.slice(0, 22).entries()) {
      await recordReview(s.id, i % 2 === 0 ? "correct" : "incorrect");
    }
    await setPrimaryReviewer(campaignId, JUAN);

    await runFit(campaignId);

    const requests = mockFitThresholds.mock.calls[0][0];
    expect(requests[0].observations).toHaveLength(22);
  });

  it("excludes the primary's uncertain answers without substituting a trainee's", async () => {
    const { recordReview, runFit, setPrimaryReviewer } = await import(
      "@/app/audio/validacion/actions"
    );
    mockFitThresholds.mockResolvedValue([]);
    seedDetections(80);
    const campaignId = await campaignWithSample(30);
    const samples = samplesOf(campaignId);

    asUser(GLORIA);
    for (const s of samples) await recordReview(s.id, "correct");
    asUser(JUAN);
    for (const [i, s] of samples.entries()) {
      await recordReview(s.id, i < 5 ? "uncertain" : i % 2 === 0 ? "correct" : "incorrect");
    }
    await setPrimaryReviewer(campaignId, JUAN);

    await runFit(campaignId);

    const requests = mockFitThresholds.mock.calls[0][0];
    expect(requests[0].observations).toHaveLength(25);
  });

  it("records the primary reviewer on the persisted threshold", async () => {
    const { runFit, setPrimaryReviewer } = await import(
      "@/app/audio/validacion/actions"
    );
    seedDetections(80);
    const campaignId = await campaignWithSample(30);
    await fullOverlap(campaignId, [JUAN, GLORIA], (_r, i) =>
      i % 2 === 0 ? "correct" : "incorrect"
    );
    await setPrimaryReviewer(campaignId, JUAN);

    mockFitThresholds.mockImplementation((requests: Array<{ campaignId: number }>) =>
      Promise.resolve(
        requests.map((r) => ({
          campaignId: r.campaignId,
          usable: true,
          nReviewed: 30,
          nCorrect: 15,
          intercept: -2,
          slope: 4,
          converged: true,
          thresholds: {
            "0.9": { conf: 0.7, se: 0.02, lower: 0.66, upper: 0.74 },
            "0.95": { conf: 0.8, se: 0.02, lower: 0.76, upper: 0.84 },
            "0.99": { conf: 0.9, se: 0.02, lower: 0.86, upper: 0.94 },
          },
        }))
      )
    );

    await runFit(campaignId);

    const [row] = db.select().from(schema.birdnetSpeciesThresholds).all();
    expect(row.primaryReviewerEmail).toBe(JUAN);
  });
});
