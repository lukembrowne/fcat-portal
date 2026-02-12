/**
 * Camera Trap Image Proxy API
 *
 * Serves images from Google Drive with local thumbnail caching.
 * Uses DB image ID as route parameter (not Drive file ID or filesystem path).
 *
 * Usage:
 *   /api/ct-images/123?size=thumb    → cached thumbnail (400px, 80% JPEG)
 *   /api/ct-images/123?size=full     → full image from Drive (default)
 *   /api/ct-images/123?download=true → Content-Disposition: attachment
 */

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import sharp from "sharp";
import { db } from "@/db";
import { images, deployments } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { downloadFileToBuffer } from "@/lib/drive-client";

export const dynamic = "force-dynamic";

const THUMBNAIL_DIR = path.join(process.cwd(), "data", "thumbnails");
const THUMBNAIL_WIDTH = 400;
const THUMBNAIL_QUALITY = 80;

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
    user.permissions.some((p) => p.projectId === "camera-trap");
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
    const thumbPath = path.join(
      THUMBNAIL_DIR,
      String(image.deploymentId),
      `${image.id}.jpg`
    );

    // Check cache
    try {
      const thumbData = await fs.readFile(thumbPath);
      return new NextResponse(thumbData, {
        headers: { ...headers, "Content-Type": "image/jpeg" },
      });
    } catch {
      // Cache miss — generate thumbnail
    }

    // Need Drive file ID to download
    if (!image.driveFileId) {
      // Fallback: serve from local path if available
      if (image.path) {
        try {
          const data = await fs.readFile(image.path);
          const thumb = await sharp(data)
            .resize(THUMBNAIL_WIDTH)
            .jpeg({ quality: THUMBNAIL_QUALITY })
            .toBuffer();

          await fs.mkdir(path.dirname(thumbPath), { recursive: true });
          await fs.writeFile(thumbPath, thumb);

          return new NextResponse(thumb, {
            headers: { ...headers, "Content-Type": "image/jpeg" },
          });
        } catch {
          return NextResponse.json(
            { error: "Failed to generate thumbnail" },
            { status: 500 }
          );
        }
      }
      return NextResponse.json(
        { error: "No image source available" },
        { status: 404 }
      );
    }

    try {
      const buffer = await downloadFileToBuffer(image.driveFileId);
      const thumb = await sharp(buffer)
        .resize(THUMBNAIL_WIDTH)
        .jpeg({ quality: THUMBNAIL_QUALITY })
        .toBuffer();

      // Cache the thumbnail
      await fs.mkdir(path.dirname(thumbPath), { recursive: true });
      await fs.writeFile(thumbPath, thumb);

      return new NextResponse(thumb, {
        headers: { ...headers, "Content-Type": "image/jpeg" },
      });
    } catch (err) {
      console.error(`[ct-images] Thumbnail generation failed for image ${imageId}:`, err);
      const status = isDriveNotFound(err) ? 404 : 502;
      return NextResponse.json(
        { error: status === 404 ? "File not found on Drive" : "Drive API error" },
        { status }
      );
    }
  }

  // --- Full image ---
  if (!image.driveFileId) {
    // Fallback: serve from local path if available
    if (image.path) {
      try {
        const data = await fs.readFile(image.path);
        return new NextResponse(data, {
          headers: { ...headers, "Content-Type": contentType },
        });
      } catch {
        return NextResponse.json({ error: "File not found" }, { status: 404 });
      }
    }
    return NextResponse.json(
      { error: "No image source available" },
      { status: 404 }
    );
  }

  try {
    const buffer = await downloadFileToBuffer(image.driveFileId);
    return new NextResponse(buffer, {
      headers: {
        ...headers,
        "Content-Type": contentType,
        "Content-Length": buffer.length.toString(),
      },
    });
  } catch (err) {
    console.error(`[ct-images] Failed to serve image ${imageId}:`, err);
    const status = isDriveNotFound(err) ? 404 : 502;
    return NextResponse.json(
      { error: status === 404 ? "File not found on Drive" : "Drive API error" },
      { status }
    );
  }
}

function isDriveNotFound(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    return (err as { code: number }).code === 404;
  }
  return false;
}
