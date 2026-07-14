/**
 * Public Intro/Thank-You Video — tokenless, single global fixed asset.
 *
 *   /api/public/intro-video   → stream the configured intro video (Range-aware)
 *
 * This is ONE video shared by every landowner page (e.g. a recorded FCAT
 * thank-you), not a per-site asset — so there is no token/deployment gate here
 * (mirrors the public OG image being globally readable). The per-site,
 * token-scoped video route is deferred to the Phase 3 montage.
 *
 * The Drive file id comes from LANDOWNER_INTRO_VIDEO_DRIVE_FILE_ID. When unset,
 * the route 404s and the page renders no video block (placeholder state).
 * Streams from Drive with Range support via downloadFileAsStream.
 */

import { NextRequest, NextResponse } from "next/server";
import { downloadFileAsStream } from "@/lib/drive-client";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const fileId = process.env.LANDOWNER_INTRO_VIDEO_DRIVE_FILE_ID;
  if (!fileId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const rangeHeader = request.headers.get("range") ?? undefined;

  try {
    const result = await downloadFileAsStream(fileId, rangeHeader);

    const headers: Record<string, string> = {
      "Content-Type": result.contentType || "video/mp4",
      // Not immutable — the underlying asset can be swapped; cache a day.
      "Cache-Control": "public, max-age=86400",
      "Accept-Ranges": "bytes",
    };
    if (result.contentLength != null) {
      headers["Content-Length"] = String(result.contentLength);
    }
    if (result.contentRange) {
      headers["Content-Range"] = result.contentRange;
    }

    return new Response(result.stream as unknown as ReadableStream, {
      status: result.contentRange ? 206 : 200,
      headers,
    });
  } catch (err) {
    log.error({ err }, "[public-intro-video] Failed to stream intro video");
    const is404 =
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: number }).code === 404;
    return NextResponse.json(
      { error: is404 ? "Not found" : "Upstream error" },
      { status: is404 ? 404 : 502 },
    );
  }
}
