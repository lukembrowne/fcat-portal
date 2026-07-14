/**
 * Public Report Image API — tokenless, allowlisted by the active snapshot.
 *
 *   /api/public/report-images/[id]?size=thumb
 *   /api/public/report-images/[id]?size=large
 *   /api/public/report-images/[id]?size=large&download=1
 *
 * An image is servable ONLY if its id is in the active BioChoco overview
 * snapshot's curated allowlist. Mirrors the sharp/EXIF-strip/thumbnail pipeline
 * of the token-gated site-images route; EXIF (incl. GPS) is stripped on `large`.
 */

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import sharp from "sharp";
import { db } from "@/db";
import { images } from "@/db/schema";
import { eq } from "drizzle-orm";
import { downloadFileToBuffer } from "@/lib/drive-client";
import { getOrGenerateThumbnail } from "@/lib/thumbnail";
import { getReportImageAllowlist } from "@/lib/public-report-snapshot";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

const LARGE_MAX_EDGE = 1600;
const LARGE_QUALITY = 85;
const LARGE_INPUT_PIXEL_LIMIT = 100_000_000; // ~100MP decompression-bomb guard

async function loadOriginalBuffer(
  localPath: string | null,
  driveFileId: string | null,
): Promise<Buffer | null> {
  if (localPath) {
    try {
      return await fs.readFile(localPath);
    } catch {
      // fall through to Drive
    }
  }
  if (driveFileId) {
    return await downloadFileToBuffer(driveFileId);
  }
  return null;
}

async function resizeLarge(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer, { limitInputPixels: LARGE_INPUT_PIXEL_LIMIT })
    .rotate() // honor EXIF orientation, then strip (sharp drops metadata by default)
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
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: idParam } = await params;
  const imageId = Number.parseInt(idParam, 10);
  if (!Number.isInteger(imageId) || imageId <= 0) {
    return badRequest("Invalid image ID");
  }

  const url = new URL(request.url);
  const sizeParam = url.searchParams.get("size") ?? "large";
  if (sizeParam !== "thumb" && sizeParam !== "large") {
    return badRequest("Invalid size");
  }
  const isDownload = url.searchParams.get("download") === "1";

  // Allowlist gate: only curated ids in the active snapshot are public.
  const allowlist = await getReportImageAllowlist();
  if (!allowlist.has(imageId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const [image] = await db
    .select({
      id: images.id,
      deploymentId: images.deploymentId,
      path: images.path,
      driveFileId: images.driveFileId,
    })
    .from(images)
    .where(eq(images.id, imageId));

  if (!image) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const baseHeaders: Record<string, string> = {
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Type": "image/jpeg",
    "X-Content-Type-Options": "nosniff",
  };

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
        return NextResponse.json({ error: "No image source available" }, { status: 404 });
      }
      return new NextResponse(new Uint8Array(thumb), { headers: baseHeaders });
    } catch (err) {
      log.error({ err, imageId }, "[public-report-images] Thumbnail generation failed");
      return NextResponse.json({ error: "Failed to load image" }, { status: 502 });
    }
  }

  try {
    const original = await loadOriginalBuffer(image.path, image.driveFileId);
    if (!original) {
      return NextResponse.json({ error: "No image source available" }, { status: 404 });
    }
    const large = await resizeLarge(original);
    const headers: Record<string, string> = { ...baseHeaders };
    if (isDownload) {
      headers["Content-Disposition"] = `attachment; filename="FCAT-biochoco-${image.id}.jpg"`;
    }
    return new NextResponse(new Uint8Array(large), { headers });
  } catch (err) {
    log.error({ err, imageId }, "[public-report-images] Large generation failed");
    return NextResponse.json({ error: "Failed to load image" }, { status: 502 });
  }
}
