/**
 * Tests for the chunked-processing pure helpers: groupRowsIntoChunks (byte-budget
 * grouping) and filterDownloadableRows (drive-backed, safe, under size cap).
 *
 * Heavy deps mocked so the module imports cleanly in the node test env.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/db/schema", () => ({ images: {}, videos: {} }));
vi.mock("@/lib/drive-client", () => ({ downloadDeploymentImages: vi.fn() }));
vi.mock("@/lib/thumbnail", () => ({
  THUMBNAIL_DIR: "/tmp/thumbnails",
  THUMBNAIL_WIDTH: 400,
  THUMBNAIL_QUALITY: 80,
  thumbnailPath: vi.fn(),
  evictThumbnailsIfOverLimit: vi.fn(),
}));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("fs", () => ({ promises: { statfs: vi.fn(), access: vi.fn(), mkdir: vi.fn() } }));

const MB = 1024 * 1024;
const GB = 1024 * MB;

const { groupRowsIntoChunks, filterDownloadableRows } = await import("@/lib/drive-downloader");
import type { ImageRow } from "@/lib/drive-downloader";

function row(over: Partial<ImageRow>): ImageRow {
  return {
    id: 1,
    filename: "img.jpg",
    driveFileId: "drive-1",
    fileSize: 5 * MB,
    ...over,
  } as ImageRow;
}

describe("groupRowsIntoChunks", () => {
  it("returns [] for no rows", () => {
    expect(groupRowsIntoChunks([], 10 * GB)).toEqual([]);
  });

  it("keeps each chunk's cumulative size under the target", () => {
    // 30 rows × 1 GB, target 10 GB → ~3 chunks of ≤10 each.
    const rows = Array.from({ length: 30 }, (_, i) => row({ id: i, fileSize: 1 * GB }));
    const chunks = groupRowsIntoChunks(rows, 10 * GB);
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) {
      const sum = chunk.reduce((s, r) => s + (r.fileSize ?? 0), 0);
      expect(sum).toBeLessThanOrEqual(10 * GB);
    }
    expect(chunks.flat().length).toBe(30);
  });

  it("uses the null-size fallback when file_size is null/0", () => {
    // 10 rows × 20 MB fallback, target 50 MB → 2 rows/chunk (40≤50, 60>50) = 5.
    const rows = Array.from({ length: 10 }, (_, i) => row({ id: i, fileSize: null }));
    const chunks = groupRowsIntoChunks(rows, 50 * MB, 20 * MB);
    expect(chunks.length).toBe(5);
    expect(chunks.flat().length).toBe(10);
  });

  it("gives a single oversize file its own chunk", () => {
    const rows = [
      row({ id: 1, fileSize: 2 * MB }),
      row({ id: 2, fileSize: 50 * GB }), // larger than the 10 GB target
      row({ id: 3, fileSize: 2 * MB }),
    ];
    const chunks = groupRowsIntoChunks(rows, 10 * GB);
    // row 1 in chunk 0; row 2 forces a new chunk (own); row 3 starts another.
    expect(chunks.length).toBe(3);
    expect(chunks[1]).toHaveLength(1);
    expect(chunks[1][0].id).toBe(2);
  });

  it("packs small rows into one chunk when they fit", () => {
    const rows = Array.from({ length: 5 }, (_, i) => row({ id: i, fileSize: 1 * MB }));
    const chunks = groupRowsIntoChunks(rows, 10 * GB);
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toHaveLength(5);
  });
});

describe("filterDownloadableRows", () => {
  const cacheDir = "/data/cache/ct-images/131";

  it("keeps drive-backed, safe, under-cap rows", () => {
    const rows = [row({ id: 1, driveFileId: "d1", filename: "a.jpg", fileSize: 5 * MB })];
    expect(filterDownloadableRows(cacheDir, rows)).toHaveLength(1);
  });

  it("drops rows without a driveFileId", () => {
    const rows = [row({ id: 1, driveFileId: null })];
    expect(filterDownloadableRows(cacheDir, rows)).toHaveLength(0);
  });

  it("drops rows with unsafe filenames (path traversal)", () => {
    const rows = [row({ id: 1, filename: "../escape.jpg" })];
    expect(filterDownloadableRows(cacheDir, rows)).toHaveLength(0);
  });

  it("drops rows over the per-file size cap (100 MB)", () => {
    const rows = [row({ id: 1, fileSize: 200 * MB })];
    expect(filterDownloadableRows(cacheDir, rows)).toHaveLength(0);
  });
});
