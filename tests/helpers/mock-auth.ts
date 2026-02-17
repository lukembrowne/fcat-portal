/**
 * Shared mock for @/lib/auth used by permission guard tests.
 *
 * Usage:
 *   import { mockRequirePermission, mockRequireAdmin, setupAuthMocks } from "../helpers/mock-auth";
 *
 *   setupAuthMocks();  // call at module level (registers vi.mock)
 *
 *   // In a test:
 *   mockRequirePermission.mockRejectedValueOnce(new Error("REDIRECT:/"));
 */

import { vi } from "vitest";
import type { AuthUser } from "@/lib/types";

export const mockRequirePermission = vi.fn();
export const mockRequireAdmin = vi.fn();
export const mockGetCurrentUser = vi.fn();

export const testUser: AuthUser = {
  email: "test@fcat-ecuador.org",
  name: "Test User",
  isExternal: false,
  globalRole: null,
  permissions: [{ projectId: "camera-trap", role: "editor" }],
};

export const testAdmin: AuthUser = {
  email: "admin@fcat-ecuador.org",
  name: "Admin",
  isExternal: false,
  globalRole: "super_admin",
  permissions: [],
};

/**
 * Call at module level to register the @/lib/auth mock.
 * Must be called before any dynamic imports of action modules.
 */
export function setupAuthMocks() {
  vi.mock("@/lib/auth", () => ({
    requirePermission: (...args: unknown[]) => mockRequirePermission(...args),
    requireAdmin: (...args: unknown[]) => mockRequireAdmin(...args),
    getCurrentUser: (...args: unknown[]) => mockGetCurrentUser(...args),
    hasProjectAccess: vi.fn(() => true),
  }));
}

// NOTE: setupDbMock() moved to tests/helpers/mock-db.ts to prevent
// vi.mock("@/db") from being hoisted in test files that only need auth helpers.
