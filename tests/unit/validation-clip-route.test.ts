/**
 * /api/audio/validation-clip — the clip, the clip as a download, and the full
 * source recording as a download (U6 of the reviewer-feedback plan).
 *
 * Everything below the route is mocked: auth, the sample lookup, the clip cache
 * (which returns a real temp file so `serveCachedM4a` runs unmocked) and Drive.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { Readable } from "stream";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";

const tmp = mkdtempSync(path.join(tmpdir(), "validation-clip-route-"));
const clipPath = path.join(tmp, "7.m4a");
writeFileSync(clipPath, Buffer.from("fake-aac-bytes"));

const requirePermission = vi.fn();
const requireDeploymentAccess = vi.fn();
const loadClipSource = vi.fn();
const downloadFileAsStream = vi.fn();

vi.mock("@/lib/auth", () => ({ requirePermission }));
vi.mock("@/lib/camera-trap-auth", () => ({ requireDeploymentAccess }));
vi.mock("@/app/api/audio/validation-clip-shared", () => ({ loadClipSource }));
const specPath = path.join(tmp, "7.webp");
writeFileSync(specPath, Buffer.from("fake-webp-bytes"));
vi.mock("@/lib/birdnet-validation/clip-cache", () => ({
  ensureClipAudio: vi.fn(async () => clipPath),
  ensureClipSpectrogram: vi.fn(async () => specPath),
}));
vi.mock("@/lib/drive-client", () => ({ downloadFileAsStream }));
const logError = vi.fn();
vi.mock("@/lib/log", () => ({ log: { error: logError, info: vi.fn(), warn: vi.fn() } }));

const SOURCE = {
  sampleId: 7,
  driveFileId: "drive-abc",
  startTime: 57,
  endTime: 60,
  duration: 60,
  deploymentId: 12,
  filename: "2MM20630_20251123_090000.flac",
  mimeType: "audio/flac",
  fileSize: 1234,
};

function get(query: string) {
  return new NextRequest(`http://localhost/api/audio/validation-clip?${query}`);
}

async function route() {
  return (await import("@/app/api/audio/validation-clip/route")).GET;
}

async function spectrogramRoute() {
  return (await import("@/app/api/audio/validation-spectrogram/route")).GET;
}

function getSpectrogram(query: string) {
  return new NextRequest(`http://localhost/api/audio/validation-spectrogram?${query}`);
}

async function errors() {
  return import("@/lib/deployment-access-errors");
}

beforeEach(() => {
  vi.clearAllMocks();
  requirePermission.mockResolvedValue({ email: "r@example.org", globalRole: "user" });
  requireDeploymentAccess.mockResolvedValue(undefined);
  loadClipSource.mockResolvedValue(SOURCE);
  downloadFileAsStream.mockResolvedValue({
    stream: Readable.from([Buffer.from("flac-bytes")]),
    contentType: "application/octet-stream",
    contentLength: 10,
    contentRange: undefined,
    status: 200,
  });
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("/api/audio/validation-clip", () => {
  it("serves the clip inline by default", async () => {
    const res = await (await route())(get("sample=7"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/mp4");
    expect(res.headers.get("Content-Disposition")).toBeNull();
  });

  it("download=1 returns the clip as an attachment named validacion-N.m4a", async () => {
    const res = await (await route())(get("sample=7&download=1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="validacion-7.m4a"'
    );
  });

  it("source=1 streams the original recording under its own filename", async () => {
    const res = await (await route())(get("sample=7&source=1"));
    expect(res.status).toBe(200);
    expect(downloadFileAsStream).toHaveBeenCalledWith("drive-abc", undefined);
    expect(res.headers.get("Content-Type")).toBe("audio/flac");
    const disposition = res.headers.get("Content-Disposition") ?? "";
    expect(disposition).toContain("attachment;");
    expect(disposition).toContain('filename="2MM20630_20251123_090000.flac"');
    expect(await res.text()).toBe("flac-bytes");
  });

  it("source=1 keeps a .wav source's extension", async () => {
    loadClipSource.mockResolvedValue({
      ...SOURCE,
      filename: "S4A_20250101_060000.wav",
      mimeType: "audio/wav",
    });
    const res = await (await route())(get("sample=7&source=1"));
    expect(res.headers.get("Content-Disposition")).toContain(
      'filename="S4A_20250101_060000.wav"'
    );
  });

  it("returns 403 for both downloads without access to the deployment", async () => {
    const { DeploymentAccessDeniedError } = await errors();
    requireDeploymentAccess.mockRejectedValue(new DeploymentAccessDeniedError());
    const GET = await route();
    for (const q of ["sample=7&download=1", "sample=7&source=1"]) {
      const res = await GET(get(q));
      expect(res.status).toBe(403);
    }
    expect(downloadFileAsStream).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-integer sample", async () => {
    const GET = await route();
    for (const q of ["sample=abc&source=1", "sample=1.5&download=1", "source=1", "sample=0"]) {
      const res = await GET(get(q));
      expect(res.status).toBe(400);
    }
    expect(loadClipSource).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown sample", async () => {
    loadClipSource.mockResolvedValue(null);
    const res = await (await route())(get("sample=999&source=1"));
    expect(res.status).toBe(404);
  });

  it("maps a Drive 404 on the source to a Spanish 404", async () => {
    downloadFileAsStream.mockRejectedValue(Object.assign(new Error("nf"), { code: 404 }));
    const res = await (await route())(get("sample=7&source=1"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Archivo no encontrado en Drive" });
  });

  it("returns 404 when the sample's deployment no longer exists", async () => {
    const { DeploymentNotFoundError } = await errors();
    requireDeploymentAccess.mockRejectedValue(new DeploymentNotFoundError());
    const res = await (await route())(get("sample=7&source=1"));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Instalación no encontrada" });
    expect(downloadFileAsStream).not.toHaveBeenCalled();
  });

  it("does not report an unexpected failure of the access check as 403", async () => {
    requireDeploymentAccess.mockRejectedValue(new Error("SQLITE_BUSY: database is locked"));
    const res = await (await route())(get("sample=7"));
    expect(res.status).toBe(500);
    expect(logError).toHaveBeenCalled();
    expect(downloadFileAsStream).not.toHaveBeenCalled();
  });
});

describe("/api/audio/validation-spectrogram access mapping", () => {
  it("serves the image with access", async () => {
    const res = await (await spectrogramRoute())(getSpectrogram("sample=7"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/webp");
  });

  it("maps denial to 403, a missing deployment to 404, anything else to 500", async () => {
    const { DeploymentAccessDeniedError, DeploymentNotFoundError } = await errors();
    const GET = await spectrogramRoute();

    requireDeploymentAccess.mockRejectedValueOnce(new DeploymentAccessDeniedError());
    expect((await GET(getSpectrogram("sample=7"))).status).toBe(403);

    requireDeploymentAccess.mockRejectedValueOnce(new DeploymentNotFoundError());
    expect((await GET(getSpectrogram("sample=7"))).status).toBe(404);

    requireDeploymentAccess.mockRejectedValueOnce(new Error("boom"));
    expect((await GET(getSpectrogram("sample=7"))).status).toBe(500);
    expect(logError).toHaveBeenCalled();
  });

  it("skips the check for a sample with no deployment", async () => {
    loadClipSource.mockResolvedValue({ ...SOURCE, deploymentId: null });
    const res = await (await spectrogramRoute())(getSpectrogram("sample=7"));
    expect(res.status).toBe(200);
    expect(requireDeploymentAccess).not.toHaveBeenCalled();
  });
});
