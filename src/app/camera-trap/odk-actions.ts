"use server";

import { db } from "@/db";
import { deployments } from "@/db/schema";
import { eq, inArray, isNull, or, and } from "drizzle-orm";
import { fetchEntities, fetchSubmissions } from "@/lib/odk-client";
import {
  BIOCHOCO_PROJECT_ID,
  BIOCHOCO_DATASET_SITES,
  BIOCHOCO_FORM_DEPLOY,
} from "@/lib/odk-constants";
import type { OdkSiteEntity } from "@/lib/odk-types";
import { requirePermission } from "@/lib/auth";
import { getUserCameraTrapProjects, ctProjectFilter, requireDeploymentAccess } from "@/lib/camera-trap-auth";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/types";

interface OdkMatch {
  deploymentId: number;
  deploymentName: string;
  odkSubmissionId: string;
  odkDeploymentId: string;
  siteName: string | null;
  latitude: number | null;
  longitude: number | null;
  dateStart: string | null;
}

interface MatchResult {
  matched: OdkMatch[];
  unmatched: string[];
}

// ---------------------------------------------------------------------------
// ODK Auto-Match
// ---------------------------------------------------------------------------

/**
 * Match deployments against ODK instalar_sensores submissions.
 * Only fills NULL fields — never overwrites user-edited data.
 */
export async function matchOdkDeployments(
  deploymentIds: number[]
): Promise<ActionResult<MatchResult>> {
  const user = await requirePermission("camera-trap", "editor");

  try {
    if (deploymentIds.length === 0) {
      return { success: true, data: { matched: [], unmatched: [] } };
    }

    // Verify access to all requested deployments
    for (const id of deploymentIds) {
      await requireDeploymentAccess(user, id);
    }

    // Fetch deployments to match
    const deploymentsToMatch = await db
      .select()
      .from(deployments)
      .where(inArray(deployments.id, deploymentIds));

    // Fetch ODK data in parallel
    const [rawSubmissions, rawSites] = await Promise.all([
      fetchSubmissions<Record<string, unknown>>(
        BIOCHOCO_PROJECT_ID,
        BIOCHOCO_FORM_DEPLOY
      ),
      fetchEntities<OdkSiteEntity>(
        BIOCHOCO_PROJECT_ID,
        BIOCHOCO_DATASET_SITES
      ),
    ]);

    // Build site lookup: site_id → { name, lat, lng }
    const siteMap = new Map<
      string,
      { name: string; lat: number | null; lng: number | null }
    >();
    for (const site of rawSites) {
      siteMap.set(site.site_id, {
        name: site.site_name ?? site.label ?? "",
        lat: site.latitude ? parseFloat(String(site.latitude)) : null,
        lng: site.longitude ? parseFloat(String(site.longitude)) : null,
      });
    }

    // Extract submission data (handle nested site_selection group)
    interface ParsedSubmission {
      id: string;
      deploymentId: string;
      siteId: string;
      dateInstalled: string | null;
    }

    const submissions: ParsedSubmission[] = rawSubmissions
      .map((sub) => {
        const sel = sub.site_selection as Record<string, unknown> | undefined;
        const deployId =
          (sel?.deployment_id as string) ??
          (sub.deployment_id as string) ??
          "";
        const siteId =
          (sel?.site_id as string) ?? (sub.site_id as string) ?? "";
        const depInfo = sub.deployment_info as Record<string, unknown> | undefined;
        const dateInstalled =
          (depInfo?.deploy_date as string) ??
          (sel?.fecha_instalacion as string) ??
          (sub.fecha_instalacion as string) ??
          null;
        return {
          id: sub.__id as string,
          deploymentId: deployId,
          siteId,
          dateInstalled,
        };
      })
      .filter((s) => s.deploymentId);

    // Build submission lookup: normalized deployment_id → submission
    const submissionMap = new Map<string, ParsedSubmission>();
    for (const sub of submissions) {
      submissionMap.set(normalize(sub.deploymentId), sub);
    }

    // Match deployments
    const matched: OdkMatch[] = [];
    const unmatched: string[] = [];

    for (const dep of deploymentsToMatch) {
      const normalizedName = normalize(dep.name);
      const sub = submissionMap.get(normalizedName);

      if (!sub) {
        unmatched.push(dep.name);
        continue;
      }

      const site = siteMap.get(sub.siteId);

      const match: OdkMatch = {
        deploymentId: dep.id,
        deploymentName: dep.name,
        odkSubmissionId: sub.id,
        odkDeploymentId: sub.deploymentId,
        siteName: site?.name ?? null,
        latitude: site?.lat ?? null,
        longitude: site?.lng ?? null,
        dateStart: sub.dateInstalled,
      };

      matched.push(match);

      // Update deployment — only fill NULL fields
      const updates: Record<string, unknown> = {
        odkSubmissionId: sub.id,
        metadataSource: "odk",
        updatedAt: new Date(),
      };

      if (!dep.siteName && site?.name) updates.siteName = site.name;
      if (dep.latitude == null && site?.lat != null) updates.latitude = site.lat;
      if (dep.longitude == null && site?.lng != null)
        updates.longitude = site.lng;
      if (!dep.dateStart && sub.dateInstalled)
        updates.dateStart = sub.dateInstalled;

      await db
        .update(deployments)
        .set(updates)
        .where(eq(deployments.id, dep.id));
    }

    revalidatePath("/camera-trap");
    return { success: true, data: { matched, unmatched } };
  } catch (err) {
    console.error("[ODK] Match failed:", err);
    return {
      success: false,
      error: err instanceof Error ? err.message : "Error al vincular con ODK",
    };
  }
}

/**
 * Match all unmatched deployments (those without an odkSubmissionId).
 */
export async function matchAllUnmatched(): Promise<ActionResult<MatchResult>> {
  const user = await requirePermission("camera-trap", "editor");
  const ctProjects = await getUserCameraTrapProjects(user);

  const unmatched = await db
    .select({ id: deployments.id })
    .from(deployments)
    .where(
      and(
        or(
          isNull(deployments.odkSubmissionId),
          eq(deployments.odkSubmissionId, "")
        ),
        ctProjectFilter(ctProjects),
      )
    );

  if (unmatched.length === 0) {
    return { success: true, data: { matched: [], unmatched: [] } };
  }

  return matchOdkDeployments(unmatched.map((d) => d.id));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Normalize a string for fuzzy matching: lowercase, strip whitespace and common separators. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[\s_\-\.]+/g, "")
    .trim();
}
