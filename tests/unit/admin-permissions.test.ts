/**
 * Permission guard tests for admin server actions.
 *
 * Verifies every exported function calls requireAdmin() before doing any work.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  mockRequireAdmin,
  setupAuthMocks,
  testAdmin,
} from "../helpers/mock-auth";
import { setupDbMock } from "../helpers/mock-db";

setupAuthMocks();
setupDbMock();

vi.mock("@/db/schema", () => ({
  users: "users",
  userPermissions: "userPermissions",
  projects: "projects",
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  default: {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
  },
}));

const actions = await import("@/app/admin/actions");

describe("admin action permission guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireAdmin.mockResolvedValue(testAdmin);
  });

  const adminActions: [string, Function, unknown[]][] = [
    ["getUsers", actions.getUsers, []],
    ["getProjects", actions.getProjects, []],
    ["addUser", actions.addUser, ["user@test.org", "User", false]],
    ["removeUser", actions.removeUser, ["user@test.org"]],
    ["setPermission", actions.setPermission, ["user@test.org", "camera-trap", "editor"]],
    ["removePermission", actions.removePermission, ["user@test.org", "camera-trap"]],
    ["syncAllowedEmails", actions.syncAllowedEmails, []],
  ];

  for (const [name, fn, args] of adminActions) {
    it(`${name} requires admin permission`, async () => {
      try {
        await fn(...args);
      } catch {
        // May throw after auth check due to mocked DB
      }
      expect(mockRequireAdmin).toHaveBeenCalled();
    });
  }
});
