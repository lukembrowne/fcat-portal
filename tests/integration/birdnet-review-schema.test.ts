/**
 * Schema-level guarantees for multi-reviewer validation.
 *
 * These assert on the database constraints rather than on application code,
 * because the constraints are the design: `UNIQUE(sample_id, reviewer_email)`
 * is what makes "reviewer B silently overwrites reviewer A" unrepresentable,
 * and the `outcome` CHECK lives only in the raw DDL (Drizzle's `text({ enum })`
 * is TypeScript-only, so a bad value passes types and tests and then throws
 * SQLITE_CONSTRAINT_CHECK in production).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, type TestDb } from "../helpers/test-db";

let db: TestDb;
let campaignId: number;
let sampleId: number;

const ALICE = "alice@fcat-ecuador.org";
const BOB = "bob@fcat-ecuador.org";

beforeEach(() => {
  db = createTestDb();

  const [campaign] = db
    .insert(schema.birdnetValidationCampaigns)
    .values({ species: "Ramphastos ambiguus", seed: 42, createdBy: ALICE })
    .returning()
    .all();
  campaignId = campaign.id;

  const [deployment] = db
    .insert(schema.deployments)
    .values({ projectId: "camera-trap", name: "VAL-000", status: "scanned" })
    .returning()
    .all();
  const [file] = db
    .insert(schema.audioFiles)
    .values({
      deploymentId: deployment.id,
      filename: "a.flac",
      driveFileId: "drive-a",
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
      confidence: 0.8,
    })
    .returning()
    .all();
  const [identification] = db
    .insert(schema.audioIdentifications)
    .values({
      audioDetectionId: detection.id,
      species: "Ramphastos ambiguus",
      confidence: 0.8,
    })
    .returning()
    .all();

  const [sample] = db
    .insert(schema.birdnetValidationSamples)
    .values({
      campaignId,
      audioIdentificationId: identification.id,
      confidence: 0.8,
      binIndex: 6,
      orderIndex: 0,
    })
    .returning()
    .all();
  sampleId = sample.id;
});

function review(reviewer: string, outcome: string) {
  return db
    .insert(schema.birdnetValidationReviews)
    .values({
      sampleId,
      reviewerEmail: reviewer,
      outcome: outcome as "correct" | "incorrect" | "uncertain",
    })
    .run();
}

describe("birdnet_validation_reviews constraints", () => {
  it("keeps one row per reviewer for the same clip", () => {
    review(ALICE, "correct");
    review(BOB, "incorrect");

    const rows = db
      .select()
      .from(schema.birdnetValidationReviews)
      .where(eq(schema.birdnetValidationReviews.sampleId, sampleId))
      .all();

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.reviewerEmail).sort()).toEqual([ALICE, BOB]);
    // Neither answer was displaced by the other.
    expect(rows.find((r) => r.reviewerEmail === ALICE)?.outcome).toBe("correct");
    expect(rows.find((r) => r.reviewerEmail === BOB)?.outcome).toBe("incorrect");
  });

  it("rejects a second row for the same (clip, reviewer)", () => {
    review(ALICE, "correct");
    expect(() => review(ALICE, "incorrect")).toThrow(/UNIQUE/i);
  });

  it("rejects an outcome outside the enum at the database layer", () => {
    // Not merely a TypeScript error — the CHECK has to exist in the DDL.
    expect(() => review(ALICE, "maybe")).toThrow(/CHECK/i);
  });

  it("cascades reviews when the sample is deleted", () => {
    review(ALICE, "correct");
    db.delete(schema.birdnetValidationSamples)
      .where(eq(schema.birdnetValidationSamples.id, sampleId))
      .run();

    expect(db.select().from(schema.birdnetValidationReviews).all()).toHaveLength(0);
  });

  it("cascades samples, reviews, and roster when the campaign is deleted", () => {
    review(ALICE, "correct");
    db.insert(schema.birdnetValidationCampaignReviewers)
      .values({ campaignId, reviewerEmail: ALICE, addedBy: ALICE })
      .run();

    db.delete(schema.birdnetValidationCampaigns)
      .where(eq(schema.birdnetValidationCampaigns.id, campaignId))
      .run();

    expect(db.select().from(schema.birdnetValidationSamples).all()).toHaveLength(0);
    expect(db.select().from(schema.birdnetValidationReviews).all()).toHaveLength(0);
    expect(
      db.select().from(schema.birdnetValidationCampaignReviewers).all()
    ).toHaveLength(0);
  });
});

describe("birdnet_validation_campaign_reviewers constraints", () => {
  it("rejects enrolling the same reviewer twice", () => {
    db.insert(schema.birdnetValidationCampaignReviewers)
      .values({ campaignId, reviewerEmail: ALICE, addedBy: ALICE })
      .run();

    expect(() =>
      db
        .insert(schema.birdnetValidationCampaignReviewers)
        .values({ campaignId, reviewerEmail: ALICE, addedBy: BOB })
        .run()
    ).toThrow(/UNIQUE/i);
  });
});

describe("fit provenance columns", () => {
  it("records which reviewer's answers a threshold was fitted from", () => {
    db.insert(schema.birdnetSpeciesThresholds)
      .values({
        campaignId,
        species: "Ramphastos ambiguus",
        nReviewed: 200,
        nCorrect: 150,
        primaryReviewerEmail: ALICE,
      })
      .run();

    const [row] = db.select().from(schema.birdnetSpeciesThresholds).all();
    expect(row.primaryReviewerEmail).toBe(ALICE);
  });

  it("stores the campaign's designated primary reviewer", () => {
    db.update(schema.birdnetValidationCampaigns)
      .set({ primaryReviewerEmail: BOB })
      .where(eq(schema.birdnetValidationCampaigns.id, campaignId))
      .run();

    const [row] = db.select().from(schema.birdnetValidationCampaigns).all();
    expect(row.primaryReviewerEmail).toBe(BOB);
  });
});
