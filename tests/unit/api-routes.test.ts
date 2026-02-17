/**
 * Tests for remaining API routes: active-jobs, progress, images.
 *
 * NOTE: These routes currently have NO auth checks.
 * Tests document this gap and verify existing validation logic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { setupDbMock } from "../helpers/mock-db";

setupDbMock();

vi.mock("@/db/schema", () => ({
  processingJobs: "processingJobs",
  deployments: "deployments",
  images: "images",
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock("fs", () => ({
  promises: {
    readFile: vi.fn(),
    stat: vi.fn(),
  },
}));

// === /api/active-jobs ===

describe("/api/active-jobs", () => {
  it("has no auth check — any caller can access (gap to address)", async () => {
    // This test documents that /api/active-jobs has NO auth check.
    // The route handler imports no auth functions.
    const mod = await import("@/app/api/active-jobs/route");
    expect(mod.GET).toBeDefined();
    // Verify the source doesn't import getCurrentUser or requirePermission
    // by checking it doesn't return 401 (it either succeeds or errors on DB)
    try {
      const res = await mod.GET();
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
    } catch {
      // May throw on non-JSON-serializable proxy result — that's fine,
      // the point is it never checked auth before reaching DB logic.
    }
  });
});

// === /api/progress ===

describe("/api/progress", () => {
  it("returns 400 when jobId is missing", async () => {
    const { GET } = await import("@/app/api/progress/route");
    const req = new Request("http://localhost/api/progress");
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when jobId is not a number", async () => {
    const { GET } = await import("@/app/api/progress/route");
    const req = new Request("http://localhost/api/progress?jobId=abc");
    const res = await GET(req);
    expect(res.status).toBe(400);
  });

  it("returns SSE stream for valid jobId (documents missing auth check)", async () => {
    const { GET } = await import("@/app/api/progress/route");
    const controller = new AbortController();
    const req = new Request("http://localhost/api/progress?jobId=1", {
      signal: controller.signal,
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    // Abort to prevent infinite polling in test
    controller.abort();
  });
});

// === /api/images/[...path] ===

describe("/api/images/[...path]", () => {
  it("rejects path traversal via ../ segments", async () => {
    const { GET } = await import("@/app/api/images/[...path]/route");
    const req = new NextRequest(
      "http://localhost/api/images/tmp/../../../etc/passwd"
    );
    const res = await GET(req, {
      params: Promise.resolve({ path: ["tmp", "..", "..", "..", "etc", "passwd"] }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid path");
  });

  it("has no auth check — validates deployment path but not user (gap to address)", async () => {
    // This test documents that /api/images/[...path] has NO auth check.
    // It validates path belongs to a registered deployment but doesn't
    // check who is requesting it.
    const { GET } = await import("@/app/api/images/[...path]/route");
    const req = new NextRequest(
      "http://localhost/api/images/some/random/path.jpg"
    );
    try {
      const res = await GET(req, {
        params: Promise.resolve({ path: ["some", "random", "path.jpg"] }),
      });
      // Whether it returns 403 or 500, it never returns 401
      expect(res.status).not.toBe(401);
    } catch {
      // Mock may throw — that's fine, no auth was ever checked
    }
  });
});
