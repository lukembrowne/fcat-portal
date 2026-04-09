/**
 * Security tests for /api/public/site-images/[token]/[id] route.
 *
 * Verifies:
 * - Token format validation (UUID v4 only)
 * - Image ID validation
 * - Cross-site access rejection: a token for site A cannot fetch an
 *   image whose deployment ID is not in the token's materialized list
 * - Revoked tokens cannot serve images
 *
 * The DB is mocked at the module level with a small state machine that
 * returns prepared rows for the two sequential `db.select(...)...await`
 * calls the route makes (token lookup, then image lookup).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Hand-rolled DB mock. Each test sets `nextResults` to the array of
// values that will be returned in order from sequential awaited query
// chains. The proxy returns the head of the queue when awaited.
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
    biochocoSiteId: "biochoco_site_id",
    deploymentIds: "deployment_ids",
    id: "id",
  },
  images: {
    id: "id",
    deploymentId: "deployment_id",
    path: "path",
    driveFileId: "drive_file_id",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
  sql: Object.assign(
    (() => "sql") as unknown as (...args: unknown[]) => string,
    {
      raw: () => "raw",
    },
  ),
}));

vi.mock("@/lib/drive-client", () => ({
  downloadFileToBuffer: vi.fn(async () => Buffer.from("drive-bytes")),
}));

vi.mock("@/lib/thumbnail", () => ({
  getOrGenerateThumbnail: vi.fn(async () => Buffer.from("thumb-bytes")),
}));

vi.mock("sharp", () => {
  const sharpFactory = vi.fn(() => ({
    rotate: vi.fn().mockReturnThis(),
    resize: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn(async () => Buffer.from("large-bytes")),
  }));
  return { default: sharpFactory };
});

vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(async () => Buffer.from("local-bytes")),
  },
}));

const { GET } = await import("@/app/api/public/site-images/[token]/[id]/route");

const VALID_TOKEN = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";

function makeRequest(token: string, id: string, query: Record<string, string> = {}) {
  const url = new URL(`http://localhost/api/public/site-images/${token}/${id}`);
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url.toString());
}

function call(token: string, id: string, query: Record<string, string> = {}) {
  return GET(makeRequest(token, id, query), {
    params: Promise.resolve({ token, id }),
  });
}

beforeEach(() => {
  nextResults.length = 0;
  vi.clearAllMocks();
});

describe("/api/public/site-images/[token]/[id]", () => {
  describe("validation", () => {
    it("rejects malformed tokens with 400", async () => {
      const res = await call("not-a-uuid", "1");
      expect(res.status).toBe(400);
    });

    it("rejects SQL injection attempts in the token", async () => {
      const res = await call("' OR 1=1 --", "1");
      expect(res.status).toBe(400);
    });

    it("rejects non-numeric image IDs with 400", async () => {
      const res = await call(VALID_TOKEN, "abc");
      expect(res.status).toBe(400);
    });

    it("rejects negative image IDs with 400", async () => {
      const res = await call(VALID_TOKEN, "-5");
      expect(res.status).toBe(400);
    });

    it("rejects unknown size parameter with 400", async () => {
      const res = await call(VALID_TOKEN, "1", { size: "huge" });
      expect(res.status).toBe(400);
    });
  });

  describe("token lookup", () => {
    it("returns 404 when the token does not exist or is revoked", async () => {
      // Token query returns no rows
      nextResults.push([]);
      const res = await call(VALID_TOKEN, "1");
      expect(res.status).toBe(404);
    });

    it("returns 500 when deployment_ids JSON is malformed", async () => {
      nextResults.push([
        {
          id: 1,
          biochocoSiteId: "NAC-005",
          deploymentIds: "not valid json",
        },
      ]);
      const res = await call(VALID_TOKEN, "42");
      expect(res.status).toBe(500);
    });

    it("returns 500 when deployment_ids is not an array of integers", async () => {
      nextResults.push([
        {
          id: 1,
          biochocoSiteId: "NAC-005",
          deploymentIds: '["not-an-int"]',
        },
      ]);
      const res = await call(VALID_TOKEN, "42");
      expect(res.status).toBe(500);
    });

    it("returns 404 when the deployment list is empty", async () => {
      nextResults.push([
        {
          id: 1,
          biochocoSiteId: "NAC-005",
          deploymentIds: "[]",
        },
      ]);
      const res = await call(VALID_TOKEN, "42");
      expect(res.status).toBe(404);
    });
  });

  describe("cross-site access rejection", () => {
    it("returns 404 when the requested image is not in the token's deployment list", async () => {
      // Token resolves OK with deployments [10, 11]
      nextResults.push([
        {
          id: 1,
          biochocoSiteId: "NAC-005",
          deploymentIds: "[10, 11]",
        },
      ]);
      // Image query returns no row because deployment_id 99 ∉ [10, 11]
      // (the route's IN-list filter rejects it at the SQL layer)
      nextResults.push([]);
      const res = await call(VALID_TOKEN, "42");
      expect(res.status).toBe(404);
    });
  });

  describe("happy path — thumb", () => {
    it("serves the thumbnail with caching headers", async () => {
      nextResults.push([
        {
          id: 1,
          biochocoSiteId: "NAC-005",
          deploymentIds: "[10]",
        },
      ]);
      nextResults.push([
        {
          id: 42,
          deploymentId: 10,
          path: "/data/img.jpg",
          driveFileId: "drv-1",
        },
      ]);
      const res = await call(VALID_TOKEN, "42");
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("image/jpeg");
      expect(res.headers.get("Cache-Control")).toContain("immutable");
      expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    });
  });

  describe("happy path — large with download", () => {
    it("serves a large image with Content-Disposition attachment", async () => {
      nextResults.push([
        {
          id: 1,
          biochocoSiteId: "NAC-005",
          deploymentIds: "[10]",
        },
      ]);
      nextResults.push([
        {
          id: 42,
          deploymentId: 10,
          path: "/data/img.jpg",
          driveFileId: "drv-1",
        },
      ]);
      const res = await call(VALID_TOKEN, "42", {
        size: "large",
        download: "1",
      });
      expect(res.status).toBe(200);
      const disposition = res.headers.get("Content-Disposition");
      expect(disposition).toContain("attachment");
      expect(disposition).toContain("FCAT-NAC-005-42.jpg");
    });

    it("serves a large image inline (no Content-Disposition) without download=1", async () => {
      nextResults.push([
        {
          id: 1,
          biochocoSiteId: "NAC-005",
          deploymentIds: "[10]",
        },
      ]);
      nextResults.push([
        {
          id: 42,
          deploymentId: 10,
          path: "/data/img.jpg",
          driveFileId: "drv-1",
        },
      ]);
      const res = await call(VALID_TOKEN, "42", { size: "large" });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Disposition")).toBeNull();
    });
  });
});
