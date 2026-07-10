import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadImageBytes, type LoadableImage } from "@/lib/external/image-bytes";
import * as frameCache from "@/lib/external/frame-cache";
import * as driveClient from "@/lib/drive-client";

/**
 * loadImageBytes resolves export-candidate bytes across three sources: the local
 * cache, a lazy external re-download, and the Drive fallback. The external
 * re-download branch is the new behaviour — it turns data/external into a
 * regenerable cache so frames can be cleared and refetched on demand.
 */

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "image-bytes-test-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

function externalRow(over: Partial<LoadableImage> = {}): LoadableImage {
  return {
    imageId: 1,
    filename: "img.jpg",
    imagePath: path.join(tmpRoot, "wcs", "img.jpg"),
    driveFileId: null,
    isExternal: true,
    sourceUrl: "https://lila.example/wcs/img.jpg",
    ...over,
  };
}

describe("loadImageBytes", () => {
  it("re-downloads a missing external frame from its sourceUrl, then reads it", async () => {
    const row = externalRow();
    // Stub the shared downloader to materialise the cache file (simulates fetch).
    const dl = vi
      .spyOn(frameCache, "downloadExternalFrame")
      .mockImplementation(async (_url, dest) => {
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, Buffer.from("rehydrated-bytes"));
      });

    const buf = await loadImageBytes(row);

    expect(dl).toHaveBeenCalledWith(row.sourceUrl, row.imagePath);
    expect(buf.toString()).toBe("rehydrated-bytes");
  });

  it("reads the cached file without re-downloading when it already exists", async () => {
    const row = externalRow();
    await fs.mkdir(path.dirname(row.imagePath!), { recursive: true });
    await fs.writeFile(row.imagePath!, Buffer.from("warm-cache"));
    const dl = vi.spyOn(frameCache, "downloadExternalFrame");

    const buf = await loadImageBytes(row);

    expect(dl).not.toHaveBeenCalled();
    expect(buf.toString()).toBe("warm-cache");
  });

  it("throws (skip-with-warning) for an external row with a missing file and null sourceUrl", async () => {
    const row = externalRow({ sourceUrl: null });
    const dl = vi.spyOn(frameCache, "downloadExternalFrame");

    await expect(loadImageBytes(row)).rejects.toThrow(/no local path and no driveFileId/);
    expect(dl).not.toHaveBeenCalled();
  });

  it("falls through to Drive for a non-external row with a missing cache file", async () => {
    const row: LoadableImage = {
      imageId: 7,
      filename: "fcat.jpg",
      imagePath: path.join(tmpRoot, "missing", "fcat.jpg"),
      driveFileId: "drive-abc",
      isExternal: false,
      sourceUrl: null,
    };
    const dl = vi.spyOn(frameCache, "downloadExternalFrame");
    const drive = vi
      .spyOn(driveClient, "downloadFileToBuffer")
      .mockResolvedValue(Buffer.from("drive-bytes"));

    const buf = await loadImageBytes(row);

    expect(dl).not.toHaveBeenCalled();
    expect(drive).toHaveBeenCalledWith("drive-abc");
    expect(buf.toString()).toBe("drive-bytes");
  });
});
