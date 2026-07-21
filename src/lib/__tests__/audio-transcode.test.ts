/**
 * Unit tests for the on-demand AAC transcode cache (`ensureAacTranscode`).
 *
 * These exercise the load-bearing guardrails from KTD-7 without invoking real
 * ffmpeg: single-flight (one transcode per audioId), atomic publish (temp →
 * rename), and cache-hit short-circuit. `child_process`, `fs`, and the Drive
 * downloader are mocked; we assert call counts, not ffmpeg output bytes.
 *
 * NOTE: mocks are declared in THIS file (never in an imported helper) — Vitest
 * hoists `vi.mock` from any imported file, which would leak these fakes.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

// ---- child_process.spawn fake -------------------------------------------
// Each spawn returns a fake process that emits `close(0)` on the next
// microtask (after the module has attached its listeners synchronously).
const spawnMock = vi.fn(
  (_bin: string, _args: readonly string[], _opts?: unknown) => {
    const proc = new EventEmitter() as EventEmitter & {
      stderr: EventEmitter;
      kill: () => void;
    };
    proc.stderr = new EventEmitter();
    proc.kill = vi.fn();
    queueMicrotask(() => proc.emit("close", 0));
    return proc;
  },
);

vi.mock("child_process", () => ({ spawn: spawnMock }));

// ---- fs.promises fake ----------------------------------------------------
const accessMock = vi.fn(async (_p: string) => undefined);
const mkdirMock = vi.fn(async (_p: string, _o?: unknown) => undefined);
const utimesMock = vi.fn(async (_p: string, _a: Date, _m: Date) => undefined);
const readdirMock = vi.fn(async (_p: string) => [] as string[]);
const statMock = vi.fn(
  async (_p: string) =>
    ({ isFile: () => true, size: 0, mtimeMs: 0 }) as {
      isFile: () => boolean;
      size: number;
      mtimeMs: number;
    },
);
const unlinkMock = vi.fn(async (_p: string) => undefined);
const renameMock = vi.fn(async (_from: string, _to: string) => undefined);

vi.mock("fs", () => ({
  promises: {
    access: accessMock,
    mkdir: mkdirMock,
    utimes: utimesMock,
    readdir: readdirMock,
    stat: statMock,
    unlink: unlinkMock,
    rename: renameMock,
  },
}));

// ---- Drive downloader fake ----------------------------------------------
const downloadFileMock = vi.fn(async (_id: string, _dest: string) => undefined);
vi.mock("@/lib/drive-client", () => ({
  downloadFile: downloadFileMock,
}));

vi.mock("@/lib/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { ensureAacTranscode } = await import("@/lib/audio-transcode");

beforeEach(() => {
  vi.clearAllMocks();
  // Default: cache miss.
  accessMock.mockRejectedValue(new Error("ENOENT"));
  readdirMock.mockResolvedValue([]);
});

describe("ensureAacTranscode", () => {
  it("cache hit short-circuits — no download, no ffmpeg", async () => {
    accessMock.mockResolvedValue(undefined); // file exists
    const out = await ensureAacTranscode({ audioId: 7, driveFileId: "drv-7" });

    expect(out.endsWith("7.m4a")).toBe(true);
    expect(downloadFileMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    // mtime bumped for LRU recency.
    expect(utimesMock).toHaveBeenCalledTimes(1);
  });

  it("cache miss: downloads, transcodes once, and publishes atomically via rename", async () => {
    const out = await ensureAacTranscode({ audioId: 42, driveFileId: "drv-42" });

    expect(downloadFileMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // ffmpeg targets AAC.
    const args = spawnMock.mock.calls[0][1];
    expect(args).toContain("aac");
    expect(args).toContain("+faststart");
    // Atomic publish: rename a temp file INTO the final cache path.
    expect(renameMock).toHaveBeenCalledTimes(1);
    const [from, to] = renameMock.mock.calls[0];
    expect(from).not.toBe(to);
    expect(to.endsWith("42.m4a")).toBe(true);
    expect(out.endsWith("42.m4a")).toBe(true);
  });

  it("second request hits the cache — ffmpeg runs only once", async () => {
    // First call: miss. Subsequent calls: hit.
    accessMock
      .mockRejectedValueOnce(new Error("ENOENT"))
      .mockResolvedValue(undefined);

    const first = await ensureAacTranscode({ audioId: 9, driveFileId: "drv-9" });
    const second = await ensureAacTranscode({ audioId: 9, driveFileId: "drv-9" });

    expect(first).toBe(second);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(downloadFileMock).toHaveBeenCalledTimes(1);
  });

  it("concurrent cache-miss requests are single-flighted — one ffmpeg, one rename", async () => {
    const p1 = ensureAacTranscode({ audioId: 5, driveFileId: "drv-5" });
    const p2 = ensureAacTranscode({ audioId: 5, driveFileId: "drv-5" });

    const [a, b] = await Promise.all([p1, p2]);

    expect(a).toBe(b);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(downloadFileMock).toHaveBeenCalledTimes(1);
    expect(renameMock).toHaveBeenCalledTimes(1);
  });

  it("evicts oldest .m4a entries when over the byte budget before writing", async () => {
    // Two existing cache files, oldest first should be unlinked.
    readdirMock.mockResolvedValue(["100.m4a", "200.m4a"]);
    const huge = 5 * 1024 * 1024 * 1024; // 5GB each → over the 2GB default cap
    statMock.mockImplementation(async (p: string) => ({
      isFile: () => true,
      size: huge,
      mtimeMs: p.includes("100.m4a") ? 1_000 : 2_000,
    }));

    await ensureAacTranscode({ audioId: 300, driveFileId: "drv-300" });

    // The oldest (100.m4a, mtime 1000) is evicted first.
    const unlinked = unlinkMock.mock.calls.map((c) => c[0] as string);
    expect(unlinked.some((p) => p.endsWith("100.m4a"))).toBe(true);
  });

  it("propagates a non-zero ffmpeg exit and does not publish", async () => {
    spawnMock.mockImplementationOnce(() => {
      const proc = new EventEmitter() as EventEmitter & {
        stderr: EventEmitter;
        kill: () => void;
      };
      proc.stderr = new EventEmitter();
      proc.kill = vi.fn();
      queueMicrotask(() => {
        proc.stderr.emit("data", Buffer.from("boom"));
        proc.emit("close", 1);
      });
      return proc;
    });

    await expect(
      ensureAacTranscode({ audioId: 77, driveFileId: "drv-77" }),
    ).rejects.toThrow(/ffmpeg exited with code 1/);
    expect(renameMock).not.toHaveBeenCalled();
  });
});
