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
