/**
 * Reviewer corrections: "this clip was not X, it was Y".
 *
 * The correction lives on the reviewer's OWN review row, is only ever carried
 * by an `incorrect` answer, and is resolved server-side against BirdNET's
 * label list so no free text reaches the record. The picker list is the same
 * vocabulary, with species already detected in the caller's projects first.
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
vi.mock("@/lib/habitat-lookup", () => ({
  loadSiteHabitatMap: async () => new Map<string, string>(),
}));

const mockCtProjects = vi.fn();
vi.mock("@/lib/camera-trap-auth", () => ({
  getUserCameraTrapProjects: () => mockCtProjects(),
}));

let db: TestDb;
let campaignId: number;
let sampleId: number;
let projectA: number;
let projectB: number;

const SPECIES = "Buteo platypterus";
const SPARROW = "Zonotrichia albicollis";
const JUAN = "juan@fcat-ecuador.org";
const GLORIA = "gloria@fcat-ecuador.org";
const PEDRO = "pedro@fcat-ecuador.org";

function asUser(email: string) {
  mockRequirePermission.mockResolvedValue({ ...testUser, email });
}

function seedIdentification(
  deploymentId: number,
  species: string,
  i: number
): number {
  const [file] = db
    .insert(schema.audioFiles)
    .values({
      deploymentId,
      filename: `f-${species}-${i}.flac`,
      driveFileId: `drive-${species}-${i}`,
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
  const [identification] = db
    .insert(schema.audioIdentifications)
    .values({ audioDetectionId: detection.id, species, confidence: 0.5 })
    .returning()
    .all();
  return identification.id;
}

function reviewOf(email: string) {
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

async function actions() {
  return import("@/app/audio/validacion/actions");
}

beforeEach(async () => {
  vi.clearAllMocks();
  const { __resetDetectedSpeciesCache } = await import(
    "@/lib/birdnet-validation/ttl-cache"
  );
  __resetDetectedSpeciesCache();
  asUser(JUAN);
  mockCtProjects.mockResolvedValue("all");

  db = createTestDb();
  testDbRef.current = db;

  [projectA, projectB] = ["A", "B"].map(
    (name) =>
      db
        .insert(schema.cameraTrapProjects)
        .values({ name: `Proj-${name}` })
        .returning()
        .all()[0].id
  );
  const [depA, depB] = [projectA, projectB].map(
    (pid, i) =>
      db
        .insert(schema.deployments)
        .values({
          projectId: "camera-trap",
          name: `DEP-${i}`,
          siteName: `DEP-${i}`,
          status: "scanned",
          cameraTrapProjectId: pid,
        })
        .returning()
        .all()[0].id
  );

  const identId = seedIdentification(depA, SPECIES, 0);
  // Picker ranking fixtures: two detected species in A, one only in B.
  seedIdentification(depA, "Turdus fuscater", 1);
  seedIdentification(depA, SPECIES, 2);
  seedIdentification(depB, SPARROW, 3);
  // A non-species label that is detected must still be excluded.
  seedIdentification(depA, "Dog", 4);

  const [campaign] = db
    .insert(schema.birdnetValidationCampaigns)
    .values({ species: SPECIES, seed: 42, createdBy: JUAN, status: "sampled" })
    .returning()
    .all();
  campaignId = campaign.id;

  const [sample] = db
    .insert(schema.birdnetValidationSamples)
    .values({
      campaignId,
      audioIdentificationId: identId,
      confidence: 0.5,
      binIndex: 4,
      orderIndex: 0,
    })
    .returning()
    .all();
  sampleId = sample.id;
});

describe("setReviewCorrection — writing", () => {
  it("stores the canonical scientific name on the caller's incorrect review", async () => {
    const { recordReview, setReviewCorrection } = await actions();
    await recordReview(sampleId, "incorrect");

    const result = await setReviewCorrection(sampleId, SPARROW);

    expect(result).toEqual({ success: true, data: { correctedSpecies: SPARROW } });
    expect(reviewOf(JUAN).correctedSpecies).toBe(SPARROW);
  });

  it("canonicalises case and whitespace, but never guesses", async () => {
    const { recordReview, setReviewCorrection } = await actions();
    await recordReview(sampleId, "incorrect");

    const result = await setReviewCorrection(sampleId, "  zonotrichia   ALBICOLLIS ");
    expect(result.success).toBe(true);
    expect(reviewOf(JUAN).correctedSpecies).toBe(SPARROW);
  });

  it("clears the correction with null", async () => {
    const { recordReview, setReviewCorrection } = await actions();
    await recordReview(sampleId, "incorrect");
    await setReviewCorrection(sampleId, SPARROW);

    const result = await setReviewCorrection(sampleId, null);

    expect(result).toEqual({ success: true, data: { correctedSpecies: null } });
    expect(reviewOf(JUAN).correctedSpecies).toBeNull();
  });

  it("does not move the review timestamp", async () => {
    const { recordReview, setReviewCorrection } = await actions();
    await recordReview(sampleId, "incorrect");
    const before = reviewOf(JUAN).reviewedAt;

    await setReviewCorrection(sampleId, SPARROW);
    expect(reviewOf(JUAN).reviewedAt).toEqual(before);
  });
});

describe("setReviewCorrection — refusals", () => {
  it("rejects a misspelled name with a Spanish error", async () => {
    const { recordReview, setReviewCorrection } = await actions();
    await recordReview(sampleId, "incorrect");

    const result = await setReviewCorrection(sampleId, "Zonotrichia albicolis");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/no está en la lista/);
    expect(reviewOf(JUAN).correctedSpecies).toBeNull();
  });

  it.each(["Dog", "Human vocal", "Engine", "Noise"])(
    "rejects the non-species label %s",
    async (label) => {
      const { recordReview, setReviewCorrection } = await actions();
      await recordReview(sampleId, "incorrect");

      const result = await setReviewCorrection(sampleId, label);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/no es una especie/);
      expect(reviewOf(JUAN).correctedSpecies).toBeNull();
    }
  );

  it("rejects an empty string", async () => {
    const { recordReview, setReviewCorrection } = await actions();
    await recordReview(sampleId, "incorrect");

    const result = await setReviewCorrection(sampleId, "   ");
    expect(result.success).toBe(false);
  });

  it("rejects the campaign's own species", async () => {
    const { recordReview, setReviewCorrection } = await actions();
    await recordReview(sampleId, "incorrect");

    const result = await setReviewCorrection(sampleId, SPECIES);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/misma que se está validando/);
    expect(reviewOf(JUAN).correctedSpecies).toBeNull();
  });

  it("refuses when the caller has not reviewed the sample", async () => {
    const { setReviewCorrection } = await actions();
    const result = await setReviewCorrection(sampleId, SPARROW);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/Primero responde/);
    expect(reviewOf(JUAN)).toBeUndefined();
  });

  it("refuses when another reviewer's review exists but not the caller's", async () => {
    const { recordReview, setReviewCorrection } = await actions();
    asUser(GLORIA);
    await recordReview(sampleId, "incorrect");

    asUser(JUAN);
    const result = await setReviewCorrection(sampleId, SPARROW);
    expect(result.success).toBe(false);
    expect(reviewOf(GLORIA).correctedSpecies).toBeNull();
  });

  it.each(["correct", "uncertain"] as const)(
    "refuses when the caller's own answer is %s",
    async (outcome) => {
      const { recordReview, setReviewCorrection } = await actions();
      await recordReview(sampleId, outcome);

      const result = await setReviewCorrection(sampleId, SPARROW);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error).toMatch(/marcada como incorrecta/);
      expect(reviewOf(JUAN).correctedSpecies).toBeNull();
    }
  );

  it("refuses on an abandoned campaign, as recordReview does", async () => {
    const { recordReview, setReviewCorrection } = await actions();
    await recordReview(sampleId, "incorrect");
    db.update(schema.birdnetValidationCampaigns)
      .set({ status: "abandoned" })
      .where(eq(schema.birdnetValidationCampaigns.id, campaignId))
      .run();

    const result = await setReviewCorrection(sampleId, SPARROW);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toMatch(/descartada/);
    expect(reviewOf(JUAN).correctedSpecies).toBeNull();
  });

  it("refuses an unknown sample", async () => {
    const { setReviewCorrection } = await actions();
    const result = await setReviewCorrection(sampleId + 999, SPARROW);
    expect(result.success).toBe(false);
  });
});

describe("per-reviewer isolation", () => {
  it("leaves reviewer A's correction untouched when B reviews and corrects", async () => {
    const { recordReview, setReviewCorrection } = await actions();
    asUser(JUAN);
    await recordReview(sampleId, "incorrect");
    await setReviewCorrection(sampleId, SPARROW);

    asUser(GLORIA);
    await recordReview(sampleId, "incorrect");
    await setReviewCorrection(sampleId, "Turdus fuscater");
    await recordReview(sampleId, "correct");

    expect(reviewOf(JUAN).correctedSpecies).toBe(SPARROW);
    expect(reviewOf(JUAN).outcome).toBe("incorrect");
    expect(reviewOf(GLORIA).correctedSpecies).toBeNull();
  });
});

describe("recordReview keeps the correction tied to an incorrect answer", () => {
  it.each(["correct", "uncertain"] as const)(
    "clears the correction when the answer changes to %s",
    async (outcome) => {
      const { recordReview, setReviewCorrection } = await actions();
      await recordReview(sampleId, "incorrect");
      await setReviewCorrection(sampleId, SPARROW);

      await recordReview(sampleId, outcome);
      expect(reviewOf(JUAN).correctedSpecies).toBeNull();
    }
  );

  it("preserves the correction when incorrect is re-submitted unchanged", async () => {
    const { recordReview, setReviewCorrection } = await actions();
    await recordReview(sampleId, "incorrect");
    await setReviewCorrection(sampleId, SPARROW);

    await recordReview(sampleId, "incorrect");
    expect(reviewOf(JUAN).correctedSpecies).toBe(SPARROW);

    // With notes, the row IS rewritten — the correction must still survive.
    await recordReview(sampleId, "incorrect", "canto de fondo");
    expect(reviewOf(JUAN).correctedSpecies).toBe(SPARROW);
  });
});

describe("blinding", () => {
  it("never sends a correction to the review client", async () => {
    const { recordReview, setReviewCorrection, getReviewQueue } = await actions();
    asUser(JUAN);
    await recordReview(sampleId, "incorrect");
    await setReviewCorrection(sampleId, SPARROW);

    asUser(GLORIA);
    const queue = await getReviewQueue(campaignId);
    if (!queue.success) throw new Error(queue.error);
    expect(queue.data.length).toBeGreaterThan(0);
    expect(JSON.stringify(queue.data)).not.toContain(SPARROW);
    for (const row of queue.data) {
      expect(row).not.toHaveProperty("correctedSpecies");
    }
  });
});

describe("listCorrectionSpecies", () => {
  it("ranks species detected in the caller's projects first, most detected first", async () => {
    const { listCorrectionSpecies } = await actions();
    mockCtProjects.mockResolvedValue([projectA]);

    const result = await listCorrectionSpecies();
    if (!result.success) throw new Error(result.error);

    expect(result.data.detected.map((o) => o[0])).toEqual([
      SPECIES, // 2 detections in A
      "Turdus fuscater", // 1
    ]);
    // Detected only in an inaccessible project: listed, but not ranked first.
    expect(result.data.detected.map((o) => o[0])).not.toContain(SPARROW);
    expect(result.data.others.map((o) => o[0])).toContain(SPARROW);
  });

  it("carries scientific, English and Spanish names as a compact tuple", async () => {
    const { listCorrectionSpecies } = await actions();
    const result = await listCorrectionSpecies();
    if (!result.success) throw new Error(result.error);

    const all = [...result.data.detected, ...result.data.others];
    const sparrow = all.find((o) => o[0] === SPARROW);
    expect(sparrow).toEqual([SPARROW, "White-throated Sparrow", "Chingolo Gorjiblanco"]);
    // The full BirdNET vocabulary, not just what has been detected.
    expect(all.length).toBeGreaterThan(5000);
    // No label appears twice.
    expect(new Set(all.map((o) => o[0])).size).toBe(all.length);
  });

  it("excludes non-species labels even when they were detected", async () => {
    const { listCorrectionSpecies } = await actions();
    const result = await listCorrectionSpecies();
    if (!result.success) throw new Error(result.error);

    const names = [...result.data.detected, ...result.data.others].map((o) =>
      o[0].toLowerCase()
    );
    for (const label of ["dog", "engine", "noise", "human vocal", "siren", "gun"]) {
      expect(names).not.toContain(label);
    }
  });

  it("reuses the detected ranking per project scope instead of re-counting", async () => {
    const { listCorrectionSpecies } = await actions();
    mockCtProjects.mockResolvedValue([projectA]);
    const first = await listCorrectionSpecies();
    if (!first.success) throw new Error(first.error);
    expect(first.data.detected.map((o) => o[0])).not.toContain(SPARROW);

    // New detections in A: within the TTL the cached ranking is served.
    const depA = db
      .select()
      .from(schema.deployments)
      .where(eq(schema.deployments.cameraTrapProjectId, projectA))
      .all()[0].id;
    seedIdentification(depA, SPARROW, 90);
    const cached = await listCorrectionSpecies();
    if (!cached.success) throw new Error(cached.error);
    expect(cached.data.detected.map((o) => o[0])).not.toContain(SPARROW);

    // A different scope is its own entry and sees the fresh counts.
    mockCtProjects.mockResolvedValue([projectB, projectA]);
    const other = await listCorrectionSpecies();
    if (!other.success) throw new Error(other.error);
    expect(other.data.detected.map((o) => o[0])).toContain(SPARROW);

    // And after a reset, A recounts.
    const { __resetDetectedSpeciesCache } = await import(
      "@/lib/birdnet-validation/ttl-cache"
    );
    __resetDetectedSpeciesCache();
    mockCtProjects.mockResolvedValue([projectA]);
    const fresh = await listCorrectionSpecies();
    if (!fresh.success) throw new Error(fresh.error);
    expect(fresh.data.detected.map((o) => o[0])).toContain(SPARROW);
  });

  it("sorts the remainder alphabetically", async () => {
    const { listCorrectionSpecies } = await actions();
    const result = await listCorrectionSpecies();
    if (!result.success) throw new Error(result.error);

    const others = result.data.others.map((o) => o[0]);
    expect(others).toEqual([...others].sort((a, b) => a.localeCompare(b)));
  });
});

describe("reviewer suggestions on the attributed species' page", () => {
  function setSite(name: string) {
    db.update(schema.birdnetValidationSamples)
      .set({ siteName: name })
      .where(eq(schema.birdnetValidationSamples.id, sampleId))
      .run();
  }

  async function correct(email: string, species: string | null) {
    const { recordReview, setReviewCorrection } = await actions();
    asUser(email);
    await recordReview(sampleId, "incorrect");
    const result = await setReviewCorrection(sampleId, species);
    if (!result.success) throw new Error(result.error);
  }

  it("lists a correction on the attributed species with its source species and site", async () => {
    setSite("CCN-003");
    await correct(JUAN, SPARROW);

    const { getSpeciesSuggestions } = await actions();
    const result = await getSpeciesSuggestions(SPARROW);
    if (!result.success) throw new Error(result.error);

    expect(result.data.suggestions).toHaveLength(1);
    expect(result.data.suggestions[0]).toMatchObject({
      sampleId,
      sourceSpecies: SPECIES,
      siteName: "CCN-003",
      reviewerEmail: JUAN,
    });
    // Source species' names come along for display.
    expect(result.data.suggestions[0].sourceCommonName).toBe("Broad-winged Hawk");
    expect(() => new Date(result.data.suggestions[0].reviewedAt).toISOString()).not.toThrow();
  });

  it("is absent from the attributed species' own progress and fit-eligible reviews", async () => {
    await correct(JUAN, SPARROW);

    // The attributed species has its own validation, with its own sample.
    const sparrowIdent = db
      .select()
      .from(schema.audioIdentifications)
      .where(eq(schema.audioIdentifications.species, SPARROW))
      .all()[0];
    const [sparrowCampaign] = db
      .insert(schema.birdnetValidationCampaigns)
      .values({ species: SPARROW, seed: 7, createdBy: JUAN, status: "sampled" })
      .returning()
      .all();
    db.insert(schema.birdnetValidationSamples)
      .values({
        campaignId: sparrowCampaign.id,
        audioIdentificationId: sparrowIdent.id,
        confidence: 0.4,
        binIndex: 3,
        orderIndex: 0,
      })
      .run();

    const { getCampaignProgress } = await actions();
    const progress = await getCampaignProgress(sparrowCampaign.id);
    if (!progress.success) throw new Error(progress.error);
    expect(progress.data.sampled).toBe(1);
    expect(progress.data.reviewed).toBe(0);
    expect(progress.data.incorrect).toBe(0);
    expect(progress.data.sites.reduce((n, s) => n + s.reviewed, 0)).toBe(0);
    expect(progress.data.bins.reduce((n, b) => n + b.reviewed, 0)).toBe(0);

    const { resolveFitEligibleReviews } = await import(
      "@/lib/birdnet-validation/fit-eligibility"
    );
    const eligible = await resolveFitEligibleReviews(sparrowCampaign.id);
    expect(eligible.ok).toBe(false);
  });

  it("shows two reviewers' corrections of the same clip once per reviewer", async () => {
    await correct(JUAN, SPARROW);
    await correct(GLORIA, SPARROW);

    const { getSpeciesSuggestions, listSuggestionCounts } = await actions();
    const result = await getSpeciesSuggestions(SPARROW);
    if (!result.success) throw new Error(result.error);
    expect(result.data.suggestions.map((r) => r.reviewerEmail).sort()).toEqual([GLORIA, JUAN].sort());
    expect(new Set(result.data.suggestions.map((r) => r.reviewId)).size).toBe(2);

    const counts = await listSuggestionCounts();
    if (!counts.success) throw new Error(counts.error);
    expect(counts.data.find((c) => c.species === SPARROW)).toMatchObject({
      suggestions: 2,
      clips: 1,
    });
  });

  it("still appears when another reviewer marked the same clip correct", async () => {
    await correct(JUAN, SPARROW);
    const { recordReview, getSpeciesSuggestions } = await actions();
    asUser(GLORIA);
    await recordReview(sampleId, "correct");

    const result = await getSpeciesSuggestions(SPARROW);
    if (!result.success) throw new Error(result.error);
    expect(result.data.suggestions.map((r) => r.reviewerEmail)).toEqual([JUAN]);
  });

  it("disappears when the correction is cleared", async () => {
    await correct(JUAN, SPARROW);
    await correct(JUAN, null);

    const { getSpeciesSuggestions, listSuggestionCounts } = await actions();
    const result = await getSpeciesSuggestions(SPARROW);
    if (!result.success) throw new Error(result.error);
    expect(result.data.suggestions).toEqual([]);

    const counts = await listSuggestionCounts();
    if (!counts.success) throw new Error(counts.error);
    expect(counts.data.find((c) => c.species === SPARROW)).toBeUndefined();
  });

  it("disappears when the reviewer changes the answer away from incorrect", async () => {
    await correct(JUAN, SPARROW);
    const { recordReview, getSpeciesSuggestions } = await actions();
    asUser(JUAN);
    await recordReview(sampleId, "uncertain");

    const result = await getSpeciesSuggestions(SPARROW);
    if (!result.success) throw new Error(result.error);
    expect(result.data.suggestions).toEqual([]);
  });

  it("counts a species with no validation, with names for the table", async () => {
    await correct(JUAN, "Turdus fuscater");

    const campaigns = db.select().from(schema.birdnetValidationCampaigns).all();
    expect(campaigns.map((c) => c.species)).not.toContain("Turdus fuscater");

    const { listSuggestionCounts, getSpeciesSuggestions } = await actions();
    const counts = await listSuggestionCounts();
    if (!counts.success) throw new Error(counts.error);
    const turdus = counts.data.find((c) => c.species === "Turdus fuscater");
    expect(turdus).toMatchObject({ suggestions: 1, clips: 1 });
    expect(turdus!.commonName).toBeTruthy();

    // The slug page's suggestions-only view reads the same list.
    const list = await getSpeciesSuggestions("Turdus fuscater");
    if (!list.success) throw new Error(list.error);
    expect(list.data.suggestions).toHaveLength(1);
  });

  it("excludes clips from projects the caller cannot access", async () => {
    await correct(JUAN, SPARROW);
    const { getSpeciesSuggestions, listSuggestionCounts } = await actions();

    // The sample's recording sits in project A.
    mockCtProjects.mockResolvedValue([projectB]);
    const hidden = await getSpeciesSuggestions(SPARROW);
    if (!hidden.success) throw new Error(hidden.error);
    expect(hidden.data.suggestions).toEqual([]);
    const counts = await listSuggestionCounts();
    if (!counts.success) throw new Error(counts.error);
    expect(counts.data).toEqual([]);

    mockCtProjects.mockResolvedValue([projectA]);
    const visible = await getSpeciesSuggestions(SPARROW);
    if (!visible.success) throw new Error(visible.error);
    expect(visible.data.suggestions).toHaveLength(1);
  });

  it("returns nothing for a species nobody has named", async () => {
    await correct(JUAN, SPARROW);
    const { getSpeciesSuggestions } = await actions();
    const result = await getSpeciesSuggestions("Turdus fuscater");
    if (!result.success) throw new Error(result.error);
    expect(result.data.suggestions).toEqual([]);
  });

  it("keeps a recording with no deployment row for an unscoped caller only", async () => {
    // `audio_files.deployment_id` is NOT NULL with a cascading FK today, so the
    // realistic shape of "no deployment" is an orphaned id from before FK
    // enforcement (or a manual import). An INNER JOIN dropped it even for 'all'.
    await correct(JUAN, SPARROW);
    const fileId = db
      .select({ id: schema.audioFiles.id })
      .from(schema.birdnetValidationSamples)
      .innerJoin(
        schema.audioIdentifications,
        eq(schema.audioIdentifications.id, schema.birdnetValidationSamples.audioIdentificationId)
      )
      .innerJoin(
        schema.audioDetections,
        eq(schema.audioDetections.id, schema.audioIdentifications.audioDetectionId)
      )
      .innerJoin(schema.audioFiles, eq(schema.audioFiles.id, schema.audioDetections.audioFileId))
      .where(eq(schema.birdnetValidationSamples.id, sampleId))
      .all()[0].id;
    db.$client.pragma("foreign_keys = OFF");
    db.update(schema.audioFiles)
      .set({ deploymentId: 999_999 })
      .where(eq(schema.audioFiles.id, fileId))
      .run();
    db.$client.pragma("foreign_keys = ON");

    const { getSpeciesSuggestions, listSuggestionCounts } = await actions();
    asUser(JUAN);
    mockCtProjects.mockResolvedValue("all");
    const all = await getSpeciesSuggestions(SPARROW);
    if (!all.success) throw new Error(all.error);
    expect(all.data.suggestions).toHaveLength(1);
    const allCounts = await listSuggestionCounts();
    if (!allCounts.success) throw new Error(allCounts.error);
    expect(allCounts.data.find((c) => c.species === SPARROW)).toMatchObject({
      suggestions: 1,
    });

    mockCtProjects.mockResolvedValue([projectA, projectB]);
    const scoped = await getSpeciesSuggestions(SPARROW);
    if (!scoped.success) throw new Error(scoped.error);
    expect(scoped.data).toEqual({ suggestions: [], hidden: 0 });
    const scopedCounts = await listSuggestionCounts();
    if (!scopedCounts.success) throw new Error(scopedCounts.error);
    expect(scopedCounts.data).toEqual([]);
  });
});

describe("suggestion blinding", () => {
  async function juanSuggestsSparrow() {
    const { recordReview, setReviewCorrection } = await actions();
    asUser(JUAN);
    await recordReview(sampleId, "incorrect");
    const r = await setReviewCorrection(sampleId, SPARROW);
    if (!r.success) throw new Error(r.error);
    // Gloria is on the roster for the source species but has not judged the clip.
    db.insert(schema.birdnetValidationCampaignReviewers)
      .values({ campaignId, reviewerEmail: GLORIA, addedBy: JUAN })
      .run();
  }

  async function suggestionsAs(email: string) {
    const { getSpeciesSuggestions } = await actions();
    asUser(email);
    const result = await getSpeciesSuggestions(SPARROW);
    if (!result.success) throw new Error(result.error);
    return result.data;
  }

  function setStatus(status: string) {
    db.update(schema.birdnetValidationCampaigns)
      .set({ status: status as "reviewing" })
      .where(eq(schema.birdnetValidationCampaigns.id, campaignId))
      .run();
  }

  it("withholds the row from a rostered colleague who has not reviewed the clip", async () => {
    await juanSuggestsSparrow();

    const data = await suggestionsAs(GLORIA);
    expect(data.suggestions).toEqual([]);
    expect(data.hidden).toBe(1);
    // Not merely unrendered: nothing identifying reaches the payload.
    const payload = JSON.stringify(data);
    expect(payload).not.toContain(JUAN);
    expect(payload).not.toContain(SPECIES);
    expect(data).toEqual({ suggestions: [], hidden: 1 });
  });

  it("shows the row once the colleague has reviewed that clip", async () => {
    await juanSuggestsSparrow();
    const { recordReview } = await actions();
    asUser(GLORIA);
    await recordReview(sampleId, "correct");

    const data = await suggestionsAs(GLORIA);
    expect(data.suggestions.map((r) => r.reviewerEmail)).toEqual([JUAN]);
    expect(data.hidden).toBe(0);
  });

  it("always shows the suggester their own suggestion", async () => {
    await juanSuggestsSparrow();
    const data = await suggestionsAs(JUAN);
    expect(data.suggestions).toHaveLength(1);
    expect(data.hidden).toBe(0);
  });

  it.each(["draft", "sampled", "reviewing"])(
    "keeps withholding while the source species is %s",
    async (status) => {
      await juanSuggestsSparrow();
      setStatus(status);
      expect((await suggestionsAs(PEDRO)).hidden).toBe(1);
    }
  );

  it.each(["fitted", "unusable", "applied", "abandoned"])(
    "shows everyone the row once the source species is %s",
    async (status) => {
      await juanSuggestsSparrow();
      setStatus(status);
      const data = await suggestionsAs(PEDRO);
      expect(data.suggestions).toHaveLength(1);
      expect(data.hidden).toBe(0);
      expect((await suggestionsAs(GLORIA)).suggestions).toHaveLength(1);
    }
  );

  it("still counts the withheld suggestion on the species table", async () => {
    await juanSuggestsSparrow();
    const { listSuggestionCounts } = await actions();
    asUser(GLORIA);
    const counts = await listSuggestionCounts();
    if (!counts.success) throw new Error(counts.error);
    expect(counts.data.find((c) => c.species === SPARROW)).toMatchObject({
      suggestions: 1,
      clips: 1,
    });
  });
});

describe("suggestions-only page: can the species be added?", () => {
  it("counts drawable detections within the caller's project scope only", async () => {
    const { countDrawableDetections } = await actions();

    mockCtProjects.mockResolvedValue([projectA]);
    // Sparrow's only detection is in project B: a draw from A would fail.
    expect(await countDrawableDetections(SPARROW)).toEqual({ success: true, data: 0 });
    expect(await countDrawableDetections("Turdus fuscater")).toEqual({
      success: true,
      data: 1,
    });

    mockCtProjects.mockResolvedValue([projectB]);
    expect(await countDrawableDetections(SPARROW)).toEqual({ success: true, data: 1 });

    // A species BirdNET never predicted anywhere.
    mockCtProjects.mockResolvedValue("all");
    expect(await countDrawableDetections("Catharus ustulatus")).toEqual({
      success: true,
      data: 0,
    });
  });

  it("disables 'Añadir especie' with a Spanish reason when there is nothing to draw", async () => {
    const { addSuggestedSpeciesState } = await import(
      "@/app/audio/validacion/[slug]/add-suggested-species-state"
    );
    expect(addSuggestedSpeciesState(false, 10)).toEqual({ kind: "hidden" });
    expect(addSuggestedSpeciesState(true, 3)).toEqual({ kind: "enabled" });
    const disabled = addSuggestedSpeciesState(true, 0);
    expect(disabled.kind).toBe("disabled");
    if (disabled.kind === "disabled") expect(disabled.reason).toMatch(/No se puede añadir/);
  });
});

describe("species slug resolution for reviewer-only names", () => {
  // Catharus ustulatus: a BirdNET label with no species-table row and no
  // detection in this fixture — only a reviewer has named it.
  const REVIEWER_ONLY = "Catharus ustulatus";

  beforeEach(async () => {
    const { recordReview, setReviewCorrection } = await actions();
    asUser(JUAN);
    await recordReview(sampleId, "incorrect");
    const r = await setReviewCorrection(sampleId, REVIEWER_ONLY);
    if (!r.success) throw new Error(r.error);
  });

  it("the shared resolver does NOT resolve it (other species pages 404)", async () => {
    const { resolveSpeciesFromSlug } = await import("@/lib/species-slug-server");
    const { speciesSlug } = await import("@/lib/species-slug");
    expect(await resolveSpeciesFromSlug(speciesSlug(REVIEWER_ONLY))).toBeNull();
  });

  it("the validation resolver does, as a synthesized bird", async () => {
    const { resolveValidationSpeciesFromSlug } = await import(
      "@/lib/birdnet-validation/resolve-species-slug"
    );
    const { speciesSlug } = await import("@/lib/species-slug");
    const resolved = await resolveValidationSpeciesFromSlug(speciesSlug(REVIEWER_ONLY));
    expect(resolved).toMatchObject({ id: -1, scientificName: REVIEWER_ONLY, type: "bird" });
  });

  it("the validation resolver still prefers the shared result", async () => {
    const { resolveValidationSpeciesFromSlug } = await import(
      "@/lib/birdnet-validation/resolve-species-slug"
    );
    const { speciesSlug } = await import("@/lib/species-slug");
    // Detected in the fixture, so the shared resolver's fallback finds it.
    const resolved = await resolveValidationSpeciesFromSlug(speciesSlug("Turdus fuscater"));
    expect(resolved?.scientificName).toBe("Turdus fuscater");
    expect(await resolveValidationSpeciesFromSlug("no-such-species")).toBeNull();
  });
});
