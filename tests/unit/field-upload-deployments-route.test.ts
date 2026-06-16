/**
 * Tests for GET /api/field-upload/v1/deployments.
 *
 * Auth (token), project allow-listing, rate limiting, and the response shape
 * (routing config + mapped deployments incl. null driveId for legacy rows).
 *
 * The DB is mocked at the module level with the same small proxy used by the
 * site-images route test: each awaited query chain resolves to the head of
 * `nextResults`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const nextResults: unknown[][] = [];

function makeChain(): unknown {
  return new Proxy(() => {}, {
    get(_t, prop) {
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
      get(_t, prop) {
        if (prop === "then") return undefined;
        return () => makeChain();
      },
    },
  ),
}));

vi.mock("@/db/schema", () => ({
  deployments: {
    name: "name",
    siteName: "site_name",
    uploadCameraFolderId: "upload_camera_folder_id",
    uploadAudioFolderId: "upload_audio_folder_id",
    uploadIbuttonFolderId: "upload_ibutton_folder_id",
    uploadCountsCheckedAt: "upload_counts_checked_at",
    cameraTrapProjectId: "ct_project_id",
    sharedDriveId: "shared_drive_id",
  },
  sharedDrives: { id: "id", driveId: "drive_id" },
  cameraTrapProjects: { id: "id", name: "name" },
}));

vi.mock("drizzle-orm", () => ({ eq: vi.fn() }));

vi.mock("@/lib/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { GET } = await import("@/app/api/field-upload/v1/deployments/route");
const { __resetRateLimitForTests } = await import("@/lib/simple-rate-limit");

const TOKEN = "test-token";

function call(opts: { token?: string; project?: string; ip?: string } = {}) {
  const url = new URL("http://localhost/api/field-upload/v1/deployments");
  if (opts.project !== undefined) url.searchParams.set("projectId", opts.project);
  const headers: Record<string, string> = {};
  if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
  if (opts.ip) headers["x-forwarded-for"] = opts.ip;
  return GET(new Request(url.toString(), { headers }));
}

const ORIGINAL = { ...process.env };

beforeEach(() => {
  nextResults.length = 0;
  __resetRateLimitForTests();
  vi.clearAllMocks();
  process.env.FIELD_UPLOAD_TOKEN = TOKEN;
  process.env.FIELD_UPLOAD_ALLOWED_PROJECTS = "BioChoco";
});

afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe("GET /api/field-upload/v1/deployments", () => {
  it("401 without a token", async () => {
    const res = await call({ project: "BioChoco" });
    expect(res.status).toBe(401);
  });

  it("401 with a wrong token", async () => {
    const res = await call({ token: "wrong", project: "BioChoco" });
    expect(res.status).toBe(401);
  });

  it("400 when projectId is missing", async () => {
    const res = await call({ token: TOKEN });
    expect(res.status).toBe(400);
  });

  it("400 for a non-allow-listed project (no enumeration)", async () => {
    const res = await call({ token: TOKEN, project: "Finance" });
    expect(res.status).toBe(400);
  });

  it("200 returns routing config + mapped deployments", async () => {
    nextResults.push([
      {
        name: "NAC-005-A",
        siteName: "Nangaritza",
        uploadCameraFolderId: "1aB",
        uploadAudioFolderId: "1cD",
        uploadIbuttonFolderId: "1eF",
        uploadCountsCheckedAt: new Date(1_700_000_000_000),
        driveId: "0ABCDEF",
      },
    ]);
    const res = await call({ token: TOKEN, project: "BioChoco" });
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.minSupportedVersion).toBe("1.0.0");
    expect(body.routing.subfolders.camera).toBe("camaras_trampas");
    expect(body.routing.extensions.audio).toContain(".flac");

    expect(body.deployments).toHaveLength(1);
    const d = body.deployments[0];
    expect(d.deploymentId).toBe("NAC-005-A");
    expect(d.displayName).toBe("NAC-005-A — Nangaritza");
    expect(d.driveId).toBe("0ABCDEF");
    expect(d.uploadCameraFolderId).toBe("1aB");
    expect(d.uploadCountsCheckedAt).toBe(1_700_000_000); // seconds, not ms
  });

  it("maps a legacy row with no shared drive / folders to nulls", async () => {
    nextResults.push([
      {
        name: "OLD-001",
        siteName: null,
        uploadCameraFolderId: null,
        uploadAudioFolderId: null,
        uploadIbuttonFolderId: null,
        uploadCountsCheckedAt: null,
        driveId: null,
      },
    ]);
    const res = await call({ token: TOKEN, project: "BioChoco" });
    const body = await res.json();
    const d = body.deployments[0];
    expect(d.displayName).toBe("OLD-001"); // no site suffix
    expect(d.driveId).toBeNull();
    expect(d.uploadCameraFolderId).toBeNull();
    expect(d.uploadCountsCheckedAt).toBeNull();
  });

  it("429 once the per-IP window is exhausted", async () => {
    // limiter default is 30/min; the 31st call from the same IP is blocked
    for (let i = 0; i < 30; i++) {
      nextResults.push([]);
      const ok = await call({ token: TOKEN, project: "BioChoco", ip: "1.2.3.4" });
      expect(ok.status).toBe(200);
    }
    const blocked = await call({ token: TOKEN, project: "BioChoco", ip: "1.2.3.4" });
    expect(blocked.status).toBe(429);
  });
});
