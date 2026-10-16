/**
 * Per-clip reviewer notes: free text on the caller's OWN review of one clip.
 *
 * A note describes the clip, not the verdict, so it survives an answer change;
 * it is one row per (sample, reviewer), so nobody overwrites a colleague's; and
 * on the species page it is blinded like a suggestion, because "no es, es un
 * Turdus" gives the answer away.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { mockRequirePermission, setupAuthMocks, testUser } from "../helpers/mock-auth";
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
  loadSiteHabitatMap: async () => new Map<string, string>(),
}));
vi.mock("@/lib/camera-trap-auth", () => ({
  getUserCameraTrapProjects: vi.fn(async () => "all"),
}));

let db: TestDb;
let campaignId: number;
let sampleA: number;
let sampleB: number;

const SPECIES = "Buteo platypterus";
const JUAN = "juan@fcat-ecuador.org";
const GLORIA = "gloria@fcat-ecuador.org";

function asUser(email: string) {
  mockRequirePermission.mockResolvedValue({ ...testUser, email });
}

function reviewOf(sampleId: number, email: string) {
  return db
    .select()
    .from(schema.birdnetValidationReviews)
    .where(
      and(
        eq(schema.birdnetValidationReviews.sampleId, sampleId),
        eq(schema.birdnetValidationReviews.reviewerEmail, email)
      )
    )
    .all()[0];
}

function seedSample(depId: number, i: number): number {
  const [file] = db
    .insert(schema.audioFiles)
    .values({
      deploymentId: depId,
      filename: `2MM21842_20260130_06000${i}.flac`,
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
      minFreq: 0,
      maxFreq: 15000,
      confidence: 0.5,
    })
    .returning()
    .all();
  const [ident] = db
    .insert(schema.audioIdentifications)
    .values({ audioDetectionId: detection.id, species: SPECIES, confidence: 0.5 })
    .returning()
    .all();
  return db
    .insert(schema.birdnetValidationSamples)
    .values({
      campaignId,
      audioIdentificationId: ident.id,
      confidence: 0.5,
      binIndex: 4,
      orderIndex: i,
      siteName: "CCN-003",
    })
    .returning()
    .all()[0].id;
}

async function actions() {
  return import("@/app/audio/validacion/actions");
}

beforeEach(() => {
  vi.clearAllMocks();
  asUser(JUAN);
  db = createTestDb();
  testDbRef.current = db;

  const projectId = db
    .insert(schema.cameraTrapProjects)
    .values({ name: "BioChoco" })
    .returning()
    .all()[0].id;
  const depId = db
    .insert(schema.deployments)
    .values({
      projectId: "camera-trap",
      name: "CCN-003_V1",
      siteName: "CCN-003",
      status: "scanned",
      cameraTrapProjectId: projectId,
    })
    .returning()
    .all()[0].id;

  campaignId = db
    .insert(schema.birdnetValidationCampaigns)
    .values({ species: SPECIES, seed: 42, createdBy: JUAN, status: "reviewing" })
    .returning()
    .all()[0].id;
  sampleA = seedSample(depId, 0);
  sampleB = seedSample(depId, 1);
});

describe("setReviewNote — writing", () => {
  it("stores a trimmed note on the caller's own review", async () => {
    const { recordReview, setReviewNote } = await actions();
    await recordReview(sampleA, "correct");

    const result = await setReviewNote(sampleA, "  canto con trino final \n");

    expect(result).toEqual({ success: true, data: { note: "canto con trino final" } });
    expect(reviewOf(sampleA, JUAN).notes).toBe("canto con trino final");
  });

  it("clears the note with null or blank text", async () => {
    const { recordReview, setReviewNote } = await actions();
    await recordReview(sampleA, "correct");
    await setReviewNote(sampleA, "alarma");

    expect(await setReviewNote(sampleA, "   ")).toEqual({
      success: true,
      data: { note: null },
    });
    expect(reviewOf(sampleA, JUAN).notes).toBeNull();

    await setReviewNote(sampleA, "alarma");
    await setReviewNote(sampleA, null);
    expect(reviewOf(sampleA, JUAN).notes).toBeNull();
  });

  it("is valid on every outcome, not just incorrect", async () => {
    const { recordReview, setReviewNote } = await actions();
    for (const outcome of ["correct", "incorrect", "uncertain"] as const) {
      await recordReview(sampleA, outcome);
      const result = await setReviewNote(sampleA, `nota ${outcome}`);
      expect(result.success).toBe(true);
    }
  });

  it("does not move the review timestamp", async () => {
    const { recordReview, setReviewNote } = await actions();
    await recordReview(sampleA, "correct");
    const before = reviewOf(sampleA, JUAN).reviewedAt;

    await setReviewNote(sampleA, "dos individuos");
    expect(reviewOf(sampleA, JUAN).reviewedAt).toEqual(before);
  });

  it("leaves a colleague's note on the same clip untouched", async () => {
    const { recordReview, setReviewNote } = await actions();
    asUser(GLORIA);
    await recordReview(sampleA, "incorrect");
    await setReviewNote(sampleA, "es un Turdus");

    asUser(JUAN);
    await recordReview(sampleA, "correct");
    await setReviewNote(sampleA, "canto");

    expect(reviewOf(sampleA, GLORIA).notes).toBe("es un Turdus");
    expect(reviewOf(sampleA, JUAN).notes).toBe("canto");
  });
});

describe("setReviewNote — refusals", () => {
  it("refuses before the caller has answered the clip", async () => {
    const { setReviewNote } = await actions();
    const result = await setReviewNote(sampleA, "canto");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/Primero responde/);
    expect(reviewOf(sampleA, JUAN)).toBeUndefined();
  });

  it("refuses a note over the length limit, in Spanish", async () => {
    const { recordReview, setReviewNote } = await actions();
    const { MAX_REVIEW_NOTE_LENGTH } = await import("@/lib/birdnet-validation/review-notes");
    await recordReview(sampleA, "correct");

    const result = await setReviewNote(sampleA, "a".repeat(MAX_REVIEW_NOTE_LENGTH + 1));
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/supera/);
    expect(reviewOf(sampleA, JUAN).notes).toBeNull();
  });

  it("refuses on an abandoned species", async () => {
    const { recordReview, setReviewNote } = await actions();
    await recordReview(sampleA, "correct");
    db.update(schema.birdnetValidationCampaigns)
      .set({ status: "abandoned" })
      .where(eq(schema.birdnetValidationCampaigns.id, campaignId))
      .run();

    const result = await setReviewNote(sampleA, "canto");
    expect(result.success).toBe(false);
  });

  it("refuses an unknown sample", async () => {
    const { setReviewNote } = await actions();
    const result = await setReviewNote(999_999, "canto");
    expect(result.success).toBe(false);
  });
});

describe("recordReview never touches the note", () => {
  it("keeps the note when the answer changes", async () => {
    // It used to write `notes ?? null` on every answer — a silent erase the
    // moment notes started being sent separately.
    const { recordReview, setReviewNote } = await actions();
    await recordReview(sampleA, "correct");
    await setReviewNote(sampleA, "llamada de contacto");

    await recordReview(sampleA, "incorrect");
    await recordReview(sampleA, "uncertain");

    expect(reviewOf(sampleA, JUAN).notes).toBe("llamada de contacto");
  });
});

describe("getReviewNotes — blinding", () => {
  async function seedColleagueNote() {
    const { recordReview, setReviewNote } = await actions();
    asUser(GLORIA);
    await recordReview(sampleA, "incorrect");
    await setReviewNote(sampleA, "no es, suena a Turdus");
    asUser(JUAN);
  }

  it("withholds a colleague's note on a clip the caller has not answered", async () => {
    await seedColleagueNote();
    const { getReviewNotes } = await actions();

    const result = await getReviewNotes(campaignId);
    expect(result).toEqual({ success: true, data: { notes: [], hidden: 1 } });
  });

  it("shows it once the caller has answered that clip, with its answer", async () => {
    await seedColleagueNote();
    const { getReviewNotes, recordReview } = await actions();
    await recordReview(sampleA, "correct");

    const result = await getReviewNotes(campaignId);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.hidden).toBe(0);
    expect(result.data.notes).toHaveLength(1);
    expect(result.data.notes[0]).toMatchObject({
      sampleId: sampleA,
      reviewerEmail: GLORIA,
      outcome: "incorrect",
      note: "no es, suena a Turdus",
      siteName: "CCN-003",
      recordedAt: "2026-01-30 06:00:10",
    });
  });

  it("answering a DIFFERENT clip does not unblind it", async () => {
    await seedColleagueNote();
    const { getReviewNotes, recordReview } = await actions();
    await recordReview(sampleB, "correct");

    const result = await getReviewNotes(campaignId);
    expect(result).toEqual({ success: true, data: { notes: [], hidden: 1 } });
  });

  it("always shows the writer their own note", async () => {
    await seedColleagueNote();
    asUser(GLORIA);
    const { getReviewNotes } = await actions();

    const result = await getReviewNotes(campaignId);
    expect(result.success && result.data.notes.map((n) => n.note)).toEqual([
      "no es, suena a Turdus",
    ]);
  });

  it("shows every note once the species is past review", async () => {
    await seedColleagueNote();
    db.update(schema.birdnetValidationCampaigns)
      .set({ status: "fitted" })
      .where(eq(schema.birdnetValidationCampaigns.id, campaignId))
      .run();
    const { getReviewNotes } = await actions();

    const result = await getReviewNotes(campaignId);
    expect(result.success && result.data.notes).toHaveLength(1);
    expect(result.success && result.data.hidden).toBe(0);
  });

  it("lists nothing for reviews without a note", async () => {
    const { getReviewNotes, recordReview } = await actions();
    await recordReview(sampleA, "correct");
    const result = await getReviewNotes(campaignId);
    expect(result).toEqual({ success: true, data: { notes: [], hidden: 0 } });
  });
});

describe("the review queue never carries a note", () => {
  it("has no note field in its payload", async () => {
    const { getReviewQueue } = await actions();
    const result = await getReviewQueue(campaignId, 5);
    expect(result.success).toBe(true);
    if (!result.success) return;
    for (const item of result.data) {
      expect(Object.keys(item)).not.toContain("note");
      expect(Object.keys(item)).not.toContain("notes");
    }
  });
});

describe("getDisagreements shows each reviewer's note beside their answer", () => {
  it("attaches the note to the answer that wrote it", async () => {
    const { recordReview, setReviewNote, getDisagreements } = await actions();
    asUser(GLORIA);
    await recordReview(sampleA, "incorrect");
    await setReviewNote(sampleA, "es un Turdus");
    asUser(JUAN);
    await recordReview(sampleA, "correct");

    const result = await getDisagreements(campaignId);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data[0].answers).toEqual([
      expect.objectContaining({ email: GLORIA, outcome: "incorrect", note: "es un Turdus" }),
      expect.objectContaining({ email: JUAN, outcome: "correct", note: null }),
    ]);
  });
});

describe("getMyRecentReviews — the reviewer's own earlier answers for ←", () => {
  it("returns the caller's answers oldest first, with species and note", async () => {
    const { recordReview, setReviewNote, getMyRecentReviews } = await actions();
    await recordReview(sampleA, "correct");
    await setReviewNote(sampleA, "canto");
    // Distinct timestamps: reviewed_at has one-second resolution.
    db.update(schema.birdnetValidationReviews)
      .set({ reviewedAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.birdnetValidationReviews.sampleId, sampleA))
      .run();
    await recordReview(sampleB, "uncertain");

    const result = await getMyRecentReviews(campaignId);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.map((r) => [r.sampleId, r.outcome, r.note])).toEqual([
      [sampleA, "correct", "canto"],
      [sampleB, "uncertain", null],
    ]);
    expect(result.data[0]).toMatchObject({ siteName: "CCN-003", correctedSpecies: null });
  });

  it("never includes a colleague's answers", async () => {
    const { recordReview, setReviewNote, getMyRecentReviews } = await actions();
    asUser(GLORIA);
    await recordReview(sampleA, "incorrect");
    await setReviewNote(sampleA, "es un Turdus");

    asUser(JUAN);
    const result = await getMyRecentReviews(campaignId);
    expect(result).toEqual({ success: true, data: [] });
  });

  it("keeps only the most recent when limited", async () => {
    const { recordReview, getMyRecentReviews } = await actions();
    await recordReview(sampleA, "correct");
    db.update(schema.birdnetValidationReviews)
      .set({ reviewedAt: new Date(Date.now() - 60_000) })
      .where(eq(schema.birdnetValidationReviews.sampleId, sampleA))
      .run();
    await recordReview(sampleB, "correct");

    const result = await getMyRecentReviews(campaignId, 1);
    expect(result.success && result.data.map((r) => r.sampleId)).toEqual([sampleB]);
  });
});
