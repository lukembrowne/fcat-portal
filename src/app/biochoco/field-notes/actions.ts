"use server";

import { requirePermission } from "@/lib/auth";
import { db } from "@/db";
import { deployments, cameraTrapProjects } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/types";
import { log } from "@/lib/log";

const MAX_FIELD_NOTES_LENGTH = 2000;

/** Get the BioChoco ct_project ID for auto-creating deployment records. */
async function getBiochocoCtProjectId(): Promise<number | null> {
  const [row] = await db
    .select({ id: cameraTrapProjects.id })
    .from(cameraTrapProjects)
    .where(eq(cameraTrapProjects.name, "BioChoco"));
  return row?.id ?? null;
}

/**
 * Update or create field notes for a deployment.
 * Accepts deployment name (string) since schedule tables don't have DB integer IDs.
 * Auto-creates a minimal deployment record if none exists.
 */
export async function updateDeploymentFieldNotes(
  deploymentName: string,
  notes: string | null
): Promise<ActionResult> {
  await requirePermission("biochoco", "editor");

  try {
    // Validate
    const trimmed = notes?.trim() || null;
    if (trimmed && trimmed.length > MAX_FIELD_NOTES_LENGTH) {
      return {
        success: false,
        error: `Las notas de campo no pueden superar los ${MAX_FIELD_NOTES_LENGTH} caracteres`,
      };
    }

    if (!deploymentName) {
      return { success: false, error: "ID de instalación requerido" };
    }

    // Look up existing deployment by name
    const [existing] = await db
      .select({ id: deployments.id })
      .from(deployments)
      .where(eq(deployments.name, deploymentName));

    if (existing) {
      // Update existing record
      await db
        .update(deployments)
        .set({ fieldNotes: trimmed, updatedAt: new Date() })
        .where(eq(deployments.id, existing.id));
    } else {
      // Auto-create minimal deployment record
      const ctProjectId = await getBiochocoCtProjectId();
      await db.insert(deployments).values({
        name: deploymentName,
        projectId: "camera-trap",
        cameraTrapProjectId: ctProjectId,
        fieldNotes: trimmed,
      });
    }

    revalidatePath("/biochoco/overview");
    revalidatePath("/biochoco/data");
    return { success: true, data: undefined };
  } catch (error) {
    log.error({ err: error }, "Failed to update field notes");
    return {
      success: false,
      error: error instanceof Error ? error.message : "Error al guardar notas de campo",
    };
  }
}
