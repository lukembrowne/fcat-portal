"use server";

import { db } from "@/db";
import { users, userPermissions, projects, cameraTrapProjects, cameraTrapProjectAccess, deployments } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth";
import { recordEvent } from "@/lib/system-events";
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
  const admin = await requireAdmin();

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

    if (isExternal) {
      await writeAllowedEmailsFile();
    }

    await recordEvent({
      source: "admin",
      eventType: "user_added",
      summary: `Usuario agregado: ${normalizedEmail}${isExternal ? " (externo)" : ""}`,
      actorEmail: admin.email,
      targetType: "user",
      targetId: normalizedEmail,
      details: { email: normalizedEmail, name, isExternal },
    });

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
  const admin = await requireAdmin();

  try {
    const [existing] = await db
      .select({ isExternal: users.isExternal })
      .from(users)
      .where(eq(users.email, email));

    // Permissions are cascade-deleted via foreign key
    await db.delete(users).where(eq(users.email, email));

    if (existing?.isExternal) {
      await writeAllowedEmailsFile();
    }

    await recordEvent({
      source: "admin",
      eventType: "user_removed",
      summary: `Usuario eliminado: ${email}`,
      severity: "warn",
      actorEmail: admin.email,
      targetType: "user",
      targetId: email,
      details: { email, wasExternal: existing?.isExternal ?? false },
    });

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
  const admin = await requireAdmin();

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

    const previousRole = existing[0]?.role ?? null;

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

    await recordEvent({
      source: "admin",
      eventType: previousRole ? "permission_changed" : "permission_granted",
      summary: previousRole
        ? `Permiso actualizado · ${email} en ${projectId}: ${previousRole} → ${role}`
        : `Permiso otorgado · ${email} en ${projectId}: ${role}`,
      actorEmail: admin.email,
      projectId,
      targetType: "user",
      targetId: email,
      details: { email, projectId, from: previousRole, to: role },
    });

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
  const admin = await requireAdmin();

  try {
    const [existing] = await db
      .select({ role: userPermissions.role })
      .from(userPermissions)
      .where(
        and(
          eq(userPermissions.userEmail, email),
          eq(userPermissions.projectId, projectId)
        )
      );

    await db
      .delete(userPermissions)
      .where(
        and(
          eq(userPermissions.userEmail, email),
          eq(userPermissions.projectId, projectId)
        )
      );

    await recordEvent({
      source: "admin",
      eventType: "permission_revoked",
      summary: `Permiso revocado · ${email} en ${projectId}${existing ? ` (era ${existing.role})` : ""}`,
      severity: "warn",
      actorEmail: admin.email,
      projectId,
      targetType: "user",
      targetId: email,
      details: { email, projectId, previousRole: existing?.role ?? null },
    });

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

async function writeAllowedEmailsFile(): Promise<number> {
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

  return emails.length;
}

export async function syncAllowedEmails(): Promise<ActionResult<{ count: number }>> {
  await requireAdmin();

  try {
    const count = await writeAllowedEmailsFile();
    return { success: true, data: { count } };
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
  const admin = await requireAdmin();

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

    await recordEvent({
      source: "admin",
      eventType: "ct_project_created",
      summary: `Proyecto CT creado: ${trimmedName}`,
      actorEmail: admin.email,
      projectId: "camera-trap",
      targetType: "ct_project",
      targetId: created.id,
      details: { name: trimmedName, driveFolderId: created.driveFolderId },
    });

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
  const admin = await requireAdmin();

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

    await recordEvent({
      source: "admin",
      eventType: "ct_project_updated",
      summary: `Proyecto CT ${id} actualizado · campos: ${Object.keys(updates).join(", ")}`,
      actorEmail: admin.email,
      projectId: "camera-trap",
      targetType: "ct_project",
      targetId: id,
      details: { id, updates },
    });

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
  const admin = await requireAdmin();

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

    const [existing] = await db
      .select({ name: cameraTrapProjects.name })
      .from(cameraTrapProjects)
      .where(eq(cameraTrapProjects.id, id));

    await db.delete(cameraTrapProjects).where(eq(cameraTrapProjects.id, id));

    await recordEvent({
      source: "admin",
      eventType: "ct_project_deleted",
      summary: `Proyecto CT eliminado: ${existing?.name ?? `id ${id}`}`,
      severity: "warn",
      actorEmail: admin.email,
      projectId: "camera-trap",
      targetType: "ct_project",
      targetId: id,
      details: { id, name: existing?.name ?? null },
    });

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
  const admin = await requireAdmin();

  try {
    // Capture previous access so the event details can show the diff.
    const previous = await db
      .select({ id: cameraTrapProjectAccess.cameraTrapProjectId })
      .from(cameraTrapProjectAccess)
      .where(eq(cameraTrapProjectAccess.userEmail, email));
    const previousIds = previous.map((r) => r.id).sort((a, b) => a - b);

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

    const sortedNext = [...projectIds].sort((a, b) => a - b);
    await recordEvent({
      source: "admin",
      eventType: "ct_project_access_set",
      summary: `Acceso CT actualizado para ${email}: ${previousIds.length} → ${sortedNext.length} proyecto(s)`,
      actorEmail: admin.email,
      projectId: "camera-trap",
      targetType: "user",
      targetId: email,
      details: { email, from: previousIds, to: sortedNext },
    });

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
