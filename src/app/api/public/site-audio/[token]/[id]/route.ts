/**
 * Public Site Audio — token-gated, single curated clip per site.
 *
 *   /api/public/site-audio/[token]/[id]              → stream clip (Range-aware)
 *   /api/public/site-audio/[token]/[id]?download=1   → download with attachment header
 *
 * A clip is servable ONLY if the token is active AND the requested recording's
 * deployment is one of the deployments materialized on the token at creation
 * time (the `deployment_ids` JSON snapshot). This mirrors the sibling
 * site-images route: a token may surface ANY recording from its own site's
 * deployments — the builder now picks the featured clip in `pageConfig`, not
 * the legacy `featured_audio_id` column, so gating on the deployment snapshot
 * keeps builder-selected audio servable while never exposing another site's
 * recordings.
 *
 * Streams from Drive with Range support via downloadFileAsStream, mirroring the
 * public report-audio route (minus its snapshot allowlist) and the token-gated
 * site-images route.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { siteShareTokens, audioFiles } from "@/db/schema";
import { and, eq, isNull, inArray } from "drizzle-orm";
import { downloadFileAsStream } from "@/lib/drive-client";
import { isValidShareToken } from "@/lib/public-tokens";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string; id: string }> },
) {
  const { token, id: idParam } = await params;

  if (!isValidShareToken(token)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const audioId = Number.parseInt(idParam, 10);
  if (!Number.isInteger(audioId) || audioId <= 0) {
    return NextResponse.json({ error: "Invalid audio ID" }, { status: 400 });
  }

  // Token gate: resolve the active token and its materialized deployment list.
  const [tokenRow] = await db
    .select({ deploymentIds: siteShareTokens.deploymentIds })
    .from(siteShareTokens)
    .where(
      and(eq(siteShareTokens.token, token), isNull(siteShareTokens.revokedAt)),
    );

  if (!tokenRow) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let deploymentIds: number[];
  try {
    const parsed = JSON.parse(tokenRow.deploymentIds);
    if (!Array.isArray(parsed) || !parsed.every((v) => Number.isInteger(v))) {
      return NextResponse.json({ error: "Invalid token state" }, { status: 500 });
    }
    deploymentIds = parsed as number[];
  } catch {
    return NextResponse.json({ error: "Invalid token state" }, { status: 500 });
  }

  if (deploymentIds.length === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // The recording is servable only if it belongs to one of the token's
  // deployments. The IN-list gate is the cross-site security check.
  const [audioFile] = await db
    .select({
      deploymentId: audioFiles.deploymentId,
      driveFileId: audioFiles.driveFileId,
      mimeType: audioFiles.mimeType,
      filename: audioFiles.filename,
      fileSize: audioFiles.fileSize,
    })
    .from(audioFiles)
    .where(
      and(
        eq(audioFiles.id, audioId),
        inArray(audioFiles.deploymentId, deploymentIds),
      ),
    );

  if (!audioFile || !audioFile.driveFileId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const download = new URL(request.url).searchParams.get("download") === "1";
  const rangeHeader = request.headers.get("range") ?? undefined;

  try {
    const result = await downloadFileAsStream(audioFile.driveFileId, rangeHeader);

    const headers: Record<string, string> = {
      "Content-Type": audioFile.mimeType ?? result.contentType,
      // The curated clip can be swapped by the team; cache a day, not immutable.
      "Cache-Control": "public, max-age=86400",
      "Accept-Ranges": "bytes",
      // Keep token-gated recordings out of search crawlers.
      "X-Robots-Tag": "noindex",
    };
    if (result.contentLength != null) {
      headers["Content-Length"] = String(result.contentLength);
    } else if (!rangeHeader && audioFile.fileSize != null) {
      headers["Content-Length"] = String(audioFile.fileSize);
    }
    if (result.contentRange) {
      headers["Content-Range"] = result.contentRange;
    }
    if (download) {
      headers["Content-Disposition"] = `attachment; filename="${audioFile.filename}"`;
    }

    return new Response(result.stream as unknown as ReadableStream, {
      status: result.contentRange ? 206 : 200,
      headers,
    });
  } catch (err) {
    log.error({ err, audioId }, "[public-site-audio] Failed to stream clip");
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
