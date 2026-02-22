"use server";

import { db } from "@/db";
import { users, userPermissions, projects, cameraTrapProjects, cameraTrapProjectAccess, deployments } from "@/db/schema";
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

// ---------------------------------------------------------------------------
// Camera Trap Project Management
// ---------------------------------------------------------------------------

export async function getCameraTrapProjects() {
  await requireAdmin();
  return db.select().from(cameraTrapProjects);
}

export async function createCameraTrapProject(
  name: string,
  driveFolderId?: string
): Promise<ActionResult<{ id: number; name: string; driveFolderId: string | null }>> {
  await requireAdmin();

  const trimmedName = name.trim();
  if (!trimmedName) {
    return { success: false, error: "El nombre del proyecto es requerido" };
  }

  try {
    const [created] = await db
      .insert(cameraTrapProjects)
      .values({
        name: trimmedName,
        driveFolderId: driveFolderId?.trim() || null,
      })
      .returning();

    revalidatePath("/admin");
    return { success: true, data: created };
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint")) {
      return { success: false, error: `Ya existe un proyecto con el nombre "${trimmedName}"` };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al crear proyecto",
    };
  }
}

export async function updateCameraTrapProject(
  id: number,
  data: { name?: string; driveFolderId?: string | null }
): Promise<ActionResult<void>> {
  await requireAdmin();

  try {
    const updates: Record<string, unknown> = {};
    if (data.name !== undefined) {
      const trimmed = data.name.trim();
      if (!trimmed) return { success: false, error: "El nombre no puede estar vacío" };
      updates.name = trimmed;
    }
    if (data.driveFolderId !== undefined) {
      updates.driveFolderId = data.driveFolderId?.trim() || null;
    }

    if (Object.keys(updates).length === 0) {
      return { success: true, data: undefined };
    }

    await db
      .update(cameraTrapProjects)
      .set(updates)
      .where(eq(cameraTrapProjects.id, id));

    revalidatePath("/admin");
    revalidatePath("/camera-trap");
    return { success: true, data: undefined };
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint")) {
      return { success: false, error: "Ya existe un proyecto con ese nombre" };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al actualizar proyecto",
    };
  }
}

export async function deleteCameraTrapProject(id: number): Promise<ActionResult<void>> {
  await requireAdmin();

  try {
    // Check for deployments assigned to this project
    const deps = await db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.cameraTrapProjectId, id))
      .limit(1);

    if (deps.length > 0) {
      const count = await db
        .select({ id: deployments.id })
        .from(deployments)
        .where(eq(deployments.cameraTrapProjectId, id));
      return {
        success: false,
        error: `Este proyecto tiene ${count.length} instalación(es). Reasígnalas antes de eliminar.`,
      };
    }

    await db.delete(cameraTrapProjects).where(eq(cameraTrapProjects.id, id));

    revalidatePath("/admin");
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al eliminar proyecto",
    };
  }
}

// ---------------------------------------------------------------------------
// Camera Trap Project Access
// ---------------------------------------------------------------------------

export async function getUserCameraTrapProjectAccess(): Promise<Record<string, number[]>> {
  await requireAdmin();

  const rows = await db.select().from(cameraTrapProjectAccess);

  const accessMap: Record<string, number[]> = {};
  for (const row of rows) {
    if (!accessMap[row.userEmail]) {
      accessMap[row.userEmail] = [];
    }
    accessMap[row.userEmail].push(row.cameraTrapProjectId);
  }
  return accessMap;
}

export async function setCameraTrapProjectAccess(
  email: string,
  projectIds: number[]
): Promise<ActionResult<void>> {
  await requireAdmin();

  try {
    // Delete all existing access for this user
    await db
      .delete(cameraTrapProjectAccess)
      .where(eq(cameraTrapProjectAccess.userEmail, email));

    // Insert new access rows
    if (projectIds.length > 0) {
      await db.insert(cameraTrapProjectAccess).values(
        projectIds.map((pid) => ({
          userEmail: email,
          cameraTrapProjectId: pid,
        }))
      );
    }

    revalidatePath("/admin");
    revalidatePath("/camera-trap");
    return { success: true, data: undefined };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al actualizar acceso",
    };
  }
}
