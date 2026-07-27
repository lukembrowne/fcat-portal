/**
 * Tests for /api/public/report-audio/[id] — the mobile-audio fix (FLAC → AAC
 * transcode) plus the unchanged snapshot allowlist gate.
 *
 * Verifies:
 *  - A FLAC clip in the allowlist → transcoded AAC served (`audio/mp4`,
 *    `Accept-Ranges: bytes`, immutable cache, NO noindex — public page), once.
 *  - Range request against the cached m4a → 206 with a valid `Content-Range`.
 *  - WAV source → raw Drive passthrough, no transcode.
 *  - A transcode failure → falls back to the raw Drive stream (still served).
 *  - An id NOT in the allowlist → 404 before any DB/transcode work.
 *
 * `@/db`, the Drive streamer, `ensureAacTranscode`, `fs`, and the snapshot
 * allowlist are mocked; `serveCachedM4a` runs for real against the mocked fs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const nextResults: unknown[][] = [];

function makeChain(): unknown {
  return new Proxy(() => {}, {
    get(_target, prop) {
      if (prop === "then") {
        const result = nextResults.shift() ?? [];
        return (resolve: (v: unknown) => void) => resolve(result);
      }
      return makeChain();
    },
    apply() {
      return makeChain();
    },
  });
}

vi.mock("@/db", () => ({
  db: new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") return undefined;
        return () => makeChain();
      },
    },
  ),
}));

vi.mock("@/db/schema", () => ({
  audioFiles: {
    id: "id",
    driveFileId: "drive_file_id",
    mimeType: "mime_type",
    filename: "filename",
    fileSize: "file_size",
  },
}));

vi.mock("drizzle-orm", () => ({ eq: vi.fn() }));

const downloadFileAsStreamMock = vi.fn(
  async (_fileId: string, _range?: string) => ({
    stream: { fake: "stream" },
    contentType: "audio/wav",
    contentLength: 500,
    contentRange: null as string | null,
  }),
);
vi.mock("@/lib/drive-client", () => ({
  downloadFileAsStream: downloadFileAsStreamMock,
}));

const ensureAacTranscodeMock = vi.fn(
  async (_source: { audioId: number; driveFileId: string }) =>
    "/cache/audio-transcode/42.m4a",
);
vi.mock("@/lib/audio-transcode", () => ({
  ensureAacTranscode: ensureAacTranscodeMock,
}));

const readFileMock = vi.fn(async (_p: string) => Buffer.alloc(1000, 1));
vi.mock("fs", () => ({ promises: { readFile: readFileMock } }));

let allowlist = new Set<number>([42]);
vi.mock("@/lib/public-report-snapshot", () => ({
  getReportAudioAllowlist: vi.fn(async () => allowlist),
}));

vi.mock("@/lib/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { GET } = await import("@/app/api/public/report-audio/[id]/route");

function call(id: string, headers: Record<string, string> = {}) {
  const req = new NextRequest(`http://localhost/api/public/report-audio/${id}`, {
    headers,
  });
  return GET(req, { params: Promise.resolve({ id }) });
}

/** Queue one audio row for the route's single DB select. */
function seedAudio(row: { mimeType: string; filename?: string } | null) {
  nextResults.push(
    row
      ? [
          {
            driveFileId: "drv-1",
            mimeType: row.mimeType,
            filename: row.filename ?? "clip.flac",
            fileSize: 1000,
          },
        ]
      : [],
  );
}

beforeEach(() => {
  nextResults.length = 0;
  allowlist = new Set<number>([42]);
  vi.clearAllMocks();
});

describe("/api/public/report-audio — FLAC → AAC transcode", () => {
  it("FLAC allowlisted clip → transcoded AAC (audio/mp4, immutable, no noindex), once", async () => {
    seedAudio({ mimeType: "audio/flac" });

    const res = await call("42");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/mp4");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    // Public overview page — must NOT be noindexed like the token-gated route.
    expect(res.headers.get("X-Robots-Tag")).toBeNull();
    expect(ensureAacTranscodeMock).toHaveBeenCalledTimes(1);
    expect(downloadFileAsStreamMock).not.toHaveBeenCalled();
  });

  it("Range request against the cached m4a → 206 with valid Content-Range", async () => {
    seedAudio({ mimeType: "audio/flac" });

    const res = await call("42", { range: "bytes=0-99" });

    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Type")).toBe("audio/mp4");
    expect(res.headers.get("Content-Range")).toBe("bytes 0-99/1000");
    expect(res.headers.get("Content-Length")).toBe("100");
  });

  it("WAV source → raw Drive passthrough, no transcode", async () => {
    seedAudio({ mimeType: "audio/wav", filename: "clip.wav" });

    const res = await call("42");

    expect(res.status).toBe(200);
    expect(ensureAacTranscodeMock).not.toHaveBeenCalled();
    expect(downloadFileAsStreamMock).toHaveBeenCalledTimes(1);
  });

  it("transcode failure → falls back to raw Drive stream", async () => {
    seedAudio({ mimeType: "audio/flac" });
    ensureAacTranscodeMock.mockRejectedValueOnce(new Error("ffmpeg boom"));

    const res = await call("42");

    expect(res.status).toBe(200);
    expect(ensureAacTranscodeMock).toHaveBeenCalledTimes(1);
    expect(downloadFileAsStreamMock).toHaveBeenCalledTimes(1);
  });

  it("id not in the allowlist → 404, no DB or transcode", async () => {
    allowlist = new Set<number>([99]);

    const res = await call("42");

    expect(res.status).toBe(404);
    expect(ensureAacTranscodeMock).not.toHaveBeenCalled();
    expect(downloadFileAsStreamMock).not.toHaveBeenCalled();
  });
});
