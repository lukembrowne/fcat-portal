/**
 * Public Camera Trap Image API
 *
 * Serves thumbnails for public share links, validated by share token.
 * Only supports ?size=thumb (no full-size serving on public routes).
 *
 * Usage:
 *   /api/public/ct-images/[token]/123?size=thumb
 */

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import path from "path";
import sharp from "sharp";
import { db } from "@/db";
import { shareTokens, images } from "@/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { downloadFileToBuffer } from "@/lib/drive-client";

export const dynamic = "force-dynamic";

const THUMBNAIL_DIR = path.join(process.cwd(), "data", "thumbnails");
const THUMBNAIL_WIDTH = 400;
const THUMBNAIL_QUALITY = 80;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string; id: string }> }
) {
  const { token, id: idParam } = await params;

  // Validate token format (UUID v4)
  if (!token || token.includes("/") || token.includes("\\") || token.includes("..")) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  // Validate image ID
  const imageId = parseInt(idParam, 10);
  if (isNaN(imageId)) {
    return NextResponse.json({ error: "Invalid image ID" }, { status: 400 });
  }

  // Look up the share token
  const [shareToken] = await db
    .select()
    .from(shareTokens)
    .where(
      and(
        eq(shareTokens.token, token),
        sql`${shareTokens.revokedAt} IS NULL`
      )
    );

  if (!shareToken) {
    return NextResponse.json({ error: "Invalid or revoked token" }, { status: 403 });
  }

  // Look up the image and verify it belongs to the token's deployment
  const [image] = await db
    .select()
    .from(images)
    .where(
      and(
        eq(images.id, imageId),
        eq(images.deploymentId, shareToken.deploymentId)
      )
    );

  if (!image) {
    return NextResponse.json({ error: "Image not found" }, { status: 404 });
  }

  const headers: Record<string, string> = {
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Type": "image/jpeg",
  };

  // Always serve as thumbnail
  const thumbPath = path.join(
    THUMBNAIL_DIR,
    String(image.deploymentId),
    `${image.id}.jpg`
  );

  // Check cache
  try {
    const thumbData = await fs.readFile(thumbPath);
    return new NextResponse(new Uint8Array(thumbData), { headers });
  } catch {
    // Cache miss — generate thumbnail
  }

  // Generate from local path
  if (image.path) {
    try {
      const data = await fs.readFile(image.path);
      const thumb = await sharp(data)
        .resize(THUMBNAIL_WIDTH)
        .jpeg({ quality: THUMBNAIL_QUALITY })
        .toBuffer();

      await fs.mkdir(path.dirname(thumbPath), { recursive: true });
      await fs.writeFile(thumbPath, thumb);

      return new NextResponse(new Uint8Array(thumb), { headers });
    } catch {
      // Fall through to Drive
    }
  }

  // Generate from Drive
  if (!image.driveFileId) {
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

    await fs.mkdir(path.dirname(thumbPath), { recursive: true });
    await fs.writeFile(thumbPath, thumb);

    return new NextResponse(new Uint8Array(thumb), { headers });
  } catch (err) {
    console.error(`[public-ct-images] Thumbnail generation failed for image ${imageId}:`, err);
    return NextResponse.json(
      { error: "Failed to load image" },
      { status: 502 }
    );
  }
}
