"use server";

import { db } from "@/db";
import { deployments } from "@/db/schema";
import { eq, isNull, or, and } from "drizzle-orm";
import { requirePermission } from "@/lib/auth";
import { getUserCameraTrapProjects, ctProjectFilter, requireDeploymentAccess } from "@/lib/camera-trap-auth";
import { log } from "@/lib/log";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/types";
import {
  matchOdkDeploymentsInternal,
  type MatchResult,
} from "@/lib/camera-trap-sync-internals";

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

    for (const id of deploymentIds) {
      await requireDeploymentAccess(user, id);
    }

    const result = await matchOdkDeploymentsInternal(deploymentIds);
    revalidatePath("/camera-trap");
    return { success: true, data: result };
  } catch (err) {
    log.error({ err }, "[ODK] Match failed");
    return {
      success: false,
      error: err instanceof Error ? err.message : "Error al vincular con ODK",
    };
  }
}

/**
 * Match all deployments with incomplete ODK metadata. Picks up:
 *   - never-matched deployments (no odkSubmissionId), AND
 *   - already-matched deployments that are still missing dateStart or dateEnd.
 *
 * The second case matters because retrieve_sensors is submitted AFTER the
 * install match runs. Without this, once a deployment's install is matched
 * it would never pick up its later retrieval date — the results page would
 * compute 0 camera days forever. matchOdkDeployments() only fills nulls, so
 * this is safe for manually-edited rows (metadataSource=manual is preserved
 * and null-only updates won't clobber user edits).
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
          eq(deployments.odkSubmissionId, ""),
          isNull(deployments.dateStart),
          isNull(deployments.dateEnd),
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

