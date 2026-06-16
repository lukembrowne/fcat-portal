/**
 * Field-upload endpoint: deployment → Drive mapping + routing config.
 *
 * Serves the FCAT Field Uploader desktop app the data it needs to upload an SD
 * card to the right Drive folder: each deployment's host Shared Drive ID + the
 * three upload-subfolder IDs, plus the canonical extension→subfolder routing
 * config (single source of truth from `drive-routing.ts`, so an extension change
 * ships without an app release).
 *
 * Read-only metadata only — NO file bytes transit the portal/droplet.
 *
 * Auth: dedicated Bearer `FIELD_UPLOAD_TOKEN` (timing-safe), NOT user auth /
 * `requirePermission()` — this is a machine endpoint, like the cron routes.
 * `projectId` (= `ct_projects.name`) must be on the `FIELD_UPLOAD_ALLOWED_PROJECTS`
 * allow-list, so a leaked token can never enumerate other projects' drives.
 * Rate-limited; every hit logged. Versioned path (`/v1/`) + `minSupportedVersion`
 * so an obsolete app (which holds a real credential) can be force-upgraded.
 */

import { db } from "@/db";
import { deployments, sharedDrives, cameraTrapProjects } from "@/db/schema";
import { eq } from "drizzle-orm";
import { verifyFieldUploadToken, isProjectAllowed } from "@/lib/field-upload-auth";
import { buildRoutingConfig } from "@/lib/drive-routing";
import { rateLimitAllow } from "@/lib/simple-rate-limit";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

// Bump when the response contract changes incompatibly; the app refuses to run
// below this and prompts the operator to update.
const MIN_SUPPORTED_VERSION = "1.0.0";

function clientKey(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown"
  );
}

export async function GET(request: Request) {
  if (!verifyFieldUploadToken(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const key = clientKey(request);
  if (!rateLimitAllow(`field-upload:${key}`)) {
    return Response.json({ error: "Too Many Requests" }, { status: 429 });
  }

  const projectId = new URL(request.url).searchParams.get("projectId");
  if (!projectId) {
    return Response.json({ error: "projectId requerido" }, { status: 400 });
  }
  if (!isProjectAllowed(projectId)) {
    log.warn({ projectId, key }, "[field-upload] rejected non-allowlisted project");
    return Response.json({ error: "Proyecto no permitido" }, { status: 400 });
  }

  try {
    const rows = await db
      .select({
        name: deployments.name,
        siteName: deployments.siteName,
        uploadCameraFolderId: deployments.uploadCameraFolderId,
        uploadAudioFolderId: deployments.uploadAudioFolderId,
        uploadIbuttonFolderId: deployments.uploadIbuttonFolderId,
        uploadCountsCheckedAt: deployments.uploadCountsCheckedAt,
        driveId: sharedDrives.driveId,
      })
      .from(deployments)
      .innerJoin(
        cameraTrapProjects,
        eq(deployments.cameraTrapProjectId, cameraTrapProjects.id),
      )
      .leftJoin(sharedDrives, eq(deployments.sharedDriveId, sharedDrives.id))
      .where(eq(cameraTrapProjects.name, projectId));

    const list = rows.map((r) => ({
      deploymentId: r.name,
      displayName: r.siteName ? `${r.name} — ${r.siteName}` : r.name,
      // May be null for legacy rows with no shared_drive_id — the app treats a
      // null driveId as "not yet routable" and blocks with a Spanish message.
      driveId: r.driveId ?? null,
      uploadCameraFolderId: r.uploadCameraFolderId ?? null,
      uploadAudioFolderId: r.uploadAudioFolderId ?? null,
      uploadIbuttonFolderId: r.uploadIbuttonFolderId ?? null,
      // Freshness signal for the portal-side folder-ID cache (Unix seconds).
      uploadCountsCheckedAt: r.uploadCountsCheckedAt
        ? Math.floor(r.uploadCountsCheckedAt.getTime() / 1000)
        : null,
    }));

    log.info(
      { projectId, key, count: list.length },
      "[field-upload] served deployment list",
    );

    return Response.json({
      minSupportedVersion: MIN_SUPPORTED_VERSION,
      routing: buildRoutingConfig(),
      deployments: list,
    });
  } catch (err) {
    log.error({ err }, "[field-upload] failed to serve deployment list");
    return Response.json({ error: "Error interno" }, { status: 500 });
  }
}
