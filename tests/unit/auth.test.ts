import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock next/headers
const mockHeaders = new Map<string, string>();
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => ({
    get: (key: string) => mockHeaders.get(key) || null,
  })),
}));

// Mock next/navigation
const mockRedirect = vi.fn();
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    mockRedirect(url);
    throw new Error(`REDIRECT:${url}`);
  },
}));

// Mock server-only (no-op in tests)
vi.mock("server-only", () => ({}));

// Mock DB
const mockDbInsert = vi.fn();
const mockDbSelect = vi.fn();
const mockDbSelectFrom = vi.fn();

const mockDbUpdate = vi.fn();

vi.mock("@/db", () => ({
  db: {
    insert: () => ({
      values: () => ({
        onConflictDoNothing: mockDbInsert,
      }),
    }),
    select: () => ({
      from: mockDbSelectFrom,
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          then: (cb: () => void) => cb?.(),
        }),
      }),
    }),
  },
}));

vi.mock("@/db/schema", () => ({
  users: { email: "email" },
  userPermissions: { userEmail: "user_email" },
}));

vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => ({ field: a, value: b }),
}));

describe("auth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHeaders.clear();
    mockRedirect.mockClear();
    mockDbInsert.mockResolvedValue(undefined);
  });

  describe("getCurrentUser", () => {
    it("returns null when no email header", async () => {
      const { getCurrentUser } = await import("@/lib/auth");
      const user = await getCurrentUser();
      expect(user).toBeNull();
    });

    it("returns AuthUser with permissions for known user", async () => {
      mockHeaders.set("x-user-email", "test@fcat-ecuador.org");

      // Mock user lookup
      mockDbSelectFrom
        .mockReturnValueOnce({
          where: vi.fn().mockReturnValue([
            {
              email: "test@fcat-ecuador.org",
              name: "Test User",
              isExternal: false,
              globalRole: null,
            },
          ]),
        })
        // Mock permissions lookup
        .mockReturnValueOnce({
          where: vi.fn().mockReturnValue([
            {
              userEmail: "test@fcat-ecuador.org",
              projectId: "camera-trap",
              role: "editor",
            },
          ]),
        });

      const { getCurrentUser } = await import("@/lib/auth");
      const user = await getCurrentUser();

      expect(user).not.toBeNull();
      expect(user!.email).toBe("test@fcat-ecuador.org");
      expect(user!.name).toBe("Test User");
      expect(user!.permissions).toHaveLength(1);
      expect(user!.permissions[0]).toEqual({
        projectId: "camera-trap",
        role: "editor",
      });
    });

    it("normalizes email to lowercase", async () => {
      mockHeaders.set("x-user-email", "TEST@FCAT-ECUADOR.ORG");

      mockDbSelectFrom
        .mockReturnValueOnce({
          where: vi.fn().mockReturnValue([
            {
              email: "test@fcat-ecuador.org",
              name: null,
              isExternal: false,
              globalRole: null,
            },
          ]),
        })
        .mockReturnValueOnce({
          where: vi.fn().mockReturnValue([]),
        });

      const { getCurrentUser } = await import("@/lib/auth");
      const user = await getCurrentUser();

      expect(user).not.toBeNull();
      expect(user!.email).toBe("test@fcat-ecuador.org");
    });

    it("detects super admin from SUPER_ADMIN_EMAILS env var", async () => {
      process.env.SUPER_ADMIN_EMAILS = "admin@fcat-ecuador.org";
      mockHeaders.set("x-user-email", "admin@fcat-ecuador.org");

      mockDbSelectFrom
        .mockReturnValueOnce({
          where: vi.fn().mockReturnValue([
            {
              email: "admin@fcat-ecuador.org",
              name: "Admin",
              isExternal: false,
              globalRole: null,
            },
          ]),
        })
        .mockReturnValueOnce({
          where: vi.fn().mockReturnValue([]),
        });

      const { getCurrentUser } = await import("@/lib/auth");
      const user = await getCurrentUser();

      expect(user).not.toBeNull();
      expect(user!.globalRole).toBe("super_admin");

      delete process.env.SUPER_ADMIN_EMAILS;
    });

    it("detects super admin from DB global_role", async () => {
      mockHeaders.set("x-user-email", "dbadmin@fcat-ecuador.org");

      mockDbSelectFrom
        .mockReturnValueOnce({
          where: vi.fn().mockReturnValue([
            {
              email: "dbadmin@fcat-ecuador.org",
              name: "DB Admin",
              isExternal: false,
              globalRole: "super_admin",
            },
          ]),
        })
        .mockReturnValueOnce({
          where: vi.fn().mockReturnValue([]),
        });

      const { getCurrentUser } = await import("@/lib/auth");
      const user = await getCurrentUser();

      expect(user).not.toBeNull();
      expect(user!.globalRole).toBe("super_admin");
    });

    it("auto-provisions new users via UPSERT", async () => {
      mockHeaders.set("x-user-email", "newuser@fcat-ecuador.org");

      mockDbSelectFrom
        .mockReturnValueOnce({
          where: vi.fn().mockReturnValue([
            {
              email: "newuser@fcat-ecuador.org",
              name: null,
              isExternal: false,
              globalRole: null,
            },
          ]),
        })
        .mockReturnValueOnce({
          where: vi.fn().mockReturnValue([]),
        });

      const { getCurrentUser } = await import("@/lib/auth");
      const user = await getCurrentUser();

      expect(mockDbInsert).toHaveBeenCalled();
      expect(user).not.toBeNull();
      expect(user!.permissions).toHaveLength(0);
    });
  });

  describe("requirePermission", () => {
    it("redirects when no user", async () => {
      // No email header set
      const { requirePermission } = await import("@/lib/auth");

      await expect(
        requirePermission("camera-trap", "viewer")
      ).rejects.toThrow("REDIRECT:/");
    });

    it("allows super admin regardless of permissions", async () => {
      process.env.SUPER_ADMIN_EMAILS = "admin@fcat-ecuador.org";
      mockHeaders.set("x-user-email", "admin@fcat-ecuador.org");

      mockDbSelectFrom
        .mockReturnValueOnce({
          where: vi.fn().mockReturnValue([
            {
              email: "admin@fcat-ecuador.org",
              name: "Admin",
              isExternal: false,
              globalRole: null,
            },
          ]),
        })
        .mockReturnValueOnce({
          where: vi.fn().mockReturnValue([]),
        });

      const { requirePermission } = await import("@/lib/auth");
      const user = await requirePermission("camera-trap", "admin");

      expect(user.globalRole).toBe("super_admin");

      delete process.env.SUPER_ADMIN_EMAILS;
    });

    it("redirects when user has no permission for project", async () => {
      mockHeaders.set("x-user-email", "viewer@fcat-ecuador.org");

      mockDbSelectFrom
        .mockReturnValueOnce({
          where: vi.fn().mockReturnValue([
            {
              email: "viewer@fcat-ecuador.org",
              name: "Viewer",
              isExternal: false,
              globalRole: null,
            },
          ]),
        })
        .mockReturnValueOnce({
          where: vi.fn().mockReturnValue([]),
        });

      const { requirePermission } = await import("@/lib/auth");

      await expect(
        requirePermission("camera-trap", "viewer")
      ).rejects.toThrow("REDIRECT:/");
    });

    it("redirects when user role is below minimum", async () => {
      mockHeaders.set("x-user-email", "viewer@fcat-ecuador.org");

      mockDbSelectFrom
        .mockReturnValueOnce({
          where: vi.fn().mockReturnValue([
            {
              email: "viewer@fcat-ecuador.org",
              name: "Viewer",
              isExternal: false,
              globalRole: null,
            },
          ]),
        })
        .mockReturnValueOnce({
          where: vi.fn().mockReturnValue([
            {
              userEmail: "viewer@fcat-ecuador.org",
              projectId: "camera-trap",
              role: "viewer",
            },
          ]),
        });

      const { requirePermission } = await import("@/lib/auth");

      await expect(
        requirePermission("camera-trap", "editor")
      ).rejects.toThrow("REDIRECT:/");
    });

    it("allows when user role meets minimum", async () => {
      mockHeaders.set("x-user-email", "editor@fcat-ecuador.org");

      mockDbSelectFrom
        .mockReturnValueOnce({
          where: vi.fn().mockReturnValue([
            {
              email: "editor@fcat-ecuador.org",
              name: "Editor",
              isExternal: false,
              globalRole: null,
            },
          ]),
        })
        .mockReturnValueOnce({
          where: vi.fn().mockReturnValue([
            {
              userEmail: "editor@fcat-ecuador.org",
              projectId: "camera-trap",
              role: "editor",
            },
          ]),
        });

      const { requirePermission } = await import("@/lib/auth");
      const user = await requirePermission("camera-trap", "viewer");

      expect(user.email).toBe("editor@fcat-ecuador.org");
    });
  });

  describe("requireAdmin", () => {
    it("redirects non-admin users", async () => {
      mockHeaders.set("x-user-email", "regular@fcat-ecuador.org");

      mockDbSelectFrom
        .mockReturnValueOnce({
          where: vi.fn().mockReturnValue([
            {
              email: "regular@fcat-ecuador.org",
              name: "Regular",
              isExternal: false,
              globalRole: null,
            },
          ]),
        })
        .mockReturnValueOnce({
          where: vi.fn().mockReturnValue([]),
        });

      const { requireAdmin } = await import("@/lib/auth");

      await expect(requireAdmin()).rejects.toThrow("REDIRECT:/");
    });

    it("allows super admin users", async () => {
      process.env.SUPER_ADMIN_EMAILS = "admin@fcat-ecuador.org";
      mockHeaders.set("x-user-email", "admin@fcat-ecuador.org");

      mockDbSelectFrom
        .mockReturnValueOnce({
          where: vi.fn().mockReturnValue([
            {
              email: "admin@fcat-ecuador.org",
              name: "Admin",
              isExternal: false,
              globalRole: null,
            },
          ]),
        })
        .mockReturnValueOnce({
          where: vi.fn().mockReturnValue([]),
        });

      const { requireAdmin } = await import("@/lib/auth");
      const user = await requireAdmin();

      expect(user.globalRole).toBe("super_admin");

      delete process.env.SUPER_ADMIN_EMAILS;
    });
  });

  // --- Edge Cases ---

  describe("edge cases", () => {
    it("handles email with leading/trailing spaces", async () => {
      mockHeaders.set("x-user-email", "  test@fcat-ecuador.org  ");

      mockDbSelectFrom
        .mockReturnValueOnce({
          where: vi.fn().mockReturnValue([
            {
              email: "test@fcat-ecuador.org",
              name: "Test",
              isExternal: false,
              globalRole: null,
            },
          ]),
        })
        .mockReturnValueOnce({
          where: vi.fn().mockReturnValue([]),
        });

      const { getCurrentUser } = await import("@/lib/auth");
      const user = await getCurrentUser();

      expect(user).not.toBeNull();
      expect(user!.email).toBe("test@fcat-ecuador.org");
    });

    it("returns null for empty string email header", async () => {
      mockHeaders.set("x-user-email", "");

      const { getCurrentUser } = await import("@/lib/auth");
      const user = await getCurrentUser();

      expect(user).toBeNull();
    });

    it("returns null when user not found in DB", async () => {
      mockHeaders.set("x-user-email", "unknown@fcat-ecuador.org");

      // User lookup returns empty
      mockDbSelectFrom.mockReturnValueOnce({
        where: vi.fn().mockReturnValue([]),
      });

      const { getCurrentUser } = await import("@/lib/auth");
      const user = await getCurrentUser();

      expect(user).toBeNull();
    });
  });
});
