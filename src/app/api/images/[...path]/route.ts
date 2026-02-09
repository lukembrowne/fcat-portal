/**
 * Image Serving API Route
 *
 * Serves camera trap images from the filesystem. Validates that the
 * requested path belongs to a registered deployment for security.
 *
 * Usage:
 *   /api/images/<absolute-path>?size=thumb  → serves thumbnail
 *   /api/images/<absolute-path>?size=full   → streams original (default)
 */

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import { db } from "@/db";
import { deployments, images } from "@/db/schema";
import { eq } from "drizzle-orm";

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
  { params }: { params: Promise<{ path: string[] }> }
) {
  const { path: pathSegments } = await params;

  const imagePath = "/" + pathSegments.join("/");

  // Prevent path traversal
  const resolved = path.resolve(imagePath);
  if (resolved !== imagePath) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  // Validate the path belongs to a registered deployment
  const allDeployments = await db.select().from(deployments);
  const isRegistered = allDeployments.some((d) =>
    resolved.startsWith(d.path)
  );

  if (!isRegistered) {
    return NextResponse.json(
      { error: "Path not in a registered deployment" },
      { status: 403 }
    );
  }

  const { searchParams } = request.nextUrl;
  const size = searchParams.get("size") || "full";

  if (size === "thumb") {
    const [imageRecord] = await db
      .select()
      .from(images)
      .where(eq(images.path, resolved));

    if (imageRecord?.thumbnailPath) {
      try {
        const thumbData = await fs.readFile(imageRecord.thumbnailPath);
        return new NextResponse(thumbData, {
          headers: {
            "Content-Type": "image/jpeg",
            "Cache-Control": "public, max-age=31536000, immutable",
          },
        });
      } catch {
        // Thumbnail missing, fall through to serve original
      }
    }
  }

  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) {
      return NextResponse.json({ error: "Not a file" }, { status: 404 });
    }

    const ext = path.extname(resolved).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";

    const data = await fs.readFile(resolved);
    return new NextResponse(data, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": stat.size.toString(),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    if (message.includes("ENOENT")) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
