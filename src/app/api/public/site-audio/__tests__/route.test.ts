/**
 * Tests for /api/public/site-audio/[token]/[id] — the mobile-audio bug fix
 * (KTD-7) plus the unchanged token/deployment gate.
 *
 * Verifies:
 *  - A FLAC clip that IS the pageConfig featured id → transcoded AAC served
 *    (`Content-Type: audio/mp4`, `Accept-Ranges: bytes`), transcode invoked once.
 *  - Range request against the cached m4a → 206 with a valid `Content-Range`.
 *  - WAV/AAC/MP3 sources → raw passthrough, no transcode.
 *  - A FLAC clip that is NOT the featured id → passthrough, no transcode
 *    (amplification guard).
 *  - The cross-site gate still rejects an out-of-snapshot recording (404) and
 *    runs BEFORE any transcode/cache lookup.
 *
 * The DB is mocked with the same head-of-queue proxy the sibling site-images
 * test uses; `ensureAacTranscode`, the Drive streamer, and `fs` are mocked so no
 * real ffmpeg/Drive/disk is touched. `parsePageConfig` is used for real (pure).
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
  siteShareTokens: {
    token: "token",
    revokedAt: "revoked_at",
    deploymentIds: "deployment_ids",
    pageConfig: "page_config",
  },
  audioFiles: {
    id: "id",
    deploymentId: "deployment_id",
    driveFileId: "drive_file_id",
    mimeType: "mime_type",
    filename: "filename",
    fileSize: "file_size",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
  isNull: vi.fn(),
  inArray: vi.fn(),
}));

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

// serveCachedM4a reads the cached file; return a 1000-byte buffer.
const readFileMock = vi.fn(async (_p: string) => Buffer.alloc(1000, 1));
vi.mock("fs", () => ({
  promises: {
    readFile: readFileMock,
  },
}));

vi.mock("@/lib/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { GET } = await import(
  "@/app/api/public/site-audio/[token]/[id]/route"
);

const VALID_TOKEN = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

function featuredConfig(audioId: number): string {
  return JSON.stringify({
    version: 1,
    blocks: [{ type: "featuredAudio", audioId }],
  });
}

function makeRequest(id: string, headers: Record<string, string> = {}) {
  const url = `http://localhost/api/public/site-audio/${VALID_TOKEN}/${id}`;
  return new NextRequest(url, { headers });
}

function call(id: string, headers: Record<string, string> = {}) {
  return GET(makeRequest(id, headers), {
    params: Promise.resolve({ token: VALID_TOKEN, id }),
  });
}

/** Push a token row (deployments [10], featured audio = `featuredId`) and an
 *  audio row with the given mime. */
function seed(opts: {
  featuredId: number;
  audio: { deploymentId: number; mimeType: string; filename?: string } | null;
}) {
  nextResults.push([
    {
      deploymentIds: "[10]",
      pageConfig: featuredConfig(opts.featuredId),
    },
  ]);
  nextResults.push(
    opts.audio
      ? [
          {
            deploymentId: opts.audio.deploymentId,
            driveFileId: "drv-1",
            mimeType: opts.audio.mimeType,
            filename: opts.audio.filename ?? "clip.flac",
            fileSize: 1000,
          },
        ]
      : [],
  );
}

beforeEach(() => {
  nextResults.length = 0;
  vi.clearAllMocks();
});

describe("/api/public/site-audio — mobile audio transcode (KTD-7)", () => {
  it("FLAC featured clip → transcoded AAC (audio/mp4, Accept-Ranges), transcode once", async () => {
    seed({ featuredId: 42, audio: { deploymentId: 10, mimeType: "audio/flac" } });

    const res = await call("42");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/mp4");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    expect(ensureAacTranscodeMock).toHaveBeenCalledTimes(1);
    expect(downloadFileAsStreamMock).not.toHaveBeenCalled();
  });

  it("Range request against the cached m4a → 206 with valid Content-Range", async () => {
    seed({ featuredId: 42, audio: { deploymentId: 10, mimeType: "audio/flac" } });

    const res = await call("42", { range: "bytes=0-99" });

    expect(res.status).toBe(206);
    expect(res.headers.get("Content-Type")).toBe("audio/mp4");
    expect(res.headers.get("Content-Range")).toBe("bytes 0-99/1000");
    expect(res.headers.get("Content-Length")).toBe("100");
  });

  it("WAV source → raw Drive passthrough, no transcode", async () => {
    seed({ featuredId: 42, audio: { deploymentId: 10, mimeType: "audio/wav" } });

    const res = await call("42");

    expect(res.status).toBe(200);
    expect(ensureAacTranscodeMock).not.toHaveBeenCalled();
    expect(downloadFileAsStreamMock).toHaveBeenCalledTimes(1);
  });

  it("AAC (audio/mp4) source → passthrough, no transcode", async () => {
    seed({ featuredId: 42, audio: { deploymentId: 10, mimeType: "audio/mp4" } });

    const res = await call("42");

    expect(res.status).toBe(200);
    expect(ensureAacTranscodeMock).not.toHaveBeenCalled();
    expect(downloadFileAsStreamMock).toHaveBeenCalledTimes(1);
  });

  it("FLAC that is NOT the featured id → passthrough, no transcode (amplification guard)", async () => {
    // featured id is 42, but the request asks for id 43 (also FLAC, in-snapshot).
    nextResults.push([
      { deploymentIds: "[10]", pageConfig: featuredConfig(42) },
    ]);
    nextResults.push([
      {
        deploymentId: 10,
        driveFileId: "drv-43",
        mimeType: "audio/flac",
        filename: "other.flac",
        fileSize: 1000,
      },
    ]);

    const res = await call("43");

    expect(res.status).toBe(200);
    expect(ensureAacTranscodeMock).not.toHaveBeenCalled();
    expect(downloadFileAsStreamMock).toHaveBeenCalledTimes(1);
  });

  it("out-of-snapshot recording → 404, gate runs before any transcode", async () => {
    // Token resolves with deployments [10]; the audio lookup (IN-list gate)
    // returns no row because the recording's deployment is not in the snapshot.
    seed({ featuredId: 42, audio: null });

    const res = await call("42");

    expect(res.status).toBe(404);
    expect(ensureAacTranscodeMock).not.toHaveBeenCalled();
    expect(downloadFileAsStreamMock).not.toHaveBeenCalled();
  });

  it("rejects malformed tokens with 404 before touching the DB", async () => {
    const res = await GET(
      new NextRequest("http://localhost/api/public/site-audio/not-a-uuid/1"),
      { params: Promise.resolve({ token: "not-a-uuid", id: "1" }) },
    );
    expect(res.status).toBe(404);
    expect(ensureAacTranscodeMock).not.toHaveBeenCalled();
  });
});
