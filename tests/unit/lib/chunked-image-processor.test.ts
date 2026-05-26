/**
 * Tests for processDeploymentImagesChunked — the disk-bounded download→ML→release
 * loop. Verifies cumulative progress offset (C1), per-chunk release, and the
 * cancelled / anyFailed finalize flags (M4).
 *
 * The drive-downloader I/O primitives, ml-runner, and db are mocked; grouping is
 * stubbed to 2-per-chunk so the loop runs deterministically.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MLConfig, MLRunResult } from "@/lib/ml-runner";

vi.mock("server-only", () => ({}));

// Recording stub for db.update(...).set(...).where(...)
const setPayloads: Array<Record<string, unknown>> = [];
vi.mock("@/db", () => ({
  db: {
    update: () => ({
      set: (v: Record<string, unknown>) => {
        setPayloads.push(v);
        return { where: () => undefined };
      },
    }),
  },
}));
vi.mock("@/db/schema", () => ({ processingJobs: {} }));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const releaseCalls: number[][] = [];
const downloadCalls: number[][] = [];
vi.mock("@/lib/drive-downloader", () => ({
  // Deterministic 2-per-chunk grouping for the loop test.
  groupRowsIntoChunks: (rows: Array<{ id: number }>) => {
    const out: Array<Array<{ id: number }>> = [];
    for (let i = 0; i < rows.length; i += 2) out.push(rows.slice(i, i + 2));
    return out;
  },
  downloadImageSet: vi.fn(async (_cacheDir, _dep, _job, chunk: Array<{ id: number; filename: string }>) => {
    downloadCalls.push(chunk.map((r) => r.id));
    return {
      downloaded: chunk.length,
      skipped: 0,
      failed: 0,
      localPaths: chunk.map((r) => `/cache/${r.filename}`),
    };
  }),
  releaseChunkFiles: vi.fn(async (_cacheDir, chunk: Array<{ id: number }>) => {
    releaseCalls.push(chunk.map((r) => r.id));
  }),
  getFreeDiskBytes: vi.fn(async () => 100 * 1024 * 1024 * 1024),
  diskFits: () => true,
  evictIfOverLimit: vi.fn(async () => undefined),
  InsufficientDiskError: class extends Error {},
}));

const mlConfigs: MLConfig[] = [];
let mlImpl: (jobId: number, config: MLConfig) => Promise<MLRunResult>;
vi.mock("@/lib/ml-runner", () => ({
  runMLPredictions: vi.fn(async (jobId: number, config: MLConfig) => {
    mlConfigs.push(config);
    return mlImpl(jobId, config);
  }),
}));

const { processDeploymentImagesChunked } = await import("@/lib/chunked-image-processor");

type Row = { id: number; filename: string; driveFileId: string; fileSize: number };
function rows(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    filename: `img${i + 1}.jpg`,
    driveFileId: `d${i + 1}`,
    fileSize: 1024,
  }));
}

const baseConfig = {
  detectorModel: "det",
  classifierModel: "cls",
  device: "auto",
  confidenceThreshold: 0.5,
  batchSize: 1,
  numWorkers: 1,
};

function run(opts: {
  rowCount: number;
  checkCancelled?: () => Promise<boolean>;
}) {
  return processDeploymentImagesChunked({
    deploymentId: 131,
    jobId: 7,
    cacheDir: "/cache/131",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rows: rows(opts.rowCount) as any,
    mlConfigBase: baseConfig,
    checkCancelled: opts.checkCancelled ?? (async () => false),
  });
}

beforeEach(() => {
  setPayloads.length = 0;
  releaseCalls.length = 0;
  downloadCalls.length = 0;
  mlConfigs.length = 0;
  mlImpl = async (_jobId, config) => ({
    success: true,
    totalProcessed: config.imagePaths.length,
    totalDetections: config.imagePaths.length, // 1 detection each, for assertion
  });
});

describe("processDeploymentImagesChunked", () => {
  it("processes all chunks, releasing each, accumulating totals", async () => {
    const outcome = await run({ rowCount: 5 }); // chunks: [2,2,1]
    expect(outcome.cancelled).toBe(false);
    expect(outcome.anyFailed).toBe(false);
    expect(outcome.totalProcessed).toBe(5);
    expect(outcome.totalDetections).toBe(5);
    // every chunk downloaded and released, in order
    expect(downloadCalls).toEqual([[1, 2], [3, 4], [5]]);
    expect(releaseCalls).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("C1: passes a cumulative progressOffset and the full total to each chunk's ML call", async () => {
    await run({ rowCount: 5 });
    expect(mlConfigs.map((c) => c.progressOffset)).toEqual([0, 2, 4]);
    expect(mlConfigs.every((c) => c.progressTotal === 5)).toBe(true);
    // imagePaths come from downloadImageSet's localPaths for that chunk
    expect(mlConfigs[0].imagePaths).toEqual(["/cache/img1.jpg", "/cache/img2.jpg"]);
    expect(mlConfigs[2].imagePaths).toEqual(["/cache/img5.jpg"]);
  });

  it("M4: sets anyFailed when a chunk's ML reports failure (and keeps going)", async () => {
    mlImpl = async (_jobId, config) => ({
      success: config.progressOffset !== 2, // chunk 2 (offset 2) fails
      totalProcessed: config.imagePaths.length,
      totalDetections: 0,
    });
    const outcome = await run({ rowCount: 5 });
    expect(outcome.cancelled).toBe(false);
    expect(outcome.anyFailed).toBe(true);
    // loop continued through all chunks despite the failure
    expect(releaseCalls).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("M4: stops and reports cancelled when checkCancelled flips mid-loop", async () => {
    let calls = 0;
    const checkCancelled = async () => {
      // false for chunk 1's pre-check, true before chunk 2
      calls++;
      return calls > 1;
    };
    const outcome = await run({ rowCount: 6, checkCancelled }); // chunks [2,2,2]
    expect(outcome.cancelled).toBe(true);
    // only chunk 1 was processed/released before cancellation
    expect(releaseCalls).toEqual([[1, 2]]);
    expect(outcome.totalProcessed).toBe(2);
  });

  it("treats ML failure during cancellation as cancelled, not failed", async () => {
    let mlCount = 0;
    mlImpl = async (_jobId, config) => {
      mlCount++;
      return { success: mlCount < 2, totalProcessed: config.imagePaths.length, totalDetections: 0 };
    };
    let cancelChecks = 0;
    const checkCancelled = async () => {
      cancelChecks++;
      // pass the loop-top checks (chunk1, chunk2), then report cancelled when
      // re-checked after chunk 2's ML returns success:false.
      return cancelChecks > 2;
    };
    const outcome = await run({ rowCount: 4, checkCancelled }); // chunks [2,2]
    expect(outcome.cancelled).toBe(true);
    expect(outcome.anyFailed).toBe(false);
  });
});
