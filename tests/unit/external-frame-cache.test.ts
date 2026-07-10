import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

import {
  downloadExternalFrame,
  externalCacheStats,
  clearExternalCache,
  EXTERNAL_DIR,
} from "@/lib/external/frame-cache";

/**
 * Exercises the shared frame-cache download path: EXIF scrub, parent-dir
 * creation, and non-OK rejection. This is the one code path both the import job
 * (pre-warm) and the export step (lazy re-download) rely on, so a regression
 * here would silently desync re-downloaded frames from imported ones.
 */

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "frame-cache-test-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

/** A JPEG carrying an EXIF Copyright tag, to prove the re-encode strips it. */
async function jpegWithExif(): Promise<Buffer> {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 10, b: 10 } },
  })
    .withExif({ IFD0: { Copyright: "secret-gps-and-timestamps" } })
    .jpeg()
    .toBuffer();
}

function mockFetchOnce(body: Buffer, ok = true, status = 200) {
  vi.spyOn(global, "fetch").mockResolvedValue({
    ok,
    status,
    arrayBuffer: async () =>
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  } as unknown as Response);
}

describe("downloadExternalFrame", () => {
  it("downloads a frame and strips EXIF via the re-encode", async () => {
    const src = await jpegWithExif();
    expect((await sharp(src).metadata()).exif).toBeTruthy(); // sanity: source has EXIF

    mockFetchOnce(src);
    const dest = path.join(tmpRoot, "wcs", "img1.jpg");
    await downloadExternalFrame("https://lila.example/img1.jpg", dest);

    const out = await fs.readFile(dest);
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(8);
    expect(meta.exif).toBeUndefined(); // scrubbed
  });

  it("creates missing parent directories", async () => {
    mockFetchOnce(await jpegWithExif());
    const dest = path.join(tmpRoot, "deep", "nested", "dir", "img.jpg");
    await downloadExternalFrame("https://lila.example/x.jpg", dest);
    await expect(fs.stat(dest)).resolves.toMatchObject({ size: expect.any(Number) });
  });

  it("throws on a non-OK response so the caller can tally a failure", async () => {
    mockFetchOnce(Buffer.from("nope"), false, 404);
    const dest = path.join(tmpRoot, "img.jpg");
    await expect(
      downloadExternalFrame("https://lila.example/missing.jpg", dest),
    ).rejects.toThrow(/404/);
    await expect(fs.stat(dest)).rejects.toThrow();
  });
});

/** Cache stats + clear operate on a passed dir; never touch the real cache. */
async function seedFrames(root: string) {
  await fs.mkdir(path.join(root, "wcs"), { recursive: true });
  await fs.mkdir(path.join(root, "orinoquia"), { recursive: true });
  await fs.writeFile(path.join(root, "wcs", "a.jpg"), Buffer.alloc(100));
  await fs.writeFile(path.join(root, "wcs", "b.jpg"), Buffer.alloc(50));
  await fs.writeFile(path.join(root, "orinoquia", "c.jpg"), Buffer.alloc(30));
}

describe("externalCacheStats", () => {
  it("sums bytes and counts files across dataset subdirs", async () => {
    await seedFrames(tmpRoot);
    const stats = await externalCacheStats(tmpRoot);
    expect(stats).toEqual({ bytes: 180, fileCount: 3 });
  });

  it("returns zeros when the cache dir is absent", async () => {
    const stats = await externalCacheStats(path.join(tmpRoot, "does-not-exist"));
    expect(stats).toEqual({ bytes: 0, fileCount: 0 });
  });
});

describe("clearExternalCache", () => {
  it("removes all frames, recreates an empty dir, and returns the freed total", async () => {
    const cacheDir = path.join(tmpRoot, "cache");
    await seedFrames(cacheDir);

    const freed = await clearExternalCache(cacheDir);
    expect(freed).toEqual({ bytes: 180, fileCount: 3 });

    // Dir still exists but is empty.
    await expect(fs.stat(cacheDir)).resolves.toMatchObject({});
    expect(await externalCacheStats(cacheDir)).toEqual({ bytes: 0, fileCount: 0 });
  });

  it("is idempotent — a second clear returns zeros, not an error", async () => {
    const cacheDir = path.join(tmpRoot, "cache2");
    await seedFrames(cacheDir);
    await clearExternalCache(cacheDir);
    const second = await clearExternalCache(cacheDir);
    expect(second).toEqual({ bytes: 0, fileCount: 0 });
  });

  it("defaults to EXTERNAL_DIR which lives under data/external", () => {
    expect(EXTERNAL_DIR.endsWith(path.join("data", "external"))).toBe(true);
  });
});
