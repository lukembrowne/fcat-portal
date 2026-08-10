/**
 * Integration tests for removing a species from the validation list.
 *
 * `deleteCampaign` and `abandonCampaign` answer two different questions:
 * "this row should never have existed" versus "we tried and stopped". The
 * load-bearing property is that the first one refuses to run once anybody has
 * reviewed anything — the FK cascade would take their answers with it, with no
 * undo and no trace.
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

// The parameter is declared so `mock.calls[0][0]` is typed at the assertion.
const mockRecordEvent = vi.fn(async (input: Record<string, unknown>) => {
  void input;
});
vi.mock("@/lib/system-events", () => ({
  recordEvent: (input: Record<string, unknown>) => mockRecordEvent(input),
}));

let db: TestDb;
let deploymentId: number;

const SPECIES = "Ramphastos ambiguus";

function seed(confidences: number[]) {
  for (const confidence of confidences) {
    const [file] = db
      .insert(schema.audioFiles)
      .values({
        deploymentId,
        filename: `LIF_20260210_120000_${confidence}.flac`,
        driveFileId: `drive-${confidence}-${Math.random()}`,
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
    db.insert(schema.audioIdentifications)
      .values({ audioDetectionId: detection.id, species: SPECIES, confidence })
      .run();
  }
}

async function actions() {
  return import("@/app/audio/validacion/actions");
}

async function newCampaign(species = SPECIES) {
  const { createCampaign } = await actions();
  const result = await createCampaign({ species });
  if (!result.success) throw new Error(result.error);
  return result.data.campaignId;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequirePermission.mockResolvedValue(testUser);
  mockHabitatMap.mockResolvedValue(new Map([["LIF-000", "bosque maduro"]]));

  db = createTestDb();
  testDbRef.current = db;

  const [ctProject] = db
    .insert(schema.cameraTrapProjects)
    .values({ name: "LifecycleTestProject" })
    .returning()
    .all();
  const [deployment] = db
    .insert(schema.deployments)
    .values({
      projectId: "camera-trap",
      name: "LIF-000",
      siteName: "LIF-000",
      status: "scanned",
      cameraTrapProjectId: ctProject.id,
    })
    .returning()
    .all();
  deploymentId = deployment.id;
});

describe("deleteCampaign", () => {
  it("removes a draft campaign that was never drawn", async () => {
    const { deleteCampaign } = await actions();
    const id = await newCampaign();

    const result = await deleteCampaign(id);

    expect(result.success).toBe(true);
    expect(db.select().from(schema.birdnetValidationCampaigns).all()).toHaveLength(0);
  });

  it("removes a drawn campaign and its samples", async () => {
    seed([0.5, 0.6, 0.7, 0.8, 0.9]);
    const { deleteCampaign } = await actions();
    const id = await newCampaign();

    expect(db.select().from(schema.birdnetValidationSamples).all().length).toBeGreaterThan(0);

    const result = await deleteCampaign(id);

    expect(result.success).toBe(true);
    expect(db.select().from(schema.birdnetValidationCampaigns).all()).toHaveLength(0);
    expect(db.select().from(schema.birdnetValidationSamples).all()).toHaveLength(0);
  });

  it("refuses once anyone has reviewed, keeping the campaign, samples and review", async () => {
    seed([0.5, 0.6, 0.7, 0.8, 0.9]);
    const { recordReview, deleteCampaign } = await actions();
    const id = await newCampaign();

    const [sample] = db.select().from(schema.birdnetValidationSamples).all();
    await recordReview(sample.id, "correct");

    const result = await deleteCampaign(id);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain("Descartar");
    expect(db.select().from(schema.birdnetValidationCampaigns).all()).toHaveLength(1);
    expect(db.select().from(schema.birdnetValidationSamples).all().length).toBeGreaterThan(0);
    expect(db.select().from(schema.birdnetValidationReviews).all()).toHaveLength(1);
  });

  it("counts reviews from every reviewer, not just the caller", async () => {
    // The accident being prevented is one editor deleting a colleague's work.
    seed([0.5, 0.6, 0.7, 0.8, 0.9]);
    const { deleteCampaign } = await actions();
    const id = await newCampaign();

    const [sample] = db.select().from(schema.birdnetValidationSamples).all();
    db.insert(schema.birdnetValidationReviews)
      .values({
        sampleId: sample.id,
        reviewerEmail: "gloria@fcat-ecuador.org",
        outcome: "correct",
      })
      .run();

    const result = await deleteCampaign(id);

    expect(result.success).toBe(false);
    expect(db.select().from(schema.birdnetValidationCampaigns).all()).toHaveLength(1);
  });

  it("refuses when a fit exists even with no reviews left behind", async () => {
    const { deleteCampaign } = await actions();
    const id = await newCampaign();
    db.insert(schema.birdnetSpeciesThresholds)
      .values({ campaignId: id, species: SPECIES, nReviewed: 40, nCorrect: 30 })
      .run();

    const result = await deleteCampaign(id);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain("Descartar");
  });

  it("records a system event naming the species", async () => {
    const { deleteCampaign } = await actions();
    const id = await newCampaign();

    await deleteCampaign(id);

    expect(mockRecordEvent).toHaveBeenCalledTimes(1);
    const event = mockRecordEvent.mock.calls[0][0];
    expect(event.eventType).toBe("birdnet_validation_deleted");
    expect(event.severity).toBe("warn");
    expect(event.targetId).toBe(SPECIES);
  });

  it("reports a missing campaign rather than succeeding silently", async () => {
    const { deleteCampaign } = await actions();
    const result = await deleteCampaign(9999);
    expect(result.success).toBe(false);
  });

  it("requires editor permission", async () => {
    const { deleteCampaign } = await actions();
    const id = await newCampaign();
    mockRequirePermission.mockRejectedValueOnce(new Error("REDIRECT:/"));

    await expect(deleteCampaign(id)).rejects.toThrow("REDIRECT:/");
    expect(db.select().from(schema.birdnetValidationCampaigns).all()).toHaveLength(1);
  });
});

describe("restoreCampaign", () => {
  it("returns a discarded draft to draft and clears the reason", async () => {
    const { abandonCampaign, restoreCampaign } = await actions();
    const id = await newCampaign();
    await abandonCampaign(id, "Me equivoqué");

    const result = await restoreCampaign(id);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.status).toBe("draft");

    const [row] = db.select().from(schema.birdnetValidationCampaigns).all();
    expect(row.status).toBe("draft");
    expect(row.abandonedReason).toBeNull();
  });

  it("returns a campaign discarded mid-review to reviewing", async () => {
    seed([0.5, 0.6, 0.7, 0.8, 0.9]);
    const { recordReview, abandonCampaign, restoreCampaign } = await actions();
    const id = await newCampaign();
    const [sample] = db.select().from(schema.birdnetValidationSamples).all();
    await recordReview(sample.id, "correct");
    await abandonCampaign(id, "Pausada");

    const result = await restoreCampaign(id);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.status).toBe("reviewing");
  });

  it("returns a drawn-but-unreviewed campaign to sampled", async () => {
    seed([0.5, 0.6, 0.7, 0.8, 0.9]);
    const { abandonCampaign, restoreCampaign } = await actions();
    const id = await newCampaign();
    await abandonCampaign(id, "Pausada");

    const result = await restoreCampaign(id);

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.status).toBe("sampled");
  });

  it("refuses when a live campaign for the same species already exists", async () => {
    // The partial unique index excludes abandoned rows, so the species could be
    // restarted while this one sat discarded.
    const { abandonCampaign, restoreCampaign } = await actions();
    const id = await newCampaign();
    await abandonCampaign(id, "Me equivoqué");
    await newCampaign();

    const result = await restoreCampaign(id);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain(SPECIES);

    const rows = db.select().from(schema.birdnetValidationCampaigns).all();
    expect(rows.find((r) => r.id === id)!.status).toBe("abandoned");
  });

  it("refuses a campaign that is not discarded", async () => {
    const { restoreCampaign } = await actions();
    const id = await newCampaign();

    const result = await restoreCampaign(id);

    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toContain("no está descartada");
  });

  it("requires editor permission", async () => {
    const { abandonCampaign, restoreCampaign } = await actions();
    const id = await newCampaign();
    await abandonCampaign(id, "Me equivoqué");
    mockRequirePermission.mockRejectedValueOnce(new Error("REDIRECT:/"));

    await expect(restoreCampaign(id)).rejects.toThrow("REDIRECT:/");
    const [row] = db.select().from(schema.birdnetValidationCampaigns).all();
    expect(row.status).toBe("abandoned");
  });
});
