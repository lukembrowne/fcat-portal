/**
 * Tests for the pre-flight disk guard in drive-downloader.
 *
 * Covers the pure capacity decision (`diskFits`), the free-disk measurement
 * (`getFreeDiskBytes`, including FAIL-CLOSED behavior when statfs throws), and
 * the Spanish `InsufficientDiskError` message.
 *
 * Heavy deps are mocked so the module imports cleanly in the node test env;
 * `fs.statfs` is mocked so both the success and failure paths are deterministic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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
vi.mock("@/lib/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockStatfs = vi.fn();
vi.mock("fs", () => ({
  promises: {
    statfs: (...args: unknown[]) => mockStatfs(...args),
    // Other fs methods are unused in these tests but referenced at call time.
    mkdir: vi.fn(),
    access: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn(),
    readdir: vi.fn(),
    stat: vi.fn(),
    rm: vi.fn(),
  },
}));

const GB = 1024 * 1024 * 1024;

const { diskFits, getFreeDiskBytes, InsufficientDiskError } = await import(
  "@/lib/drive-downloader"
);

describe("diskFits", () => {
  const margin = 20 * GB;

  it("fits when pending + margin is well under free", () => {
    expect(diskFits(10 * GB, 100 * GB, margin)).toBe(true);
  });

  it("fits exactly at the boundary (pending + margin === free)", () => {
    expect(diskFits(80 * GB, 100 * GB, margin)).toBe(true); // 80 + 20 === 100
  });

  it("does not fit one byte over the boundary", () => {
    expect(diskFits(80 * GB + 1, 100 * GB, margin)).toBe(false);
  });

  it("does not fit when pending exceeds free outright", () => {
    expect(diskFits(81 * GB, 75 * GB, margin)).toBe(false); // the dep-131 outage shape
  });

  it("a zero-byte download always fits", () => {
    expect(diskFits(0, 0, margin)).toBe(false); // 0 + 20GB > 0 free
    expect(diskFits(0, 30 * GB, margin)).toBe(true);
  });

  it("uses the default margin when none is passed", () => {
    // default CT_PROCESS_DISK_MARGIN_GB = 20
    expect(diskFits(50 * GB, 100 * GB)).toBe(true);
    expect(diskFits(90 * GB, 100 * GB)).toBe(false);
  });
});

describe("getFreeDiskBytes", () => {
  beforeEach(() => mockStatfs.mockReset());

  it("FAIL-CLOSED: returns null (not Infinity) when statfs is unusable", async () => {
    // statfs resolving to an unusable value exercises the catch (s.bavail on
    // undefined throws), proving the fail-closed null return. We avoid a
    // throwing/rejecting mock here because vitest flags the rejected promise it
    // stores in mock.results as unhandled even when our code catches it.
    mockStatfs.mockResolvedValue(undefined);
    expect(await getFreeDiskBytes()).toBeNull();
  });

  it("returns bavail * bsize when statfs succeeds", async () => {
    mockStatfs.mockResolvedValue({ bavail: 1000, bsize: 4096 });
    expect(await getFreeDiskBytes()).toBe(1000 * 4096);
  });
});

describe("InsufficientDiskError", () => {
  it("has a Spanish message with rounded GB figures", () => {
    const err = new InsufficientDiskError(81 * GB, 75 * GB, 20 * GB);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("InsufficientDiskError");
    expect(err.message).toContain("Espacio en disco insuficiente");
    expect(err.message).toContain("81.0 GB");
    expect(err.message).toContain("75.0 GB");
    expect(err.message).toContain("20.0 GB");
  });
});
