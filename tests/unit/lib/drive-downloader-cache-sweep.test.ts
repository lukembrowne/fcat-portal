/**
 * Tests for `sweepOrphanedCache` — the independent orphaned-cache reclaim.
 *
 * Uses the real in-memory DB (so `findBusyDeploymentIds` runs for real) and
 * mocks only the filesystem + drive-downloader's heavy import deps. Asserts:
 *   - an orphan dir (no active/pending job) is deleted and its image paths nulled
 *   - a busy dir (active job) is never touched
 *   - non-id and empty dirs are skipped without error
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "path";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  createTestDb,
  testDbRef,
  setupIntegrationDbMock,
} from "../../helpers/test-db";

vi.mock("server-only", () => ({}));
setupIntegrationDbMock();
vi.mock("@/lib/drive-client", () => ({ downloadDeploymentImages: vi.fn() }));
vi.mock("@/lib/thumbnail", () => ({
  THUMBNAIL_DIR: "/tmp/thumbnails",
  THUMB_TIER: { suffix: "", longEdge: 400, quality: 80 },
  ANNOTATE_TIER: { suffix: "@1920", longEdge: 1920, quality: 80 },
  sizedPath: vi.fn(() => "/tmp/thumbnails/x.jpg"),
  resizeForTier: vi.fn(async () => Buffer.from("x")),
  evictDerivativesIfOverLimit: vi.fn(),
}));
vi.mock("@/lib/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Filesystem stand-in. Keys are absolute paths; names must start with `mock` so
// vitest allows referencing them inside the hoisted vi.mock factory.
const mockDirTree: Record<string, string[]> = {};
const mockFileSizes: Record<string, number> = {};
const mockRemoved: string[] = [];

vi.mock("fs", () => ({
  promises: {
    readdir: async (p: string) => {
      if (p in mockDirTree) return mockDirTree[p];
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    stat: async (p: string) => {
      if (p in mockFileSizes) {
        return { isDirectory: () => false, size: mockFileSizes[p], mtime: new Date(0) };
      }
      return { isDirectory: () => true, size: 0, mtime: new Date(0) };
    },
    rm: async (p: string) => {
      mockRemoved.push(p);
    },
    mkdir: vi.fn(),
    access: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn(),
  },
}));

const CACHE_BASE = path.join(process.cwd(), "data", "cache", "ct-images");
const { sweepOrphanedCache } = await import("@/lib/drive-downloader");

function resetFs() {
  for (const k of Object.keys(mockDirTree)) delete mockDirTree[k];
  for (const k of Object.keys(mockFileSizes)) delete mockFileSizes[k];
  mockRemoved.length = 0;
}

function seedProjectAndDeployments() {
  const db = testDbRef.current;
  const [ct] = db
    .insert(schema.cameraTrapProjects)
    .values({ name: "TestProject" })
    .returning()
    .all();
  const mkDep = (name: string) =>
    db
      .insert(schema.deployments)
      .values({
        projectId: "camera-trap",
        name,
        status: "processed",
        cameraTrapProjectId: ct.id,
      })
      .returning()
      .all()[0];
  return { busy: mkDep("BUSY-001"), orphan: mkDep("ORPHAN-001") };
}

describe("sweepOrphanedCache", () => {
  beforeEach(() => {
    testDbRef.current = createTestDb();
    resetFs();
  });

  it("deletes an orphan dir and nulls its image paths, leaving a busy dir untouched", async () => {
    const db = testDbRef.current;
    const { busy, orphan } = seedProjectAndDeployments();

    // Busy deployment has an active (processing) ML job → protected.
    db.insert(schema.processingJobs)
      .values({ deploymentId: busy.id, status: "processing", jobType: "ml" })
      .run();
    // Orphan deployment's job already completed → not active.
    db.insert(schema.processingJobs)
      .values({ deploymentId: orphan.id, status: "completed", jobType: "ml" })
      .run();

    // Both deployments have cached image rows on disk.
    for (const dep of [busy, orphan]) {
      db.insert(schema.images)
        .values({
          deploymentId: dep.id,
          filename: "IMG_001.jpg",
          status: "processed",
          path: `data/cache/ct-images/${dep.id}/IMG_001.jpg`,
        })
        .run();
    }

    // Filesystem: both dirs present under the cache base.
    mockDirTree[CACHE_BASE] = [String(busy.id), String(orphan.id)];
    const orphanDir = path.join(CACHE_BASE, String(orphan.id));
    mockDirTree[orphanDir] = ["IMG_001.jpg"];
    mockFileSizes[path.join(orphanDir, "IMG_001.jpg")] = 5 * 1024 * 1024;

    const result = await sweepOrphanedCache();

    expect(result.removed).toBe(1);
    expect(result.deployments).toEqual([orphan.id]);
    expect(result.bytes).toBe(5 * 1024 * 1024);
    // Only the orphan dir was removed.
    expect(mockRemoved).toEqual([orphanDir]);

    // Orphan image path nulled; busy image path intact.
    const orphanImg = db
      .select()
      .from(schema.images)
      .where(eq(schema.images.deploymentId, orphan.id))
      .all()[0];
    const busyImg = db
      .select()
      .from(schema.images)
      .where(eq(schema.images.deploymentId, busy.id))
      .all()[0];
    expect(orphanImg.path).toBeNull();
    expect(busyImg.path).toBe(`data/cache/ct-images/${busy.id}/IMG_001.jpg`);
  });

  it("protects a deployment with a PENDING audio job", async () => {
    const db = testDbRef.current;
    const { orphan } = seedProjectAndDeployments();
    // A queued (pending) audio job counts as busy.
    db.insert(schema.processingJobs)
      .values({ deploymentId: orphan.id, status: "pending", jobType: "birdnet" })
      .run();

    mockDirTree[CACHE_BASE] = [String(orphan.id)];

    const result = await sweepOrphanedCache();
    expect(result.removed).toBe(0);
    expect(mockRemoved).toEqual([]);
  });

  it("skips non-id directory names without error", async () => {
    seedProjectAndDeployments();
    mockDirTree[CACHE_BASE] = ["not-a-number", "07"]; // 07 !== String(7)
    const result = await sweepOrphanedCache();
    expect(result.removed).toBe(0);
    expect(mockRemoved).toEqual([]);
  });

  it("returns cleanly when the cache dir does not exist", async () => {
    const result = await sweepOrphanedCache();
    expect(result).toEqual({ removed: 0, bytes: 0, deployments: [] });
  });
});
