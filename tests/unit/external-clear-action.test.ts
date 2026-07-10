import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Guard tests for clearLilaImages: it must refuse to delete the frame cache
 * while an export or import job is in flight (R4), and otherwise clear and
 * report the freed total. The DB select chain and frame-cache are mocked so we
 * exercise the guard branch deterministically without disk or a real DB.
 */

const activeJobs: { current: Array<{ id: number }> } = { current: [] };

vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({
            all: () => activeJobs.current,
          }),
        }),
      }),
    }),
  },
}));

vi.mock("@/db/schema", () => ({
  processingJobs: { id: "id", jobType: "jobType", status: "status" },
  deployments: "deployments",
  images: "images",
  detections: "detections",
  identifications: "identifications",
}));

vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  inArray: (...a: unknown[]) => a,
  eq: (...a: unknown[]) => a,
  sql: Object.assign((...a: unknown[]) => a, { raw: (...a: unknown[]) => a }),
}));

// Keep the import chain light — the import action's deps aren't under test here.
vi.mock("@/lib/external/import-job", () => ({ processExternalImportJob: vi.fn() }));
vi.mock("@/lib/external/datasets", () => ({
  LILA_DATASETS: {},
  DEFAULT_REQUESTED_CLASSES: [],
}));

vi.mock("@/lib/auth", () => ({
  requireAdmin: vi.fn(async () => ({ email: "admin@fcat-ecuador.org" })),
}));

vi.mock("@/lib/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const clearExternalCache = vi.fn(async () => ({ bytes: 4096, fileCount: 7 }));
vi.mock("@/lib/external/frame-cache", () => ({
  clearExternalCache: () => clearExternalCache(),
}));

import { clearLilaImages } from "@/app/camera-trap/training-exports/lila-actions";

beforeEach(() => {
  activeJobs.current = [];
  clearExternalCache.mockClear();
});

describe("clearLilaImages", () => {
  it("clears the cache and returns the freed total when no job is running", async () => {
    const res = await clearLilaImages();
    expect(res).toEqual({ success: true, freedBytes: 4096, fileCount: 7 });
    expect(clearExternalCache).toHaveBeenCalledOnce();
  });

  it("refuses (deletes nothing) while an export/import job is in progress", async () => {
    activeJobs.current = [{ id: 99 }];
    const res = await clearLilaImages();
    expect(res.success).toBe(false);
    expect(clearExternalCache).not.toHaveBeenCalled();
  });
});
