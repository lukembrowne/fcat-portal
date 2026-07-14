/**
 * Security tests for the tokenless public report media route.
 *
 * The allowlist gate is the whole security model: an image is servable only if
 * its id is in the active snapshot's curated set. These tests drive that gate
 * plus the standard id validation and thumb/large/download behaviors.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Controllable allowlist for the snapshot lib mock.
let allowlist = new Set<number>();

// Hand-rolled DB mock: sequential awaited query chains return queued results.
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
  images: { id: "id", deploymentId: "deployment_id", path: "path", driveFileId: "drive_file_id" },
}));

vi.mock("drizzle-orm", () => ({ eq: vi.fn() }));

vi.mock("@/lib/public-report-snapshot", () => ({
  getReportImageAllowlist: vi.fn(async () => allowlist),
}));

vi.mock("@/lib/drive-client", () => ({
  downloadFileToBuffer: vi.fn(async () => Buffer.from("drive-bytes")),
}));
vi.mock("@/lib/thumbnail", () => ({
  getOrGenerateThumbnail: vi.fn(async () => Buffer.from("thumb-bytes")),
}));
vi.mock("sharp", () => {
  const factory = vi.fn(() => ({
    rotate: vi.fn().mockReturnThis(),
    resize: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn(async () => Buffer.from("large-bytes")),
  }));
  return { default: factory };
});
vi.mock("fs", () => ({ promises: { readFile: vi.fn(async () => Buffer.from("local-bytes")) } }));

const { GET } = await import("@/app/api/public/report-images/[id]/route");

function call(id: string, query: Record<string, string> = {}) {
  const url = new URL(`http://localhost/api/public/report-images/${id}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return GET(new NextRequest(url.toString()), { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  nextResults.length = 0;
  allowlist = new Set();
  vi.clearAllMocks();
});

describe("/api/public/report-images/[id]", () => {
  it("rejects non-numeric ids with 400", async () => {
    const res = await call("abc");
    expect(res.status).toBe(400);
  });

  it("returns 404 when the id is not in the allowlist (the security gate)", async () => {
    allowlist = new Set([10]);
    const res = await call("42");
    expect(res.status).toBe(404);
  });

  it("returns 404 when allowlisted but the image row is missing", async () => {
    allowlist = new Set([42]);
    nextResults.push([]); // image lookup → none
    const res = await call("42");
    expect(res.status).toBe(404);
  });

  it("serves a thumbnail for an allowlisted id", async () => {
    allowlist = new Set([42]);
    nextResults.push([{ id: 42, deploymentId: 5, path: "/data/i.jpg", driveFileId: "d1" }]);
    const res = await call("42", { size: "thumb" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/jpeg");
    expect(res.headers.get("Cache-Control")).toContain("immutable");
  });

  it("sets Content-Disposition on large download=1", async () => {
    allowlist = new Set([42]);
    nextResults.push([{ id: 42, deploymentId: 5, path: "/data/i.jpg", driveFileId: "d1" }]);
    const res = await call("42", { size: "large", download: "1" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain("attachment");
    expect(res.headers.get("Content-Disposition")).toContain("FCAT-biochoco-42.jpg");
  });

  it("serves large inline (no disposition) without download", async () => {
    allowlist = new Set([42]);
    nextResults.push([{ id: 42, deploymentId: 5, path: "/data/i.jpg", driveFileId: "d1" }]);
    const res = await call("42", { size: "large" });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBeNull();
  });
});
