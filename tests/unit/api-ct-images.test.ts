/**
 * Security tests for /api/ct-images/[id] route.
 *
 * Verifies:
 * - Auth: unauthenticated requests rejected
 * - Permissions: camera-trap project access required
 * - Validation: image ID must be numeric
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  mockGetCurrentUser,
  setupAuthMocks,
  testUser,
} from "../helpers/mock-auth";
import { setupDbMock } from "../helpers/mock-db";

setupAuthMocks();
setupDbMock();

vi.mock("@/db/schema", () => ({
  images: "images",
  deployments: "deployments",
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
}));

vi.mock("@/lib/drive-client", () => ({
  downloadFileToBuffer: vi.fn(),
}));

vi.mock("sharp", () => ({
  default: vi.fn(() => ({
    resize: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn(async () => Buffer.from("thumb")),
  })),
}));

vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    mkdir: vi.fn(),
    stat: vi.fn(),
  },
}));

const { GET } = await import("@/app/api/ct-images/[id]/route");

function makeRequest(id: string, params: Record<string, string> = {}) {
  const url = new URL(`http://localhost/api/ct-images/${id}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url.toString());
}

describe("/api/ct-images/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("authentication", () => {
    it("returns 401 when no user is authenticated", async () => {
      mockGetCurrentUser.mockResolvedValue(null);
      const res = await GET(makeRequest("123"), {
        params: Promise.resolve({ id: "123" }),
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("Unauthorized");
    });
  });

  describe("permission check", () => {
    it("returns 403 when user has no camera-trap permission", async () => {
      mockGetCurrentUser.mockResolvedValue({
        ...testUser,
        globalRole: null,
        permissions: [{ projectId: "biochoco", role: "viewer" }],
      });

      const res = await GET(makeRequest("123"), {
        params: Promise.resolve({ id: "123" }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toBe("Forbidden");
    });

    it("allows super admin regardless of project permissions", async () => {
      mockGetCurrentUser.mockResolvedValue({
        ...testUser,
        globalRole: "super_admin",
        permissions: [],
      });

      // Will proceed to DB lookup (which returns undefined from mock) → 404
      const res = await GET(makeRequest("123"), {
        params: Promise.resolve({ id: "123" }),
      });
      // Should not be 401 or 403
      expect([401, 403]).not.toContain(res.status);
    });
  });

  describe("validation", () => {
    beforeEach(() => {
      mockGetCurrentUser.mockResolvedValue({
        ...testUser,
        permissions: [{ projectId: "camera-trap", role: "viewer" }],
      });
    });

    it("returns 400 for non-numeric image ID", async () => {
      const res = await GET(makeRequest("abc"), {
        params: Promise.resolve({ id: "abc" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid image ID");
    });

    it("returns 400 for empty image ID", async () => {
      const res = await GET(makeRequest(""), {
        params: Promise.resolve({ id: "" }),
      });
      expect(res.status).toBe(400);
    });
  });
});
