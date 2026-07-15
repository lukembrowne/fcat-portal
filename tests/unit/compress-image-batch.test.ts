/**
 * Unit tests for compressImageBatch (cache-only and Drive upload modes).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createTestDb, seedTestData, testDbRef, setupIntegrationDbMock, type TestDb } from "../helpers/test-db";
import { setupAuthMocks, testUser, mockRequirePermission } from "../helpers/mock-auth";

setupAuthMocks();
setupIntegrationDbMock();

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Mock sharp — returns a smaller buffer by default
const mockSharpInstance = {
  keepExif: vi.fn().mockReturnThis(),
  jpeg: vi.fn().mockReturnThis(),
  toBuffer: vi.fn().mockResolvedValue(Buffer.alloc(500, "c")), // 500 bytes (smaller than 1000)
  metadata: vi.fn().mockResolvedValue({ width: 100, height: 100, format: "jpeg" }),
};
vi.mock("sharp", () => ({
  default: vi.fn(() => mockSharpInstance),
}));

const mockReadFile = vi.fn();
const mockWriteFile = vi.fn();
const mockMkdir = vi.fn();
const mockUnlink = vi.fn();
vi.mock("fs", () => ({
  promises: {
    readFile: (...args: unknown[]) => mockReadFile(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    unlink: (...args: unknown[]) => mockUnlink(...args),
    readdir: vi.fn(() => []),
    rm: vi.fn(),
    stat: vi.fn(),
    access: vi.fn(),
  },
}));

const mockDownloadFileToBuffer = vi.fn();
const mockUpdateFileContent = vi.fn();
vi.mock("@/lib/drive-client", () => ({
  downloadFileToBuffer: (...args: unknown[]) => mockDownloadFileToBuffer(...args),
  updateFileContent: (...args: unknown[]) => mockUpdateFileContent(...args),
  listDeploymentFolders: vi.fn(),
  listMediaRecursive: vi.fn(),
  isValidFolderId: vi.fn(),
  checkDeploymentUploads: vi.fn(),
  getFileRevisions: vi.fn(),
  downloadFileRevision: vi.fn(),
  uploadFramesToDrive: vi.fn(),
}));

// Mock ML modules (needed because drive-actions imports processingJobs which actions.ts uses with ML)
vi.mock("@/lib/ml-runner", () => ({
  runMLPredictions: vi.fn(),
  checkPytorchWildlife: vi.fn(),
  cancelModelServerJob: vi.fn(),
}));

vi.mock("@/lib/drive-downloader", () => ({
  downloadDeploymentForProcessing: vi.fn(),
  downloadVideosForProcessing: vi.fn(),
  cleanupJobTempDir: vi.fn(),
}));

vi.mock("@/lib/frame-extractor", () => ({
  extractFrames: vi.fn(),
  cancelFrameExtraction: vi.fn(),
}));

vi.mock("@/lib/ml-defaults", () => ({
  ML_DEFAULTS: {
    detectorModel: "MDV6-yolov9-c",
    classifierModel: "AI4GAmazonRainforest",
    confidenceThreshold: 0.1,
  },
}));

const driveActions = await import("@/app/camera-trap/drive-actions");

let db: ReturnType<typeof createTestDb>;
let seed: ReturnType<typeof seedTestData>;

beforeEach(() => {
  vi.clearAllMocks();
  db = createTestDb();
  testDbRef.current = db;
  seed = seedTestData(db);
  mockRequirePermission.mockResolvedValue(testUser);

  // Default: readFile returns a 1000-byte buffer (original image)
  mockReadFile.mockResolvedValue(Buffer.alloc(1000, "o"));
  mockWriteFile.mockResolvedValue(undefined);
  mockMkdir.mockResolvedValue(undefined);
  mockUnlink.mockResolvedValue(undefined);
  mockDownloadFileToBuffer.mockResolvedValue(Buffer.alloc(1000, "o"));
  mockUpdateFileContent.mockResolvedValue(undefined);
});

describe("compressImageBatch", () => {
  const FIXTURE_MODIFIED = new Date("2026-03-12T15:35:25.000Z");
  function makeImageInput(overrides?: Partial<{ driveFileId: string | null; path: string | null }>) {
    return [{
      id: seed.images[0].id,
      filename: "IMG_001.jpg",
      path: overrides?.path ?? "/cache/1/IMG_001.jpg",
      driveFileId: overrides?.driveFileId ?? "drive-file-1",
      deploymentId: seed.deployment.id,
      fileModified: FIXTURE_MODIFIED,
    }];
  }

  it("compresses images and writes to cache when uploadToDrive=false", async () => {
    const imgs = makeImageInput();
    const result = await driveActions.compressImageBatch(
      imgs,
      { uploadToDrive: false, jobId: seed.job.id, deploymentId: seed.deployment.id },
    );

    expect(result.compressed).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.savedBytes).toBeGreaterThan(0);

    // Should write to cache
    expect(mockWriteFile).toHaveBeenCalled();

    // Should NOT upload to Drive
    expect(mockUpdateFileContent).not.toHaveBeenCalled();
  });

  it("compresses images and uploads to Drive when uploadToDrive=true", async () => {
    const imgs = makeImageInput();
    const result = await driveActions.compressImageBatch(
      imgs,
      { uploadToDrive: true, jobId: seed.job.id, deploymentId: seed.deployment.id },
    );

    expect(result.compressed).toBe(1);
    expect(result.failed).toBe(0);

    // Should upload to Drive, forwarding the original modifiedTime so the
    // re-upload doesn't reset it to the compression date.
    expect(mockUpdateFileContent).toHaveBeenCalledWith("drive-file-1", expect.any(Buffer), "image/jpeg", FIXTURE_MODIFIED);

    // Should also write to cache
    expect(mockWriteFile).toHaveBeenCalled();
  });

  it("marks images as compressed in DB", async () => {
    const imgs = makeImageInput();
    await driveActions.compressImageBatch(
      imgs,
      { uploadToDrive: false, jobId: seed.job.id, deploymentId: seed.deployment.id },
    );

    const [img] = db
      .select()
      .from(schema.images)
      .where(eq(schema.images.id, seed.images[0].id))
      .all();

    expect(img.compressed).toBe(true);
    expect(img.originalFileSize).toBe(1000);
  });

  it("skips upload when compressed >= original size", async () => {
    // Make sharp return a buffer LARGER than original
    mockSharpInstance.toBuffer.mockResolvedValueOnce(Buffer.alloc(2000, "b"));

    const imgs = makeImageInput();
    const result = await driveActions.compressImageBatch(
      imgs,
      { uploadToDrive: true, jobId: seed.job.id, deploymentId: seed.deployment.id },
    );

    expect(result.compressed).toBe(1);
    expect(result.savedBytes).toBe(0);
    expect(mockUpdateFileContent).not.toHaveBeenCalled();

    // Should still mark as compressed in DB
    const [img] = db
      .select()
      .from(schema.images)
      .where(eq(schema.images.id, seed.images[0].id))
      .all();
    expect(img.compressed).toBe(true);
  });

  it("reports progress via callback", async () => {
    const imgs = makeImageInput();
    const onProgress = vi.fn();

    await driveActions.compressImageBatch(
      imgs,
      { uploadToDrive: false, jobId: seed.job.id, deploymentId: seed.deployment.id },
      onProgress,
    );

    expect(onProgress).toHaveBeenCalledWith(
      1,        // compressed
      0,        // failed
      expect.any(Number), // savedBytes
    );
  });
});
