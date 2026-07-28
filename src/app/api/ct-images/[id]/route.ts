/**
 * Camera Trap Image Proxy API
 *
 * Serves images from Google Drive with local thumbnail caching.
 * Uses DB image ID as route parameter (not Drive file ID or filesystem path).
 *
 * Usage:
 *   /api/ct-images/123?size=thumb    → cached thumbnail (400px, 80% JPEG)
 *   /api/ct-images/123?size=annotate → cached mid-res (1920px, 80% JPEG)
 *   /api/ct-images/123?size=full     → full image from Drive (default)
 *   /api/ct-images/123?download=true → Content-Disposition: attachment
 */

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { db } from "@/db";
import { images, deployments } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { getUserCameraTrapProjects } from "@/lib/camera-trap-auth";
import { downloadFileToBuffer } from "@/lib/drive-client";
import {
  getOrGenerateThumbnail,
  getOrGenerateSized,
  ANNOTATE_TIER,
  maybeEvictDerivatives,
} from "@/lib/thumbnail";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".webp": "image/webp",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Auth: getCurrentUser() + manual permission check (not requirePermission which redirects)
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const hasAccess =
    user.globalRole === "super_admin" ||
    user.permissions.some((p) => p.projectId === "camera-trap" || p.projectId === "biochoco");
  if (!hasAccess) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id: idParam } = await params;
  const imageId = parseInt(idParam, 10);
  if (isNaN(imageId)) {
    return NextResponse.json({ error: "Invalid image ID" }, { status: 400 });
  }

  // Validate image exists and belongs to a registered deployment
  const [image] = await db
    .select()
    .from(images)
    .where(eq(images.id, imageId));

  if (!image) {
    return NextResponse.json({ error: "Image not found" }, { status: 404 });
  }

  const [deployment] = await db
    .select()
    .from(deployments)
    .where(eq(deployments.id, image.deploymentId));

  if (!deployment) {
    return NextResponse.json(
      { error: "Deployment not found" },
      { status: 404 }
    );
  }

  // CT project-level access check
  const ctProjects = await getUserCameraTrapProjects(user);
  if (ctProjects !== "all") {
    if (
      deployment.cameraTrapProjectId == null ||
      !ctProjects.includes(deployment.cameraTrapProjectId)
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const { searchParams } = request.nextUrl;
  const size = searchParams.get("size") || "full";
  const download = searchParams.get("download") === "true";

  const ext = path.extname(image.filename).toLowerCase();
  const contentType = MIME_TYPES[ext] || "image/jpeg";

  const headers: Record<string, string> = {
    "Cache-Control": "public, max-age=31536000, immutable",
  };

  if (download) {
    headers["Content-Disposition"] = `attachment; filename="${image.filename}"`;
  }

  // --- Thumbnail ---
  if (size === "thumb") {
    try {
      const thumb = await getOrGenerateThumbnail(
        image.id,
        image.deploymentId,
        image.path,
        image.driveFileId,
        downloadFileToBuffer,
      );
      if (!thumb) {
        return NextResponse.json({ error: "No image source available" }, { status: 404 });
      }
      return new NextResponse(new Uint8Array(thumb), {
        headers: { ...headers, "Content-Type": "image/jpeg" },
      });
    } catch (err) {
      log.error({ err, imageId }, "[ct-images] Thumbnail generation failed");
      const { status, error } = classifyImageError(err);
      return NextResponse.json({ error }, { status });
    }
  }

  // --- Annotation tier (1920px) ---
  // Served to the annotation viewer: ~hundreds of KB instead of the ~19 MB
  // original, visually identical at fit-to-screen. Same lazy-generate-and-cache
  // path as thumbnails; full-res (?size=full) is unchanged for export/training.
  if (size === "annotate") {
    try {
      const buf = await getOrGenerateSized(
        ANNOTATE_TIER,
        image.id,
        image.deploymentId,
        image.path,
        image.driveFileId,
        downloadFileToBuffer,
      );
      if (!buf) {
        return NextResponse.json({ error: "No image source available" }, { status: 404 });
      }
      // Keep the derivative cache bounded without scanning on every request.
      maybeEvictDerivatives();
      return new NextResponse(new Uint8Array(buf), {
        headers: { ...headers, "Content-Type": "image/jpeg" },
      });
    } catch (err) {
      log.error({ err, imageId }, "[ct-images] Annotate generation failed");
      const { status, error } = classifyImageError(err);
      return NextResponse.json({ error }, { status });
    }
  }

  // --- Full image ---
  // Check cache first (images.path may point to cached file on disk)
  if (image.path) {
    try {
      const data = await fs.readFile(image.path);
      return new NextResponse(new Uint8Array(data), {
        headers: { ...headers, "Content-Type": contentType },
      });
    } catch {
      // Cache miss (file deleted by eviction or not found) — fall through to Drive
    }
  }

  // Fall back to Drive API
  if (!image.driveFileId) {
    return NextResponse.json(
      { error: "No image source available" },
      { status: 404 }
    );
  }

  try {
    const buffer = await downloadFileToBuffer(image.driveFileId);
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        ...headers,
        "Content-Type": contentType,
        "Content-Length": buffer.length.toString(),
      },
    });
  } catch (err) {
    log.error({ err, imageId }, "[ct-images] Failed to serve image");
    const { status, error } = classifyImageError(err);
    return NextResponse.json({ error }, { status });
  }
}

function isDriveNotFound(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    return (err as { code: number }).code === 404;
  }
  return false;
}

/**
 * Classify a derivative-generation failure.
 *
 * The whole pipeline used to collapse to `502 {"error":"Drive API error"}`, which
 * blamed Drive for what was really libvips refusing to decode a damaged JPEG —
 * that misattribution is what made POT-001/POT-003 look like a Drive outage. Keep
 * decode failures distinguishable from transport failures.
 */
function classifyImageError(err: unknown): { status: number; error: string } {
  if (isDriveNotFound(err)) {
    return { status: 404, error: "File not found on Drive" };
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/VipsJpeg|Corrupt JPEG|premature end|unsupported image format/i.test(message)) {
    return { status: 415, error: "Corrupt image data — cannot decode" };
  }
  return { status: 502, error: "Drive API error" };
}
