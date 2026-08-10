/**
 * Integration test for the score-bin-stratified validation draw.
 *
 * Exercises the real SQL (window functions, the seeded hash ordering, the
 * bin-boundary arithmetic) against in-memory SQLite. The two properties under
 * test are the ones the whole threshold estimate rests on: uniform coverage
 * across score bins, and deployment spreading inside each bin.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/db/schema";
import { createTestDb, setupIntegrationDbMock, testDbRef, type TestDb } from "../helpers/test-db";

setupIntegrationDbMock();

vi.mock("server-only", () => ({}));

let db: TestDb;
let ctProjectId: number;
const deploymentIds: number[] = [];

const SPECIES = "Ramphastos ambiguus";
const OTHER_SPECIES = "Pulsatrix perspicillata";

/**
 * Seed `perDeployment` identifications at the given confidence for each
 * deployment, so tests can control both the score distribution and the site
 * distribution independently.
 */
function seedDetections(
  species: string,
  confidences: number[],
  deploymentIndexes: number[]
) {
  for (const depIdx of deploymentIndexes) {
    const deploymentId = deploymentIds[depIdx];
    for (const confidence of confidences) {
      const [file] = db
        .insert(schema.audioFiles)
        .values({
          deploymentId,
          filename: `d${depIdx}-${confidence}-${Math.random()}.flac`,
          driveFileId: `drive-${depIdx}-${confidence}-${Math.random()}`,
          duration: 60,
        })
        .returning()
        .all();

      const [detection] = db
        .insert(schema.audioDetections)
        .values({
          audioFileId: file.id,
          startTime: 12,
          endTime: 15,
          minFreq: 500,
          maxFreq: 8000,
          confidence,
        })
        .returning()
        .all();

      db.insert(schema.audioIdentifications)
        .values({
          audioDetectionId: detection.id,
          species,
          confidence,
          verificationStatus: "unverified",
        })
        .run();
    }
  }
}

beforeEach(() => {
  db = createTestDb();
  testDbRef.current = db;
  deploymentIds.length = 0;

  const [ctProject] = db
    .insert(schema.cameraTrapProjects)
    .values({ name: "SamplingTestProject" })
    .returning()
    .all();
  ctProjectId = ctProject.id;

  for (let i = 0; i < 4; i++) {
    const [deployment] = db
      .insert(schema.deployments)
      .values({
        projectId: "camera-trap",
        name: `SMP-00${i}`,
        siteName: `SMP-00${i}`,
        status: "scanned",
        cameraTrapProjectId: ctProject.id,
      })
      .returning()
      .all();
    deploymentIds.push(deployment.id);
  }
});

describe("countByBin", () => {
  it("counts detections into the correct bins", async () => {
    const { countByBin } = await import("@/lib/birdnet-validation/sampling");
    // 0.1-wide deciles: 2 rows in bin 0, 1 in bin 4, 3 in bin 8.
    seedDetections(SPECIES, [0.15, 0.19, 0.55, 0.92, 0.95, 0.99], [0]);

    const counts = await countByBin(SPECIES, [ctProjectId], 9);

    expect(counts).toHaveLength(9);
    expect(counts[0]).toBe(2);
    expect(counts[4]).toBe(1);
    expect(counts[8]).toBe(3);
  });

  it("places confidence of exactly 1.0 in the last bin, not outside it", async () => {
    const { countByBin } = await import("@/lib/birdnet-validation/sampling");
    seedDetections(SPECIES, [1.0], [0]);

    const counts = await countByBin(SPECIES, [ctProjectId], 9);

    // The naive CAST puts 1.0 one index past the end, silently dropping every
    // top-scoring detection from the sample.
    expect(counts[8]).toBe(1);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("does not count other species", async () => {
    const { countByBin } = await import("@/lib/birdnet-validation/sampling");
    seedDetections(SPECIES, [0.5], [0]);
    seedDetections(OTHER_SPECIES, [0.5, 0.5, 0.5], [0]);

    const counts = await countByBin(SPECIES, [ctProjectId], 9);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("excludes projects the user cannot reach", async () => {
    const { countByBin } = await import("@/lib/birdnet-validation/sampling");
    seedDetections(SPECIES, [0.5, 0.6], [0]);

    const counts = await countByBin(SPECIES, [ctProjectId + 999], 9);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("counts everything for a super admin scope of 'all'", async () => {
    const { countByBin } = await import("@/lib/birdnet-validation/sampling");
    seedDetections(SPECIES, [0.5, 0.6], [0]);

    const counts = await countByBin(SPECIES, "all", 9);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(2);
  });
});

describe("drawStratifiedSample", () => {
  it("spreads draws round-robin across deployments within a bin", async () => {
    const { drawStratifiedSample } = await import("@/lib/birdnet-validation/sampling");
    // 10 detections in one bin on each of 3 deployments.
    seedDetections(SPECIES, Array(10).fill(0.55), [0, 1, 2]);

    const { candidates } = await drawStratifiedSample({
      species: SPECIES,
      ctProjects: [ctProjectId],
      binCount: 9,
      target: 6,
      seed: 42,
    });

    expect(candidates).toHaveLength(6);
    const perDeployment = new Map<number, number>();
    for (const c of candidates) {
      perDeployment.set(c.deploymentId!, (perDeployment.get(c.deploymentId!) ?? 0) + 1);
    }
    // Each of the 3 deployments contributes exactly 2 — not 6 from one site.
    expect([...perDeployment.values()].sort()).toEqual([2, 2, 2]);
  });

  it("exhausts a small deployment before taking extras from a large one", async () => {
    const { drawStratifiedSample } = await import("@/lib/birdnet-validation/sampling");
    // The "perfect confounding frog" case: one site dominates the bin.
    seedDetections(SPECIES, Array(100).fill(0.55), [0]);
    seedDetections(SPECIES, Array(2).fill(0.55), [1]);

    const { candidates } = await drawStratifiedSample({
      species: SPECIES,
      ctProjects: [ctProjectId],
      binCount: 9,
      target: 10,
      seed: 7,
    });

    const fromSmall = candidates.filter((c) => c.deploymentId === deploymentIds[1]).length;
    expect(fromSmall).toBe(2);
    expect(candidates).toHaveLength(10);
  });

  it("covers every bin that has detections", async () => {
    const { drawStratifiedSample } = await import("@/lib/birdnet-validation/sampling");
    // U-shaped, like the real Ramphastos ambiguus distribution.
    seedDetections(SPECIES, Array(30).fill(0.15), [0, 1]);
    seedDetections(SPECIES, Array(5).fill(0.55), [0]);
    seedDetections(SPECIES, Array(30).fill(0.95), [0, 1]);

    const { candidates, allocated } = await drawStratifiedSample({
      species: SPECIES,
      ctProjects: [ctProjectId],
      binCount: 9,
      target: 30,
      seed: 99,
    });

    const bins = new Set(candidates.map((c) => c.binIndex));
    expect(bins.has(0)).toBe(true);
    expect(bins.has(4)).toBe(true);
    expect(bins.has(8)).toBe(true);
    // The thin middle bin contributes everything it has rather than being
    // swamped by the dense extremes.
    expect(candidates.filter((c) => c.binIndex === 4)).toHaveLength(5);
    expect(allocated[4]).toBe(5);
  });

  it("is reproducible for a given seed and differs across seeds", async () => {
    const { drawStratifiedSample } = await import("@/lib/birdnet-validation/sampling");
    seedDetections(SPECIES, Array(40).fill(0.55), [0, 1]);

    const opts = {
      species: SPECIES,
      ctProjects: [ctProjectId],
      binCount: 9,
      target: 12,
    };
    const a = await drawStratifiedSample({ ...opts, seed: 12345 });
    const b = await drawStratifiedSample({ ...opts, seed: 12345 });
    const c = await drawStratifiedSample({ ...opts, seed: 54321 });

    const ids = (r: typeof a) => r.candidates.map((x) => x.audioIdentificationId);
    expect(ids(a)).toEqual(ids(b));
    expect(ids(a)).not.toEqual(ids(c));
  });

  it("never draws an excluded identification", async () => {
    const { drawStratifiedSample } = await import("@/lib/birdnet-validation/sampling");
    seedDetections(SPECIES, Array(10).fill(0.55), [0]);

    const first = await drawStratifiedSample({
      species: SPECIES,
      ctProjects: [ctProjectId],
      binCount: 9,
      target: 4,
      seed: 1,
    });
    const excludeIds = first.candidates.map((c) => c.audioIdentificationId);

    const second = await drawStratifiedSample({
      species: SPECIES,
      ctProjects: [ctProjectId],
      binCount: 9,
      target: 4,
      seed: 1,
      excludeIds,
    });

    const overlap = second.candidates.filter((c) =>
      excludeIds.includes(c.audioIdentificationId)
    );
    expect(overlap).toHaveLength(0);
    expect(second.candidates).toHaveLength(4);
  });

  it("returns everything available when the species has too few detections", async () => {
    const { drawStratifiedSample } = await import("@/lib/birdnet-validation/sampling");
    seedDetections(SPECIES, [0.2, 0.4, 0.9], [0]);

    const { candidates } = await drawStratifiedSample({
      species: SPECIES,
      ctProjects: [ctProjectId],
      binCount: 9,
      target: 200,
      seed: 3,
    });

    expect(candidates).toHaveLength(3);
  });

  it("returns nothing for a species with no detections", async () => {
    const { drawStratifiedSample } = await import("@/lib/birdnet-validation/sampling");
    const { candidates } = await drawStratifiedSample({
      species: "Nonexistent species",
      ctProjects: [ctProjectId],
      binCount: 9,
      target: 200,
      seed: 3,
    });
    expect(candidates).toEqual([]);
  });

  it("carries deployment and site name onto each candidate", async () => {
    const { drawStratifiedSample } = await import("@/lib/birdnet-validation/sampling");
    seedDetections(SPECIES, [0.55], [2]);

    const { candidates } = await drawStratifiedSample({
      species: SPECIES,
      ctProjects: [ctProjectId],
      binCount: 9,
      target: 5,
      seed: 3,
    });

    expect(candidates[0].deploymentId).toBe(deploymentIds[2]);
    expect(candidates[0].siteName).toBe("SMP-002");
    expect(candidates[0].binIndex).toBe(4);
  });
});
