/**
 * Camera Trap Project-Level Authorization
 *
 * Helpers for filtering camera trap data by user's assigned projects.
 * Super admins bypass all filtering.
 */

import "server-only";

import { db } from "@/db";
import {
  cameraTrapProjectAccess,
  deployments,
  images,
  detections,
  identifications,
} from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { AuthUser } from "@/lib/types";

/**
 * Returns array of camera trap project IDs the user can access,
 * or "all" for super admins (bypass filtering).
 */
export async function getUserCameraTrapProjects(
  user: AuthUser
): Promise<number[] | "all"> {
  if (user.globalRole === "super_admin") return "all";
  const rows = await db
    .select({ id: cameraTrapProjectAccess.cameraTrapProjectId })
    .from(cameraTrapProjectAccess)
    .where(eq(cameraTrapProjectAccess.userEmail, user.email));
  return rows.map((r) => r.id);
}

/**
 * Build a WHERE clause for filtering deployments by user's projects.
 * Returns undefined for super admins (no filter needed).
 */
export function ctProjectFilter(
  projects: number[] | "all"
): SQL | undefined {
  if (projects === "all") return undefined;
  if (projects.length === 0) return inArray(deployments.cameraTrapProjectId, [-1]);
  return inArray(deployments.cameraTrapProjectId, projects);
}

/**
 * Verify user has access to a specific deployment's project.
 * Throws if no access. Used by mutation actions.
 */
export async function requireDeploymentAccess(
  user: AuthUser,
  deploymentId: number
): Promise<void> {
  if (user.globalRole === "super_admin") return;
  const [deployment] = await db
    .select({ ctProjectId: deployments.cameraTrapProjectId })
    .from(deployments)
    .where(eq(deployments.id, deploymentId));
  if (!deployment) throw new Error("Instalación no encontrada");
  const projects = await getUserCameraTrapProjects(user);
  if (projects === "all") return;
  if (
    !deployment.ctProjectId ||
    !projects.includes(deployment.ctProjectId)
  ) {
    throw new Error("No tienes acceso a este proyecto");
  }
}

// --- Entity resolution helpers (entity → deploymentId) ---

export async function getDeploymentIdForImage(
  imageId: number
): Promise<number | null> {
  const [row] = await db
    .select({ deploymentId: images.deploymentId })
    .from(images)
    .where(eq(images.id, imageId));
  return row?.deploymentId ?? null;
}

export async function getDeploymentIdForDetection(
  detectionId: number
): Promise<number | null> {
  const [row] = await db
    .select({ deploymentId: images.deploymentId })
    .from(detections)
    .innerJoin(images, eq(detections.imageId, images.id))
    .where(eq(detections.id, detectionId));
  return row?.deploymentId ?? null;
}

export async function getDeploymentIdForIdentification(
  identificationId: number
): Promise<number | null> {
  const [row] = await db
    .select({ deploymentId: images.deploymentId })
    .from(identifications)
    .innerJoin(detections, eq(identifications.detectionId, detections.id))
    .innerJoin(images, eq(detections.imageId, images.id))
    .where(eq(identifications.id, identificationId));
  return row?.deploymentId ?? null;
}
