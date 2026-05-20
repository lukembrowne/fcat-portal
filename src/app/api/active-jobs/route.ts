/**
 * Lightweight endpoint returning any active (pending/processing) jobs.
 * Polled by the FloatingJobProgress component every 3s.
 *
 * Auth: requires a logged-in user with at least viewer access to the
 * "camera-trap" project. Users without access get an empty array (no leak).
 * Each job carries `canCancel` so the UI can hide the cancel button for
 * viewers (cancelJob/cancelQueue server actions also enforce editor+).
 */

import { getCurrentUser, hasProjectAccess } from "@/lib/auth";
import { listActiveJobsForDisplay } from "@/lib/job-display";

export const dynamic = "force-dynamic";

const CAMERA_TRAP = "camera-trap";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!hasProjectAccess(user, CAMERA_TRAP)) {
    return Response.json([]);
  }

  const isSuperAdmin = user.globalRole === "super_admin";
  const role = user.permissions.find((p) => p.projectId === CAMERA_TRAP)?.role;
  const canCancel = isSuperAdmin || role === "editor" || role === "admin";

  const rows = await listActiveJobsForDisplay(canCancel);
  return Response.json(rows);
}
