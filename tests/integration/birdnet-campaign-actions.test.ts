/**
 * Integration tests for the validation campaign lifecycle.
 *
 * Covers permission enforcement, the draft -> sampled -> reviewing transitions,
 * idempotent review recording, and the progress aggregation the species page and
 * review queue both read.
 *
 * The load-bearing case is the one at the seam: `createCampaign` now draws the
 * sample as part of creating the species, and a draw that fails must leave the
 * species created and recoverable rather than rolling it back or throwing. The
 * bulk importer relies on exactly that, one species at a time.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
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

// Habitat comes from ODK, not the database. Default to a populated map; one
// test overrides it to a rejection to prove sampling degrades gracefully.
const mockHabitatMap = vi.fn();
vi.mock("@/lib/habitat-lookup", () => ({
  loadSiteHabitatMap: () => mockHabitatMap(),
}));

vi.mock("@/lib/camera-trap-auth", () => ({
  getUserCameraTrapProjects: vi.fn(async () => "all"),
}));

let db: TestDb;
let deploymentIds: number[] = [];
let ctProjectId: number;

const SPECIES = "Ramphastos ambiguus";

function seed(species: string, confidences: number[], depIdx: number) {
  const deploymentId = deploymentIds[depIdx];
  for (const confidence of confidences) {
    const [file] = db
      .insert(schema.audioFiles)
      .values({
        deploymentId,
        filename: `f-${depIdx}-${confidence}-${Math.random()}.flac`,
        driveFileId: `drive-${depIdx}-${confidence}-${Math.random()}`,
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
      .values({ audioDetectionId: detection.id, species, confidence })
      .run();
  }
}

async function newCampaign(overrides: Record<string, unknown> = {}) {
  const { createCampaign } = await import("@/app/audio/validacion/actions");
  const result = await createCampaign({ species: SPECIES, ...overrides });
  if (!result.success) throw new Error(result.error);
  return result.data.campaignId;
}

function samples() {
  return db
    .select()
    .from(schema.birdnetValidationSamples)
    .all()
    .sort((a, b) => a.orderIndex - b.orderIndex);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequirePermission.mockResolvedValue(testUser);
  mockHabitatMap.mockResolvedValue(new Map([["VAL-000", "bosque maduro"]]));

  db = createTestDb();
  testDbRef.current = db;
  deploymentIds = [];

  const [ctProject] = db
    .insert(schema.cameraTrapProjects)
    .values({ name: "ValidationTestProject" })
    .returning()
    .all();
  ctProjectId = ctProject.id;

  for (let i = 0; i < 3; i++) {
    const [deployment] = db
      .insert(schema.deployments)
      .values({
        projectId: "camera-trap",
        name: `VAL-00${i}`,
        siteName: `VAL-00${i}`,
        status: "scanned",
        cameraTrapProjectId: ctProject.id,
      })
      .returning()
      .all();
    deploymentIds.push(deployment.id);
  }
});

describe("createCampaign", () => {
  it("draws the sample as part of creating the species", async () => {
    const { createCampaign } = await import("@/app/audio/validacion/actions");
    seed(SPECIES, Array(20).fill(0.25), 0);
    seed(SPECIES, Array(20).fill(0.75), 1);

    const result = await createCampaign({ species: SPECIES, targetSampleSize: 12 });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.drawn).toBe(12);
    expect(result.data.drawError).toBeNull();

    const [row] = db.select().from(schema.birdnetValidationCampaigns).all();
    expect(row.species).toBe(SPECIES);
    expect(row.status).toBe("sampled");
    expect(row.sampledAt).toBeTruthy();
    expect(row.seed).toBeGreaterThan(0);
    expect(row.createdBy).toBe(testUser.email);
    expect(samples()).toHaveLength(12);
  });

  it("spreads the draw across score bins", async () => {
    seed(SPECIES, Array(20).fill(0.25), 0);
    seed(SPECIES, Array(20).fill(0.75), 1);
    await newCampaign({ targetSampleSize: 12 });

    const bins = new Set(samples().map((s) => s.binIndex));
    expect(bins.size).toBe(2);
  });

  it("spreads the draw across deployments within a bin", async () => {
    // One site per pick before any site's second — the confounding-frog guard.
    seed(SPECIES, Array(5).fill(0.55), 0);
    seed(SPECIES, Array(5).fill(0.55), 1);
    seed(SPECIES, Array(5).fill(0.55), 2);
    await newCampaign({ targetSampleSize: 3 });

    const sites = new Set(samples().map((s) => s.deploymentId));
    expect(sites.size).toBe(3);
  });

  it("assigns contiguous order indexes", async () => {
    seed(SPECIES, Array(8).fill(0.65), 0);
    await newCampaign({ targetSampleSize: 5 });

    expect(samples().map((s) => s.orderIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  it("keeps the species when the draw finds nothing, and reports why", async () => {
    // Fault isolation. The row must survive so the species is visible and its
    // draw can be retried — the bulk importer depends on this per species.
    const { createCampaign } = await import("@/app/audio/validacion/actions");

    const result = await createCampaign({ species: SPECIES });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.drawn).toBe(0);
    expect(result.data.drawError).toContain("No hay detecciones");

    const [row] = db.select().from(schema.birdnetValidationCampaigns).all();
    expect(row.status).toBe("draft");
    expect(row.sampledAt).toBeNull();
    expect(samples()).toHaveLength(0);
  });

  it("recovers a failed draw through drawSample", async () => {
    const { drawSample } = await import("@/app/audio/validacion/actions");
    const campaignId = await newCampaign();
    seed(SPECIES, Array(6).fill(0.55), 0);

    const result = await drawSample(campaignId);

    expect(result.success).toBe(true);
    const [row] = db.select().from(schema.birdnetValidationCampaigns).all();
    expect(row.status).toBe("sampled");
    expect(samples().length).toBeGreaterThan(0);
  });

  it("snapshots the ODK habitat onto each sampled row", async () => {
    seed(SPECIES, [0.9], 0);
    await newCampaign();

    const [sample] = samples();
    expect(sample.habitat).toBe("bosque maduro");
    expect(sample.siteName).toBe("VAL-000");
  });

  it("records a null habitat rather than failing when ODK is unavailable", async () => {
    mockHabitatMap.mockRejectedValueOnce(new Error("ODK unreachable"));
    seed(SPECIES, [0.9], 0);
    await newCampaign();

    const [sample] = samples();
    expect(sample.habitat).toBeNull();
    expect(sample.siteName).toBe("VAL-000");
  });

  it("draws nothing from another camera-trap project when scoped", async () => {
    // Every detection belongs to the deployments of `ctProjectId`; scoping the
    // campaign to a sibling project must find none of them.
    seed(SPECIES, Array(6).fill(0.55), 0);
    const [otherProject] = db
      .insert(schema.cameraTrapProjects)
      .values({ name: "OtherProject" })
      .returning()
      .all();
    expect(otherProject.id).not.toBe(ctProjectId);
    const { createCampaign } = await import("@/app/audio/validacion/actions");

    const result = await createCampaign({
      species: SPECIES,
      ctProjectId: otherProject.id,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.drawn).toBe(0);
    expect(samples()).toHaveLength(0);
  });

  it("refuses a second live campaign for the same species", async () => {
    const { createCampaign } = await import("@/app/audio/validacion/actions");
    await createCampaign({ species: SPECIES });
    const second = await createCampaign({ species: SPECIES });

    expect(second.success).toBe(false);
    if (!second.success) expect(second.error).toContain("Ya se está validando");
  });

  it("allows a retry after the first campaign is abandoned", async () => {
    const { createCampaign, abandonCampaign } = await import(
      "@/app/audio/validacion/actions"
    );
    const first = await createCampaign({ species: SPECIES });
    if (!first.success) throw new Error("setup failed");
    await abandonCampaign(first.data.campaignId, "sin positivos verdaderos");

    const second = await createCampaign({ species: SPECIES });
    expect(second.success).toBe(true);
  });

  it("rejects an empty species name", async () => {
    const { createCampaign } = await import("@/app/audio/validacion/actions");
    const result = await createCampaign({ species: "   " });
    expect(result.success).toBe(false);
  });

  it("redirects when the caller is not an editor", async () => {
    mockRequirePermission.mockRejectedValueOnce(new Error("REDIRECT:/"));
    const { createCampaign } = await import("@/app/audio/validacion/actions");
    await expect(createCampaign({ species: SPECIES })).rejects.toThrow("REDIRECT");
    expect(db.select().from(schema.birdnetValidationCampaigns).all()).toHaveLength(0);
  });
});

describe("drawSample", () => {
  it("refuses to draw twice", async () => {
    const { drawSample } = await import("@/app/audio/validacion/actions");
    seed(SPECIES, Array(10).fill(0.5), 0);
    const campaignId = await newCampaign({ targetSampleSize: 4 });

    const second = await drawSample(campaignId);
    expect(second.success).toBe(false);
    if (!second.success) expect(second.error).toContain("ya fue extraída");
    expect(samples()).toHaveLength(4);
  });

  it("refuses on an abandoned campaign", async () => {
    const { drawSample, abandonCampaign } = await import(
      "@/app/audio/validacion/actions"
    );
    const campaignId = await newCampaign();
    await abandonCampaign(campaignId, "no vale la pena");
    seed(SPECIES, Array(5).fill(0.5), 0);

    const result = await drawSample(campaignId);
    expect(result.success).toBe(false);
  });

  it("never draws the same detection twice", async () => {
    seed(SPECIES, Array(10).fill(0.95), 0);
    await newCampaign({ targetSampleSize: 6 });

    const identIds = samples().map((s) => s.audioIdentificationId);
    expect(new Set(identIds).size).toBe(identIds.length);
  });
});

describe("abandonCampaign", () => {
  it("requires a reason", async () => {
    const { abandonCampaign } = await import("@/app/audio/validacion/actions");
    const campaignId = await newCampaign();

    const result = await abandonCampaign(campaignId, "  ");
    expect(result.success).toBe(false);

    const [campaign] = db.select().from(schema.birdnetValidationCampaigns).all();
    expect(campaign.status).toBe("draft");
  });
});

describe("recordReview", () => {
  async function seededCampaign() {
    seed(SPECIES, Array(6).fill(0.55), 0);
    return newCampaign({ targetSampleSize: 4 });
  }

  it("records the outcome, reviewer, and timestamp", async () => {
    const { recordReview } = await import("@/app/audio/validacion/actions");
    await seededCampaign();
    const [sample] = samples();

    const result = await recordReview(sample.id, "correct");
    expect(result.success).toBe(true);

    const [review] = db
      .select()
      .from(schema.birdnetValidationReviews)
      .all()
      .filter((r) => r.sampleId === sample.id);
    expect(review.outcome).toBe("correct");
    expect(review.reviewerEmail).toBe(testUser.email);
    expect(review.reviewedAt).toBeTruthy();
  });

  it("moves the campaign into reviewing on the first answer", async () => {
    const { recordReview } = await import("@/app/audio/validacion/actions");
    const campaignId = await seededCampaign();
    const [sample] = samples();

    await recordReview(sample.id, "incorrect");

    const [campaign] = db
      .select()
      .from(schema.birdnetValidationCampaigns)
      .all()
      .filter((c) => c.id === campaignId);
    expect(campaign.status).toBe("reviewing");
  });

  it("is a no-op when the same outcome is recorded twice", async () => {
    const { recordReview } = await import("@/app/audio/validacion/actions");
    await seededCampaign();
    const [sample] = samples();

    await recordReview(sample.id, "correct");
    const first = db
      .select()
      .from(schema.birdnetValidationReviews)
      .all()
      .find((r) => r.sampleId === sample.id)!.reviewedAt;

    await recordReview(sample.id, "correct");
    const second = db
      .select()
      .from(schema.birdnetValidationReviews)
      .all()
      .find((r) => r.sampleId === sample.id)!.reviewedAt;

    expect(second).toEqual(first);
  });

  it("revises the reviewer's own answer when they step back", async () => {
    const { recordReview } = await import("@/app/audio/validacion/actions");
    await seededCampaign();
    const [sample] = samples();

    await recordReview(sample.id, "correct");
    await recordReview(sample.id, "incorrect");

    const reviews = db
      .select()
      .from(schema.birdnetValidationReviews)
      .all()
      .filter((r) => r.sampleId === sample.id);
    // Revised in place — not a second row.
    expect(reviews).toHaveLength(1);
    expect(reviews[0].outcome).toBe("incorrect");
  });

  it("refuses on an abandoned campaign", async () => {
    const { recordReview, abandonCampaign } = await import(
      "@/app/audio/validacion/actions"
    );
    const campaignId = await seededCampaign();
    const [sample] = samples();
    await abandonCampaign(campaignId, "descartada");

    const result = await recordReview(sample.id, "correct");
    expect(result.success).toBe(false);
  });

  it("returns a Spanish error for an unknown sample", async () => {
    const { recordReview } = await import("@/app/audio/validacion/actions");
    const result = await recordReview(999999, "correct");
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error).toContain("no encontrada");
  });
});

describe("getCampaignProgress", () => {
  it("counts each outcome separately and reports per-bin progress", async () => {
    const { recordReview, getCampaignProgress } = await import(
      "@/app/audio/validacion/actions"
    );
    seed(SPECIES, Array(4).fill(0.25), 0);
    seed(SPECIES, Array(4).fill(0.85), 1);
    const campaignId = await newCampaign({ targetSampleSize: 8 });

    const rows = samples();
    await recordReview(rows[0].id, "correct");
    await recordReview(rows[1].id, "incorrect");
    await recordReview(rows[2].id, "uncertain");

    const result = await getCampaignProgress(campaignId);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.sampled).toBe(8);
    expect(result.data.reviewed).toBe(3);
    expect(result.data.correct).toBe(1);
    expect(result.data.incorrect).toBe(1);
    expect(result.data.uncertain).toBe(1);
    expect(result.data.bins.length).toBeGreaterThan(1);
    expect(result.data.bins.reduce((s, b) => s + b.drawn, 0)).toBe(8);
  });

  it("reports no stale-fit count when the campaign has never been fitted", async () => {
    const { getCampaignProgress } = await import("@/app/audio/validacion/actions");
    const campaignId = await newCampaign();
    const result = await getCampaignProgress(campaignId);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.reviewsSinceFit).toBeNull();
  });

  it("counts usable reviews recorded since the last fit, excluding uncertain", async () => {
    const { recordReview, getCampaignProgress } = await import(
      "@/app/audio/validacion/actions"
    );
    seed(SPECIES, Array(6).fill(0.55), 0);
    const campaignId = await newCampaign({ targetSampleSize: 5 });

    const rows = samples();
    await recordReview(rows[0].id, "correct");
    await recordReview(rows[1].id, "incorrect");

    // A fit that saw only the first review.
    db.insert(schema.birdnetSpeciesThresholds)
      .values({ campaignId, species: SPECIES, nReviewed: 1, nCorrect: 1 })
      .run();

    await recordReview(rows[2].id, "uncertain");

    const result = await getCampaignProgress(campaignId);
    if (!result.success) throw new Error(result.error);
    // 3 reviewed - 1 uncertain - 1 seen by the fit = 1 new usable review.
    expect(result.data.reviewsSinceFit).toBe(1);
  });
});

describe("getReviewQueue", () => {
  it("returns only unreviewed samples in queue order", async () => {
    const { recordReview, getReviewQueue } = await import(
      "@/app/audio/validacion/actions"
    );
    seed(SPECIES, Array(6).fill(0.55), 0);
    const campaignId = await newCampaign({ targetSampleSize: 5 });

    const rows = samples();
    await recordReview(rows[0].id, "correct");

    const result = await getReviewQueue(campaignId);
    if (!result.success) throw new Error(result.error);

    expect(result.data).toHaveLength(4);
    expect(result.data.map((r) => r.orderIndex)).toEqual([1, 2, 3, 4]);
  });
});
