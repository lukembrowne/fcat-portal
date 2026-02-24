/**
 * Security tests for /api/odk/photos route.
 *
 * Verifies the 3-layer security model:
 * 1. Auth: unauthenticated requests rejected
 * 2. Allowlists: only known project/form IDs accepted
 * 3. Permissions: project-level access enforced
 *
 * Also tests path traversal protection and parameter validation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import {
  mockGetCurrentUser,
  setupAuthMocks,
  testUser,
} from "../helpers/mock-auth";

setupAuthMocks();

vi.mock("@/lib/odk-client", () => ({
  fetchAttachment: vi.fn(),
}));

vi.mock("@/lib/odk-constants", () => ({
  GIZ_PROJECT_ID: "10",
  GIZ_FORM_TREE_PLANTING: "tree-planting",
  GIZ_FORM_CACAO_MONITORING: "cacao-monitoring",
  BIOCHOCO_PROJECT_ID: "20",
  BIOCHOCO_FORM_DEPLOY: "deploy-form",
  BIOCHOCO_FORM_RETRIEVE: "retrieve-form",
  BIOCHOCO_FORM_HABITAT: "habitat-form",
  MONITOREO_PROJECT_ID: "30",
  MONITOREO_FORM_SOCIAL_ACTIVITIES: "social-activities",
}));

const { GET } = await import("@/app/api/odk/photos/route");
const { fetchAttachment } = await import("@/lib/odk-client");

function makeUrl(params: Record<string, string>) {
  const url = new URL("http://localhost/api/odk/photos");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function makeRequest(params: Record<string, string>) {
  return new NextRequest(makeUrl(params));
}

const validParams = {
  projectId: "20",
  formId: "deploy-form",
  id: "submission-123",
  file: "photo.jpg",
};

describe("/api/odk/photos", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // === Layer 1: Auth ===

  describe("authentication", () => {
    it("returns 401 when no user is authenticated", async () => {
      mockGetCurrentUser.mockResolvedValue(null);
      const res = await GET(makeRequest(validParams));
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("Unauthorized");
    });
  });

  // === Parameter validation ===

  describe("parameter validation", () => {
    beforeEach(() => {
      mockGetCurrentUser.mockResolvedValue({
        ...testUser,
        permissions: [{ projectId: "biochoco", role: "viewer" }],
      });
    });

    it("returns 400 when projectId is missing", async () => {
      const { projectId, ...rest } = validParams;
      const res = await GET(makeRequest(rest));
      expect(res.status).toBe(400);
    });

    it("returns 400 when formId is missing", async () => {
      const { formId, ...rest } = validParams;
      const res = await GET(makeRequest(rest));
      expect(res.status).toBe(400);
    });

    it("returns 400 when id is missing", async () => {
      const { id, ...rest } = validParams;
      const res = await GET(makeRequest(rest));
      expect(res.status).toBe(400);
    });

    it("returns 400 when file is missing", async () => {
      const { file, ...rest } = validParams;
      const res = await GET(makeRequest(rest));
      expect(res.status).toBe(400);
    });
  });

  // === Layer 2: Allowlists ===

  describe("allowlist enforcement", () => {
    beforeEach(() => {
      mockGetCurrentUser.mockResolvedValue({
        ...testUser,
        permissions: [{ projectId: "biochoco", role: "viewer" }],
      });
    });

    it("rejects unknown projectId", async () => {
      const res = await GET(makeRequest({ ...validParams, projectId: "999" }));
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid projectId");
    });

    it("rejects unknown formId", async () => {
      const res = await GET(
        makeRequest({ ...validParams, formId: "unknown-form" })
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid formId");
    });

    it("accepts allowlisted biochoco project + form", async () => {
      const mockBody = new ReadableStream();
      (fetchAttachment as ReturnType<typeof vi.fn>).mockResolvedValue({
        headers: new Headers({ "content-type": "image/jpeg" }),
        body: mockBody,
      });

      const res = await GET(makeRequest(validParams));
      expect(res.status).toBe(200);
    });

    it("accepts allowlisted giz project + form", async () => {
      mockGetCurrentUser.mockResolvedValue({
        ...testUser,
        permissions: [{ projectId: "giz", role: "viewer" }],
      });

      const mockBody = new ReadableStream();
      (fetchAttachment as ReturnType<typeof vi.fn>).mockResolvedValue({
        headers: new Headers({ "content-type": "image/jpeg" }),
        body: mockBody,
      });

      const res = await GET(
        makeRequest({
          projectId: "10",
          formId: "tree-planting",
          id: "sub-1",
          file: "photo.jpg",
        })
      );
      expect(res.status).toBe(200);
    });
  });

  // === Path traversal protection ===

  describe("path traversal protection", () => {
    beforeEach(() => {
      mockGetCurrentUser.mockResolvedValue({
        ...testUser,
        permissions: [{ projectId: "biochoco", role: "viewer" }],
      });
    });

    it("rejects id containing ../", async () => {
      const res = await GET(
        makeRequest({ ...validParams, id: "../../../etc/passwd" })
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBe("Invalid parameter");
    });

    it("rejects id containing forward slash", async () => {
      const res = await GET(
        makeRequest({ ...validParams, id: "foo/bar" })
      );
      expect(res.status).toBe(400);
    });

    it("rejects id containing backslash", async () => {
      const res = await GET(
        makeRequest({ ...validParams, id: "foo\\bar" })
      );
      expect(res.status).toBe(400);
    });

    it("rejects file containing ../", async () => {
      const res = await GET(
        makeRequest({ ...validParams, file: "../../secret.txt" })
      );
      expect(res.status).toBe(400);
    });

    it("rejects file containing backslash", async () => {
      const res = await GET(
        makeRequest({ ...validParams, file: "..\\secret.txt" })
      );
      expect(res.status).toBe(400);
    });
  });

  // === Layer 3: Project-level permissions ===

  describe("project-level permission check", () => {
    it("returns 403 when user has no permissions for the mapped project", async () => {
      mockGetCurrentUser.mockResolvedValue({
        ...testUser,
        globalRole: null,
        permissions: [{ projectId: "camera-trap", role: "editor" }],
      });

      const res = await GET(makeRequest(validParams)); // biochoco project
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

      const mockBody = new ReadableStream();
      (fetchAttachment as ReturnType<typeof vi.fn>).mockResolvedValue({
        headers: new Headers({ "content-type": "image/jpeg" }),
        body: mockBody,
      });

      const res = await GET(makeRequest(validParams));
      expect(res.status).toBe(200);
    });
  });

  // === Response behavior ===

  describe("response", () => {
    beforeEach(() => {
      mockGetCurrentUser.mockResolvedValue({
        ...testUser,
        permissions: [{ projectId: "biochoco", role: "viewer" }],
      });
    });

    it("sets Content-Disposition when download=true", async () => {
      const mockBody = new ReadableStream();
      (fetchAttachment as ReturnType<typeof vi.fn>).mockResolvedValue({
        headers: new Headers({ "content-type": "image/jpeg" }),
        body: mockBody,
      });

      const params = { ...validParams, download: "true" };
      const req = new NextRequest(makeUrl(params));
      const res = await GET(req);

      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Disposition")).toContain("attachment");
      expect(res.headers.get("Content-Disposition")).toContain("photo.jpg");
    });

    it("returns 500 when fetchAttachment throws", async () => {
      (fetchAttachment as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("ODK API down")
      );

      const res = await GET(makeRequest(validParams));
      expect(res.status).toBe(500);
    });

    it("returns 404 when photo has no body", async () => {
      (fetchAttachment as ReturnType<typeof vi.fn>).mockResolvedValue({
        headers: new Headers(),
        body: null,
      });

      const res = await GET(makeRequest(validParams));
      expect(res.status).toBe(404);
    });
  });
});
