/**
 * Public Camera Trap Image API — Biochoco Site Share Tokens
 *
 * Serves images for landowner-facing biochoco site share links. Each
 * request validates that the requested image belongs to one of the
 * deployments materialized on the share token at creation time.
 *
 *   /api/public/site-images/[token]/[id]?size=thumb
 *   /api/public/site-images/[token]/[id]?size=large
 *   /api/public/site-images/[token]/[id]?size=large&download=1
 *
 * Sizes:
 *   thumb (default) — reuses the existing thumbnail pipeline (~400px,
 *                     cached in data/thumbnails/{deploymentId}/{id}.jpg)
 *   large           — on-the-fly sharp resize: max edge 1600px, JPEG q85.
 *                     EXIF (including GPS) is stripped because sharp
 *                     does not preserve metadata by default.
 *
 * Originals are never served byte-for-byte. Multi-species images get a
 * deterministic filename (FCAT-<siteId>-<imageId>.jpg) on download — no
 * species-name disambiguation since one image can have multiple verified
 * identifications.
 */

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import sharp from "sharp";
import { db } from "@/db";
import { siteShareTokens, images } from "@/db/schema";
import { eq, and, sql, inArray } from "drizzle-orm";
import { downloadFileToBuffer } from "@/lib/drive-client";
import { getOrGenerateThumbnail } from "@/lib/thumbnail";
import { isValidShareToken } from "@/lib/public-tokens";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

const LARGE_MAX_EDGE = 1600;
const LARGE_QUALITY = 85;
// Hard cap on input pixels to prevent decompression bombs.
const LARGE_INPUT_PIXEL_LIMIT = 100_000_000; // ~100MP

async function loadOriginalBuffer(
  localPath: string | null,
  driveFileId: string | null,
): Promise<Buffer | null> {
  if (localPath) {
    try {
      return await fs.readFile(localPath);
    } catch {
      // Fall through to Drive.
    }
  }
  if (driveFileId) {
    return await downloadFileToBuffer(driveFileId);
  }
  return null;
}

async function resizeLarge(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer, { limitInputPixels: LARGE_INPUT_PIXEL_LIMIT })
    .rotate() // honor EXIF orientation, then strip
    .resize({
      width: LARGE_MAX_EDGE,
      height: LARGE_MAX_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: LARGE_QUALITY, mozjpeg: true })
    .toBuffer();
}

function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string; id: string }> },
) {
  const { token, id: idParam } = await params;

  if (!isValidShareToken(token)) {
    return badRequest("Bad request");
  }

  const imageId = Number.parseInt(idParam, 10);
  if (!Number.isInteger(imageId) || imageId <= 0) {
    return badRequest("Invalid image ID");
  }

  const url = new URL(request.url);
  const sizeParam = url.searchParams.get("size") ?? "thumb";
  if (sizeParam !== "thumb" && sizeParam !== "large") {
    return badRequest("Invalid size");
  }
  const isDownload = url.searchParams.get("download") === "1";

  // 1) Resolve the share token + parse its deployment ID list.
  const [tokenRow] = await db
    .select({
      id: siteShareTokens.id,
      biochocoSiteId: siteShareTokens.biochocoSiteId,
      deploymentIds: siteShareTokens.deploymentIds,
    })
    .from(siteShareTokens)
    .where(
      and(
        eq(siteShareTokens.token, token),
        sql`${siteShareTokens.revokedAt} IS NULL`,
      ),
    );

  if (!tokenRow) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let deploymentIds: number[];
  try {
    const parsed = JSON.parse(tokenRow.deploymentIds);
    if (
      !Array.isArray(parsed) ||
      !parsed.every((v) => Number.isInteger(v))
    ) {
      return NextResponse.json({ error: "Invalid token state" }, { status: 500 });
    }
    deploymentIds = parsed as number[];
  } catch {
    return NextResponse.json({ error: "Invalid token state" }, { status: 500 });
  }

  if (deploymentIds.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // 2) Fetch the image and verify it belongs to one of the materialized
  //    deployments. The IN-list gate is the cross-site security check.
  const [image] = await db
    .select({
      id: images.id,
      deploymentId: images.deploymentId,
      path: images.path,
      driveFileId: images.driveFileId,
    })
    .from(images)
    .where(
      and(
        eq(images.id, imageId),
        inArray(images.deploymentId, deploymentIds),
      ),
    );

  if (!image) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const baseHeaders: Record<string, string> = {
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Type": "image/jpeg",
    "X-Content-Type-Options": "nosniff",
  };

  // 3a) Thumbnail — reuse the existing pipeline (cached on disk).
  if (sizeParam === "thumb") {
    try {
      const thumb = await getOrGenerateThumbnail(
        image.id,
        image.deploymentId,
        image.path,
        image.driveFileId,
        downloadFileToBuffer,
      );
      if (!thumb) {
        return NextResponse.json(
          { error: "No image source available" },
          { status: 404 },
        );
      }
      return new NextResponse(new Uint8Array(thumb), { headers: baseHeaders });
    } catch (err) {
      log.error(
        { err, imageId },
        "[public-site-images] Thumbnail generation failed",
      );
      return NextResponse.json(
        { error: "Failed to load image" },
        { status: 502 },
      );
    }
  }

  // 3b) Large — on-the-fly sharp resize. EXIF is stripped because sharp
  //     does not preserve metadata by default.
  try {
    const original = await loadOriginalBuffer(image.path, image.driveFileId);
    if (!original) {
      return NextResponse.json(
        { error: "No image source available" },
        { status: 404 },
      );
    }
    const large = await resizeLarge(original);

    const headers: Record<string, string> = { ...baseHeaders };
    if (isDownload) {
      const filename = `FCAT-${tokenRow.biochocoSiteId}-${image.id}.jpg`;
      headers["Content-Disposition"] = `attachment; filename="${filename}"`;
    }
    return new NextResponse(new Uint8Array(large), { headers });
  } catch (err) {
    log.error(
      { err, imageId },
      "[public-site-images] Large generation failed",
    );
    return NextResponse.json(
      { error: "Failed to load image" },
      { status: 502 },
    );
  }
}
