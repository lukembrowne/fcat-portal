/**
 * Integration tests for the correct-detections CSV export.
 *
 * Every reviewer's "correct" counts (with the disagreement visible in the
 * answer counts), nothing is blinded, and rows are scoped to the caller's
 * camera-trap projects.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import {
  createTestDb,
  setupIntegrationDbMock,
  testDbRef,
  type TestDb,
} from "../helpers/test-db";

setupIntegrationDbMock();

vi.mock("server-only", () => ({}));

const mockHabitatMap = vi.fn();
vi.mock("@/lib/habitat-lookup", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/habitat-lookup")>();
  return { ...original, loadSiteHabitatMap: () => mockHabitatMap() };
});

const ME = "me@fcat-ecuador.org";
const PRIMARY = "primary@fcat-ecuador.org";
const OTHER = "other@fcat-ecuador.org";

let db: TestDb;
let projectId: number;
let otherProjectId: number;
let deploymentId: number;

async function lib() {
  return import("@/lib/birdnet-validation/correct-export");
}

function addCampaign(species: string, status: string, primary: string | null = null) {
  const [row] = db
    .insert(schema.birdnetValidationCampaigns)
    .values({
      species,
      status: status as typeof schema.birdnetValidationCampaigns.$inferInsert.status,
      seed: 1,
      createdBy: PRIMARY,
      primaryReviewerEmail: primary,
    })
    .returning()
    .all();
  return row.id;
}

let fileCounter = 0;
/** One clip: file → detection → identification → sample. Returns the sample id. */
function addClip(
  campaignId: number,
  opts: { filename?: string; start?: number; deployment?: number } = {}
) {
  fileCounter += 1;
  const [file] = db
    .insert(schema.audioFiles)
    .values({
      deploymentId: opts.deployment ?? deploymentId,
      filename: opts.filename ?? `2MM21842_20260130_0600${String(fileCounter).padStart(2, "0")}.flac`,
      driveFileId: `drive-${fileCounter}`,
      duration: 60,
    })
    .returning()
    .all();
  const [det] = db
    .insert(schema.audioDetections)
    .values({
      audioFileId: file.id,
      startTime: opts.start ?? 12,
      endTime: (opts.start ?? 12) + 3,
      minFreq: 0,
      maxFreq: 15000,
      confidence: 0.6,
    })
    .returning()
    .all();
  const [ident] = db
    .insert(schema.audioIdentifications)
    .values({ audioDetectionId: det.id, species: "x", confidence: 0.6, modelVersion: "birdnet-analyzer@2.4.0" })
    .returning()
    .all();
  const [sample] = db
    .insert(schema.birdnetValidationSamples)
    .values({
      campaignId,
      audioIdentificationId: ident.id,
      confidence: 0.6,
      binIndex: 5,
      deploymentId: opts.deployment ?? deploymentId,
      siteName: "snapshot-site",
      habitat: "snapshot_habitat",
      orderIndex: fileCounter,
    })
    .returning()
    .all();
  return sample.id;
}

function review(sampleId: number, email: string, outcome: "correct" | "incorrect" | "uncertain") {
  db.insert(schema.birdnetValidationReviews)
    .values({ sampleId, reviewerEmail: email, outcome })
    .run();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHabitatMap.mockResolvedValue(new Map([["CCN-003", "cacao_ccn"]]));
  db = createTestDb();
  testDbRef.current = db;
  fileCounter = 0;

  [projectId, otherProjectId] = ["BioChoco", "Elsewhere"].map(
    (name) => db.insert(schema.cameraTrapProjects).values({ name }).returning().all()[0].id
  );
  const [dep] = db
    .insert(schema.deployments)
    .values({
      projectId: "camera-trap",
      name: "CCN-003_V1",
      siteName: "CCN-003 - Landowner Name",
      status: "scanned",
      cameraTrapProjectId: projectId,
      latitude: 0.123456,
      longitude: -79.654321,
      validStart: "2026-01-24T09:42",
      validEnd: "2026-02-12T11:30",
    })
    .returning()
    .all();
  deploymentId = dep.id;
});

describe("collectCorrectDetections", () => {
  it("exports clips a reviewer marked correct, with habitat join fields", async () => {
    const c = addCampaign("Tinamus major", "reviewing");
    const yes = addClip(c, { filename: "2MM21842_20260130_060000.flac", start: 12 });
    const no = addClip(c);
    const unsure = addClip(c);
    review(yes, ME, "correct");
    review(no, ME, "incorrect");
    review(unsure, ME, "uncertain");

    const { collectCorrectDetections } = await lib();
    const rows = await collectCorrectDetections({ ctProjects: "all" });

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.sampleId).toBe(yes);
    expect(row.detectionLocal).toBe("2026-01-30 06:00:12");
    expect(row.siteId).toBe("CCN-003");
    expect(row.habitat).toBe("cacao_ccn");
    expect(row.habitatSource).toBe("odk");
    expect(row.latitude).toBeCloseTo(0.123456);
    expect(row.projectName).toBe("BioChoco");
    expect(row.inDeploymentWindow).toBe(true);
    expect(row.reviewersCorrect).toEqual([ME]);
    expect([row.nCorrect, row.nIncorrect, row.nUncertain]).toEqual([1, 0, 0]);
  });

  it("never carries the landowner name from the deployment's site_name", async () => {
    const c = addCampaign("Tinamus major", "reviewing");
    review(addClip(c), ME, "correct");

    const { collectCorrectDetections, buildCorrectDetectionsCsv } = await lib();
    const rows = await collectCorrectDetections({ ctProjects: "all" });
    expect(buildCorrectDetectionsCsv(rows)).not.toContain("Landowner");
  });

  it("flags a clip recorded before the deployment's valid window", async () => {
    const c = addCampaign("Turdus ignobilis", "reviewing");
    // The CCN-003 case: a house test from November in a January deployment.
    review(addClip(c, { filename: "2MM20630_20251123_090000.flac", start: 58 }), ME, "correct");

    const { collectCorrectDetections } = await lib();
    const [row] = await collectCorrectDetections({ ctProjects: "all" });
    expect(row.detectionLocal).toBe("2025-11-23 09:00:58");
    expect(row.inDeploymentWindow).toBe(false);
  });

  it("falls back to the habitat snapshot when ODK has no match", async () => {
    mockHabitatMap.mockResolvedValue(new Map());
    const c = addCampaign("Tinamus major", "reviewing");
    review(addClip(c), ME, "correct");

    const { collectCorrectDetections } = await lib();
    const [row] = await collectCorrectDetections({ ctProjects: "all" });
    expect(row.habitat).toBe("snapshot_habitat");
    expect(row.habitatSource).toBe("snapshot");
  });

  it("uses every reviewer's answers, not only the primary's, and shows disagreement", async () => {
    // Several reviewers and no primary: the fit would refuse; the export does not.
    const c = addCampaign("Tinamus major", "fitted");
    const onlyOther = addClip(c);
    const split = addClip(c);
    const bothNo = addClip(c);
    review(onlyOther, PRIMARY, "incorrect");
    review(onlyOther, OTHER, "correct");
    review(split, PRIMARY, "correct");
    review(split, OTHER, "correct");
    review(bothNo, PRIMARY, "incorrect");
    review(bothNo, OTHER, "incorrect");

    const { collectCorrectDetections } = await lib();
    const rows = await collectCorrectDetections({ ctProjects: "all" });
    const bySample = new Map(rows.map((r) => [r.sampleId, r]));
    expect([...bySample.keys()].sort()).toEqual([onlyOther, split].sort());
    expect(bySample.get(onlyOther)!.reviewersCorrect).toEqual([OTHER]);
    expect(bySample.get(onlyOther)!.nIncorrect).toBe(1);
    expect(bySample.get(split)!.reviewersCorrect).toEqual([OTHER, PRIMARY]);
    expect(bySample.get(split)!.nCorrect).toBe(2);
  });

  it("exports everyone's answers while the species is still under review", async () => {
    const c = addCampaign("Tinamus major", "reviewing", PRIMARY);
    const a = addClip(c);
    const b = addClip(c);
    review(a, PRIMARY, "correct");
    review(b, PRIMARY, "correct");
    review(a, ME, "correct"); // ME has not answered b; no blinding applies

    const { collectCorrectDetections } = await lib();
    const rows = await collectCorrectDetections({ ctProjects: "all" });
    expect(rows.map((r) => [r.sampleId, r.reviewersCorrect])).toEqual([
      [a, [ME, PRIMARY]],
      [b, [PRIMARY]],
    ]);
  });

  it("drops clips from projects the caller cannot see", async () => {
    const [hidden] = db
      .insert(schema.deployments)
      .values({
        projectId: "camera-trap",
        name: "ELS-001_V1",
        status: "scanned",
        cameraTrapProjectId: otherProjectId,
      })
      .returning()
      .all();
    const c = addCampaign("Tinamus major", "fitted");
    review(addClip(c), ME, "correct");
    review(addClip(c, { deployment: hidden.id }), ME, "correct");

    const { collectCorrectDetections } = await lib();
    const rows = await collectCorrectDetections({ ctProjects: [projectId] });
    expect(rows.map((r) => r.deploymentName)).toEqual(["CCN-003_V1"]);
  });

  it("limits to one species when asked", async () => {
    review(addClip(addCampaign("Tinamus major", "fitted")), ME, "correct");
    review(addClip(addCampaign("Turdus ignobilis", "fitted")), ME, "correct");

    const { collectCorrectDetections } = await lib();
    const rows = await collectCorrectDetections({
      ctProjects: "all",
      species: "Turdus ignobilis",
    });
    expect(rows.map((r) => r.species)).toEqual(["Turdus ignobilis"]);
  });
});
