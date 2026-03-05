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
import { db } from "@/db";
import { shareTokens, images } from "@/db/schema";
import { eq, and, sql } from "drizzle-orm";
import { downloadFileToBuffer } from "@/lib/drive-client";
import { getOrGenerateThumbnail } from "@/lib/thumbnail";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string; id: string }> }
) {
  const { token, id: idParam } = await params;

  // Validate token format (UUID v4)
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!token || !UUID_REGEX.test(token)) {
    return NextResponse.json({ error: "Bad request" }, { status: 400 });
  }

  // Validate image ID
  const imageId = parseInt(idParam, 10);
  if (isNaN(imageId)) {
    return NextResponse.json({ error: "Invalid image ID" }, { status: 400 });
  }

  // Look up share token + image in a single query
  const [image] = await db
    .select({
      id: images.id,
      deploymentId: images.deploymentId,
      path: images.path,
      driveFileId: images.driveFileId,
    })
    .from(images)
    .innerJoin(
      shareTokens,
      and(
        eq(shareTokens.deploymentId, images.deploymentId),
        eq(shareTokens.token, token),
        sql`${shareTokens.revokedAt} IS NULL`
      )
    )
    .where(eq(images.id, imageId));

  if (!image) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const headers: Record<string, string> = {
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Type": "image/jpeg",
    "X-Content-Type-Options": "nosniff",
  };

  // Serve thumbnail
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
    return new NextResponse(new Uint8Array(thumb), { headers });
  } catch (err) {
    console.error(`[public-ct-images] Thumbnail generation failed for image ${imageId}:`, err);
    return NextResponse.json({ error: "Failed to load image" }, { status: 502 });
  }
}
