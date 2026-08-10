/**
 * Permission guard tests for camera-trap server actions.
 *
 * Verifies every exported function calls requirePermission("camera-trap", ...)
 * with the correct minimum role before doing any work.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  mockRequirePermission,
  setupAuthMocks,
  testUser,
} from "../helpers/mock-auth";
import { setupDbMock } from "../helpers/mock-db";

// --- Module-level mocks (must be before action imports) ---

setupAuthMocks();
setupDbMock();

vi.mock("@/db/schema", () => ({
  users: "users",
  projects: "projects",
  userPermissions: "userPermissions",
  deployments: "deployments",
  processingJobs: "processingJobs",
  images: "images",
  videos: "videos",
  detections: "detections",
  identifications: "identifications",
  species: "species",
  activityLog: "activityLog",
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  desc: vi.fn(),
  inArray: vi.fn(),
  and: vi.fn(),
  gte: vi.fn(),
  ne: vi.fn(),
  sql: Object.assign(vi.fn(), { raw: vi.fn() }),
  count: vi.fn(),
  sum: vi.fn(),
  isNotNull: vi.fn(),
}));

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

vi.mock("@/lib/drive-client", () => ({
  uploadFramesToDrive: vi.fn(),
}));

vi.mock("@/lib/frame-extractor", () => ({
  extractFrames: vi.fn(),
  cancelFrameExtraction: vi.fn(),
}));

vi.mock("@/lib/ml-defaults", () => ({
  ML_DEFAULTS: {
    minConfidence: 0.5,
    modelName: "test",
  },
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    readdir: vi.fn(() => []),
    mkdir: vi.fn(),
    rm: vi.fn(),
    stat: vi.fn(),
    access: vi.fn(),
  },
}));

// --- Import actions AFTER mocks ---

const actions = await import("@/app/camera-trap/actions");

// --- Tests ---

describe("camera-trap action permission guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequirePermission.mockResolvedValue(testUser);
  });

  async function callAndExpectPermission(
    fn: Function,
    role: "viewer" | "editor",
    args: unknown[] = []
  ) {
    try {
      await fn(...args);
    } catch {
      // Actions may throw after permission check due to mocked DB — that's fine.
      // We only care that requirePermission was called first.
    }
    expect(mockRequirePermission).toHaveBeenCalledWith("camera-trap", role);
  }

  // ===== Editor-level actions =====

  describe("editor-level actions", () => {
    const editorActions: [string, Function, unknown[]][] = [
      ["createProcessingJob", actions.createProcessingJob, [1]],
      ["processJob", actions.processJob, [1]],
      ["cancelJob", actions.cancelJob, [1]],
      ["deleteJob", actions.deleteJob, [1]],
      ["deleteJobs", actions.deleteJobs, [[1, 2]]],
      ["updateDeploymentMetadata", actions.updateDeploymentMetadata, [1, {}]],
      ["bulkUpdateMetadata", actions.bulkUpdateMetadata, [[1], {}]],
      ["deleteDeployments", actions.deleteDeployments, [[1]]],
      ["markVerifiedEmpty", actions.markVerifiedEmpty, [[1]]],
      ["undoVerifiedEmpty", actions.undoVerifiedEmpty, [[1]]],
      ["markNoData", actions.markNoData, [1]],
      ["undoNoData", actions.undoNoData, [1]],
      ["queueProcessing", actions.queueProcessing, [[1]]],
      ["cancelQueue", actions.cancelQueue, []],
      ["verifyIdentification", actions.verifyIdentification, [1]],
      ["rejectIdentification", actions.rejectIdentification, [1]],
      ["correctIdentification", actions.correctIdentification, [1, 1]],
      ["bulkVerify", actions.bulkVerify, [[1]]],
      ["bulkVerifyByThreshold", actions.bulkVerifyByThreshold, [1, 0.9]],
      ["createSpecies", actions.createSpecies, [{ commonName: "Test", scientificName: "Test" }]],
      ["updateSpecies", actions.updateSpecies, [1, { commonName: "Updated" }]],
      ["deleteSpecies", actions.deleteSpecies, [1]],
      ["deleteDetection", actions.deleteDetection, [1, 1]],
      ["assignSpecies", actions.assignSpecies, [1, 1, 1]],
      ["createManualDetection", actions.createManualDetection, [1, { x: 0, y: 0, width: 1, height: 1, speciesId: 1 }]],
      ["verifyAndAdvance", actions.verifyAndAdvance, [1, 1, "verified", undefined]],
      ["toggleConfirmedBlank", actions.toggleConfirmedBlank, [1, true, 1]],
    ];

    for (const [name, fn, args] of editorActions) {
      it(`${name} requires editor permission`, () =>
        callAndExpectPermission(fn, "editor", args));
    }
  });

  // ===== Viewer-level actions =====

  describe("viewer-level actions", () => {
    const viewerActions: [string, Function, unknown[]][] = [
      ["getMLStatus", actions.getMLStatus, []],
      ["getJobDeleteStats", actions.getJobDeleteStats, [1]],
      ["getJobsDeleteStats", actions.getJobsDeleteStats, [[1]]],
      ["getDeploymentsWithStats", actions.getDeploymentsWithStats, []],
      ["getDeployments", actions.getDeployments, [[1]]],
      ["getDeploymentsCascadeStats", actions.getDeploymentsCascadeStats, [[1]]],
      ["getDistinctProjects", actions.getDistinctProjects, []],
      ["getDeployment", actions.getDeployment, [1]],
      ["getRecentJobs", actions.getRecentJobs, []],
      ["getResultsStats", actions.getResultsStats, []],
      ["getJobWithDetails", actions.getJobWithDetails, [1]],
      ["getImageWithDetections", actions.getImageWithDetections, [1]],
      ["getJobImageIds", actions.getJobImageIds, [1]],
      ["getSpeciesList", actions.getSpeciesList, []],
      ["getJobSpecies", actions.getJobSpecies, [1]],
      ["getNextUnverifiedImageId", actions.getNextUnverifiedImageId, [1]],
      ["getJobVerificationStats", actions.getJobVerificationStats, [1]],
      ["getDeploymentVerificationStats", actions.getDeploymentVerificationStats, [1]],
      ["getSpeciesUsageCount", actions.getSpeciesUsageCount, [1]],
      ["getFrequentSpecies", actions.getFrequentSpecies, []],
    ];

    for (const [name, fn, args] of viewerActions) {
      it(`${name} requires viewer permission`, () =>
        callAndExpectPermission(fn, "viewer", args));
    }
  });
});
