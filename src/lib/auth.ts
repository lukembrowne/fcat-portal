/**
 * Auth Library — Server-side only
 *
 * getCurrentUser(): reads x-user-email header, JOINs users + user_permissions
 * requirePermission(): checks project-level access, redirects if unauthorized
 * requireAdmin(): checks super admin status
 */

import "server-only";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { users, userPermissions } from "@/db/schema";
import { eq } from "drizzle-orm";
import type { AuthUser, ProjectRole, GlobalRole } from "@/lib/types";

/**
 * Check if user has access to a given project.
 * Super admins have access to all projects.
 */
export function hasProjectAccess(user: AuthUser, projectId: string): boolean {
  if (user.globalRole === "super_admin") return true;
  return user.permissions.some((p) => p.projectId === projectId);
}

const ROLE_HIERARCHY: Record<ProjectRole, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
};

function getSuperAdminEmails(): string[] {
  const raw = process.env.SUPER_ADMIN_EMAILS || "";
  return raw
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Get the current authenticated user from request headers.
 * Auto-provisions new users with zero permissions (UPSERT).
 * Returns null if no authenticated email in headers.
 */
export async function getCurrentUser(): Promise<AuthUser | null> {
  const headerList = await headers();
  const email = headerList.get("x-user-email");

  if (!email) return null;

  const normalizedEmail = email.toLowerCase().trim();

  // UPSERT: create user if they don't exist (handles race conditions)
  await db
    .insert(users)
    .values({ email: normalizedEmail })
    .onConflictDoNothing();

  // Single query: get user + permissions
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, normalizedEmail));

  if (!user) return null;

  const perms = await db
    .select()
    .from(userPermissions)
    .where(eq(userPermissions.userEmail, normalizedEmail));

  // Check super admin status from env var or DB
  const superAdminEmails = getSuperAdminEmails();
  const isSuperAdmin =
    user.globalRole === "super_admin" ||
    superAdminEmails.includes(normalizedEmail);

  const globalRole: GlobalRole = isSuperAdmin ? "super_admin" : null;

  return {
    email: user.email,
    name: user.name,
    isExternal: user.isExternal,
    globalRole,
    permissions: perms.map((p) => ({
      projectId: p.projectId,
      role: p.role as ProjectRole,
    })),
  };
}

/**
 * Require a minimum role on a project. Redirects to / if unauthorized.
 * Super admins bypass all permission checks.
 */
export async function requirePermission(
  projectId: string,
  minRole: ProjectRole
): Promise<AuthUser> {
  const user = await getCurrentUser();

  if (!user) {
    redirect("/");
  }

  // Super admins have full access
  if (user.globalRole === "super_admin") {
    return user;
  }

  const permission = user.permissions.find((p) => p.projectId === projectId);

  if (!permission) {
    redirect("/");
  }

  if (ROLE_HIERARCHY[permission.role] < ROLE_HIERARCHY[minRole]) {
    redirect("/");
  }

  return user;
}

/**
 * Require super admin access. Redirects to / if not admin.
 */
export async function requireAdmin(): Promise<AuthUser> {
  const user = await getCurrentUser();

  if (!user || user.globalRole !== "super_admin") {
    redirect("/");
  }

  return user;
}
