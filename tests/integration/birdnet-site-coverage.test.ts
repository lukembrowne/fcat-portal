/**
 * Integration tests for the per-site coverage reported by getCampaignProgress.
 *
 * The panel exists so a reader can CHECK that the sample is spread across
 * deployments rather than take the sampler's word for it. That only works if
 * the counts are honest about the awkward cases: a deployment with no site
 * name, and reviews from someone other than the fit-eligible reviewer.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
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

const mockHabitatMap = vi.fn();
vi.mock("@/lib/habitat-lookup", () => ({
  loadSiteHabitatMap: () => mockHabitatMap(),
}));

vi.mock("@/lib/camera-trap-auth", () => ({
  getUserCameraTrapProjects: vi.fn(async () => "all"),
}));

let db: TestDb;
let campaignId: number;

const SPECIES = "Ramphastos ambiguus";

async function actions() {
  return import("@/app/audio/validacion/actions");
}

function addSample(siteName: string | null, orderIndex: number) {
  const [row] = db
    .insert(schema.birdnetValidationSamples)
    .values({
      campaignId,
      audioIdentificationId: orderIndex + 1,
      confidence: 0.5,
      binIndex: 4,
      deploymentId: null,
      siteName,
      orderIndex,
    })
    .returning()
    .all();
  return row;
}

beforeEach(async () => {
  vi.clearAllMocks();
  mockRequirePermission.mockResolvedValue(testUser);
  mockHabitatMap.mockResolvedValue(new Map());

  db = createTestDb();
  testDbRef.current = db;

  const [ctProject] = db
    .insert(schema.cameraTrapProjects)
    .values({ name: "CoverageProject" })
    .returning()
    .all();
  const [deployment] = db
    .insert(schema.deployments)
    .values({
      projectId: "camera-trap",
      name: "COV-000",
      siteName: "COV-000",
      status: "scanned",
      cameraTrapProjectId: ctProject.id,
    })
    .returning()
    .all();

  // Identifications the samples point at, so the FK holds.
  for (let i = 0; i < 10; i++) {
    const [file] = db
      .insert(schema.audioFiles)
      .values({
        deploymentId: deployment.id,
        filename: `COV_20260210_12000${i}.flac`,
        driveFileId: `drive-cov-${i}`,
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
    db.insert(schema.audioIdentifications)
      .values({ audioDetectionId: detection.id, species: SPECIES, confidence: 0.5 })
      .run();
  }

  const { createCampaign } = await actions();
  const created = await createCampaign({ species: SPECIES });
  if (!created.success) throw new Error(created.error);
  campaignId = created.data.campaignId;

  // Creating the species draws a real sample, but these tests are about how
  // per-site counts are reported, not about what the draw picks. Clearing it
  // lets each test state the exact site distribution it is asserting on.
  db.delete(schema.birdnetValidationSamples).run();
});

describe("getCampaignProgress sites", () => {
  it("reports one entry per distinct site, ordered by how many were drawn", async () => {
    addSample("COV-A", 0);
    addSample("COV-A", 1);
    addSample("COV-A", 2);
    addSample("COV-B", 3);
    addSample("COV-C", 4);
    addSample("COV-C", 5);

    const { getCampaignProgress } = await actions();
    const progress = await getCampaignProgress(campaignId);

    expect(progress.success).toBe(true);
    if (!progress.success) return;
    expect(progress.data.sites.map((s) => [s.siteName, s.drawn])).toEqual([
      ["COV-A", 3],
      ["COV-C", 2],
      ["COV-B", 1],
    ]);
  });

  it("labels a sample with no site name rather than dropping it", async () => {
    // At least one deployment in the real data carries no site name; dropping
    // it would make the drawn totals silently disagree with the bin table.
    addSample("COV-A", 0);
    addSample(null, 1);

    const { getCampaignProgress } = await actions();
    const progress = await getCampaignProgress(campaignId);

    expect(progress.success).toBe(true);
    if (!progress.success) return;
    expect(progress.data.sites).toHaveLength(2);
    expect(progress.data.sites.some((s) => s.siteName === null)).toBe(true);

    const drawnTotal = progress.data.sites.reduce((sum, s) => sum + s.drawn, 0);
    expect(drawnTotal).toBe(progress.data.sampled);
  });

  it("counts only the fit-eligible reviewer's answers as reviewed", async () => {
    // Every other scientific count in the module reads the fit-eligible set;
    // this one must not be the exception, or the panel would disagree with the
    // bin table for a multi-reviewer species.
    const a = addSample("COV-A", 0);
    const b = addSample("COV-B", 1);

    const { recordReview, setPrimaryReviewer, getCampaignProgress } =
      await actions();
    await recordReview(a.id, "correct");

    // Gloria's review is inserted directly rather than through an enrolment
    // call: the counts under test read reviews, not roster membership.
    db.insert(schema.birdnetValidationReviews)
      .values({
        sampleId: b.id,
        reviewerEmail: "gloria@fcat-ecuador.org",
        outcome: "incorrect",
      })
      .run();
    await setPrimaryReviewer(campaignId, testUser.email);

    const progress = await getCampaignProgress(campaignId);

    expect(progress.success).toBe(true);
    if (!progress.success) return;
    const bySite = new Map(progress.data.sites.map((s) => [s.siteName, s]));
    expect(bySite.get("COV-A")!.reviewed).toBe(1);
    // Gloria's answer belongs to another reviewer and is not the fit's input.
    expect(bySite.get("COV-B")!.reviewed).toBe(0);
  });

  it("returns an empty list for a campaign with no samples", async () => {
    const { getCampaignProgress } = await actions();
    const progress = await getCampaignProgress(campaignId);

    expect(progress.success).toBe(true);
    if (!progress.success) return;
    expect(progress.data.sites).toEqual([]);
  });
});

describe("getCampaignProgress sites — correct clips per site", () => {
  const GLORIA = "gloria@fcat-ecuador.org";

  function insertReview(sampleId: number, email: string, outcome: string) {
    db.insert(schema.birdnetValidationReviews)
      .values({
        sampleId,
        reviewerEmail: email,
        outcome: outcome as "correct" | "incorrect" | "uncertain",
      })
      .run();
  }

  async function sitesOf() {
    const { getCampaignProgress } = await actions();
    const progress = await getCampaignProgress(campaignId);
    if (!progress.success) throw new Error(progress.error);
    return {
      progress: progress.data,
      bySite: new Map(progress.data.sites.map((s) => [s.siteName, s])),
    };
  }

  it("counts only the primary reviewer's correct answers", async () => {
    const a = addSample("COV-A", 0);
    const b = addSample("COV-B", 1);

    insertReview(a.id, testUser.email, "correct");
    insertReview(b.id, testUser.email, "incorrect");
    // Gloria hears the COV-B clip as correct; she is not the primary, so COV-B
    // must not become a confirmed site.
    insertReview(b.id, GLORIA, "correct");

    const { setPrimaryReviewer } = await actions();
    await setPrimaryReviewer(campaignId, testUser.email);

    const { bySite, progress } = await sitesOf();
    expect(bySite.get("COV-A")!.correct).toBe(1);
    expect(bySite.get("COV-B")!.correct).toBe(0);
    expect(progress.fitEligibilityReason).toBeNull();
  });

  it("counts a sole reviewer's answers without a designated primary", async () => {
    const a = addSample("COV-A", 0);
    const a2 = addSample("COV-A", 1);
    const b = addSample("COV-B", 2);
    insertReview(a.id, GLORIA, "correct");
    insertReview(a2.id, GLORIA, "correct");
    insertReview(b.id, GLORIA, "correct");

    // Read as Gloria: she is the fit-eligible reviewer, so the counts are hers.
    mockRequirePermission.mockResolvedValue({ ...testUser, email: GLORIA });
    const { bySite } = await sitesOf();
    expect(bySite.get("COV-A")!.correct).toBe(2);
    expect(bySite.get("COV-B")!.correct).toBe(1);
  });

  it("does not pool answers when several reviewers have no primary", async () => {
    const a = addSample("COV-A", 0);
    const b = addSample("COV-B", 1);
    insertReview(a.id, testUser.email, "correct");
    insertReview(b.id, GLORIA, "correct");

    const { bySite, progress } = await sitesOf();
    expect(progress.fitEligibilityReason).toBe("no_primary_reviewer");
    // Withheld, not 1 each (pooled) — the page reads the reason and shows a dash.
    expect(bySite.get("COV-A")!.correct).toBeNull();
    expect(bySite.get("COV-B")!.correct).toBeNull();
  });

  it("reports 0 for a site with only incorrect or uncertain answers", async () => {
    const a = addSample("COV-A", 0);
    const a2 = addSample("COV-A", 1);
    const b = addSample("COV-B", 2);
    insertReview(a.id, testUser.email, "incorrect");
    insertReview(a2.id, testUser.email, "uncertain");
    insertReview(b.id, testUser.email, "correct");

    const { bySite } = await sitesOf();
    expect(bySite.get("COV-A")!.reviewed).toBe(2);
    expect(bySite.get("COV-A")!.correct).toBe(0);
    expect(bySite.get("COV-B")!.correct).toBe(1);
  });

  it("per-site counts sum to the fit-eligible correct total", async () => {
    const outcomes = ["correct", "correct", "incorrect", "correct", "uncertain"];
    const sites = ["COV-A", "COV-B", "COV-B", "COV-C", null];
    outcomes.forEach((outcome, i) => {
      const s = addSample(sites[i], i);
      insertReview(s.id, testUser.email, outcome);
    });

    const { progress } = await sitesOf();
    const sum = progress.sites.reduce((acc, s) => acc + (s.correct ?? 0), 0);
    expect(sum).toBe(progress.correct);
    expect(sum).toBe(3);
  });
});

describe("getCampaignProgress sites — blinding of per-site correct counts", () => {
  // The review page shows each clip's site. Per-site correct counts made of
  // the primary's answers would let a colleague still reviewing read those
  // answers off by site, so they are withheld server-side.
  const GLORIA = "gloria@fcat-ecuador.org";
  const PEDRO = "pedro@fcat-ecuador.org";

  function as(email: string) {
    mockRequirePermission.mockResolvedValue({ ...testUser, email });
  }

  function insertReview(sampleId: number, email: string, outcome: string) {
    db.insert(schema.birdnetValidationReviews)
      .values({
        sampleId,
        reviewerEmail: email,
        outcome: outcome as "correct" | "incorrect" | "uncertain",
      })
      .run();
  }

  function setStatus(status: string) {
    db.update(schema.birdnetValidationCampaigns)
      .set({ status: status as "reviewing" })
      .run();
  }

  let a: { id: number };
  let b: { id: number };

  beforeEach(async () => {
    a = addSample("COV-A", 0);
    b = addSample("COV-B", 1);
    // The primary has answered everything; COV-A is confirmed.
    insertReview(a.id, testUser.email, "correct");
    insertReview(b.id, testUser.email, "incorrect");
    as(testUser.email);
    const { setPrimaryReviewer } = await actions();
    await setPrimaryReviewer(campaignId, testUser.email);
    setStatus("reviewing");
  });

  async function progressAs(email: string) {
    as(email);
    const { getCampaignProgress } = await actions();
    const progress = await getCampaignProgress(campaignId);
    if (!progress.success) throw new Error(progress.error);
    return progress.data;
  }

  it("withholds the counts from a colleague with clips still to review", async () => {
    insertReview(a.id, GLORIA, "correct"); // one of two answered

    const data = await progressAs(GLORIA);
    expect(data.siteCorrectBlinded).toBe(true);
    expect(data.sites.map((s) => s.correct)).toEqual([null, null]);
    // Not merely unrendered: the drawn/reviewed spread is still there, but no
    // correct count travels in the payload.
    for (const site of data.sites) expect(site.correct).toBeNull();
  });

  it("releases them once the colleague has answered every clip", async () => {
    insertReview(a.id, GLORIA, "correct");
    insertReview(b.id, GLORIA, "uncertain");

    const data = await progressAs(GLORIA);
    expect(data.siteCorrectBlinded).toBe(false);
    const bySite = new Map(data.sites.map((s) => [s.siteName, s.correct]));
    expect(bySite.get("COV-A")).toBe(1);
    expect(bySite.get("COV-B")).toBe(0);
  });

  it("shows the fit-eligible reviewer their own counts", async () => {
    // Even with a clip added that the primary has not reached yet.
    addSample("COV-C", 2);
    const data = await progressAs(testUser.email);
    expect(data.siteCorrectBlinded).toBe(false);
    expect(data.sites.find((s) => s.siteName === "COV-A")!.correct).toBe(1);
  });

  it.each(["draft", "sampled", "reviewing"])(
    "keeps withholding from someone who reviewed nothing while %s",
    async (status) => {
      setStatus(status);
      const data = await progressAs(PEDRO);
      expect(data.siteCorrectBlinded).toBe(true);
      expect(data.sites.every((s) => s.correct === null)).toBe(true);
    }
  );

  it.each(["fitted", "unusable", "applied", "abandoned"])(
    "shows everyone the counts once the species is %s",
    async (status) => {
      setStatus(status);
      const data = await progressAs(PEDRO);
      expect(data.siteCorrectBlinded).toBe(false);
      expect(data.sites.find((s) => s.siteName === "COV-A")!.correct).toBe(1);
    }
  );
});
