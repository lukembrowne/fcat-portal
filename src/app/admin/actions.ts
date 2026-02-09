"use server";

import { db } from "@/db";
import { users, userPermissions, projects } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import fs from "fs/promises";
import path from "path";
import type { ActionResult } from "@/lib/types";

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function getUsers() {
  await requireAdmin();

  const allUsers = await db.select().from(users);
  const allPermissions = await db.select().from(userPermissions);

  const permsByUser = new Map<
    string,
    { projectId: string; role: string }[]
  >();
  for (const perm of allPermissions) {
    const existing = permsByUser.get(perm.userEmail) || [];
    existing.push({ projectId: perm.projectId, role: perm.role });
    permsByUser.set(perm.userEmail, existing);
  }

  return allUsers.map((u) => ({
    ...u,
    permissions: permsByUser.get(u.email) || [],
  }));
}

export async function getProjects() {
  await requireAdmin();
  return db.select().from(projects);
}

// ---------------------------------------------------------------------------
// User Management
// ---------------------------------------------------------------------------

export async function addUser(
  email: string,
  name: string | null,
  isExternal: boolean
): Promise<ActionResult> {
  await requireAdmin();

  const normalizedEmail = email.toLowerCase().trim();

  if (!normalizedEmail || !normalizedEmail.includes("@")) {
    return { success: false, error: "Correo electrónico inválido" };
  }

  try {
    await db
      .insert(users)
      .values({
        email: normalizedEmail,
        name: name || null,
        isExternal,
      })
      .onConflictDoNothing();

    revalidatePath("/admin");
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al agregar usuario",
    };
  }
}

export async function removeUser(email: string): Promise<ActionResult> {
  await requireAdmin();

  try {
    // Permissions are cascade-deleted via foreign key
    await db.delete(users).where(eq(users.email, email));

    revalidatePath("/admin");
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al eliminar usuario",
    };
  }
}

// ---------------------------------------------------------------------------
// Permission Management
// ---------------------------------------------------------------------------

export async function setPermission(
  email: string,
  projectId: string,
  role: string
): Promise<ActionResult> {
  await requireAdmin();

  try {
    // Upsert: insert or update the role
    const existing = await db
      .select()
      .from(userPermissions)
      .where(
        and(
          eq(userPermissions.userEmail, email),
          eq(userPermissions.projectId, projectId)
        )
      );

    if (existing.length > 0) {
      await db
        .update(userPermissions)
        .set({ role: role as "viewer" | "editor" | "admin" })
        .where(
          and(
            eq(userPermissions.userEmail, email),
            eq(userPermissions.projectId, projectId)
          )
        );
    } else {
      await db.insert(userPermissions).values({
        userEmail: email,
        projectId,
        role: role as "viewer" | "editor" | "admin",
      });
    }

    revalidatePath("/admin");
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al asignar permiso",
    };
  }
}

export async function removePermission(
  email: string,
  projectId: string
): Promise<ActionResult> {
  await requireAdmin();

  try {
    await db
      .delete(userPermissions)
      .where(
        and(
          eq(userPermissions.userEmail, email),
          eq(userPermissions.projectId, projectId)
        )
      );

    revalidatePath("/admin");
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al revocar permiso",
    };
  }
}

// ---------------------------------------------------------------------------
// External Email Allowlist Sync
// ---------------------------------------------------------------------------

export async function syncAllowedEmails(): Promise<ActionResult<{ count: number }>> {
  await requireAdmin();

  try {
    const filePath =
      process.env.ALLOWED_EMAILS_PATH || "data/allowed_external_emails.txt";
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(process.cwd(), filePath);

    const externalUsers = await db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.isExternal, true));

    const emails = externalUsers.map((u) => u.email).sort();
    const content = emails.join("\n") + "\n";

    const dir = path.dirname(absolutePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(absolutePath, content, "utf-8");

    return { success: true, data: { count: emails.length } };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al sincronizar",
    };
  }
}
