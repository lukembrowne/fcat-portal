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
 *
 * MOBILE-AUDIO BUG FIX (KTD-7): compressed clips are FLAC (`audio/flac`), which
 * iOS Safari cannot decode in `<audio>`. When the requested id equals the site's
 * `pageConfig`-selected featured audio id AND the source is FLAC, we serve a
 * browser-universal AAC (`audio/mp4`) transcode from a bounded on-disk cache
 * (Range-aware from the LOCAL file). Everything else — WAV/AAC/MP3, or any
 * non-featured id — passes through with today's raw Drive stream. Restricting
 * the transcode to the single featured id closes the amplification vector where
 * a leaked token iterates audioIds to force thousands of ffmpeg runs + cache
 * writes (the 2026-05-25 disk-full failure class). The token/deployment gate
 * runs BEFORE any cache lookup — the cache key has no token component, which is
 * safe ONLY because the gate precedes the serve. Do not reorder.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { siteShareTokens, audioFiles } from "@/db/schema";
import { and, eq, isNull, inArray } from "drizzle-orm";
import { downloadFileAsStream } from "@/lib/drive-client";
import { isValidShareToken } from "@/lib/public-tokens";
import { parsePageConfig } from "@/lib/landowner/page-config";
import { ensureAacTranscode } from "@/lib/audio-transcode";
import { serveCachedM4a } from "@/lib/audio-serve";
import { log } from "@/lib/log";

const FLAC_MIME = "audio/flac";

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
  // `pageConfig` is read alongside so we can identify the ONE featured audio id
  // eligible for transcoding (amplification guard — see file header).
  const [tokenRow] = await db
    .select({
      deploymentIds: siteShareTokens.deploymentIds,
      pageConfig: siteShareTokens.pageConfig,
    })
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

  // The site's featured audio id (from pageConfig) is the ONLY id we transcode.
  const featuredAudioId = resolveFeaturedAudioId(tokenRow.pageConfig);

  // Transcode + serve the cached m4a ONLY for the featured FLAC clip; everything
  // else streams raw from Drive (already iOS-playable, and non-featured ids must
  // never trigger a transcode/cache write).
  if (audioId === featuredAudioId && audioFile.mimeType === FLAC_MIME) {
    try {
      const cachePath = await ensureAacTranscode({
        audioId,
        driveFileId: audioFile.driveFileId,
      });
      return await serveCachedM4a(cachePath, {
        rangeHeader,
        download,
        filename: audioFile.filename,
        // The curated clip can be swapped by the team; cache a day, not immutable.
        cacheControl: "public, max-age=86400",
        // Keep token-gated recordings out of search crawlers.
        noindex: true,
      });
    } catch (err) {
      // Transcode failed — fall through to the raw Drive stream so the clip is
      // still served (FLAC still plays on desktop; degraded, not broken).
      log.error(
        { err, audioId },
        "[public-site-audio] Transcode failed; falling back to raw Drive stream",
      );
    }
  }

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

/**
 * The featured audio id is the `audioId` of the first `featuredAudio` block in
 * the site's stored page config. Returns null when there is no config or no
 * featured-audio selection (→ nothing is eligible to transcode).
 */
function resolveFeaturedAudioId(pageConfig: string | null): number | null {
  const config = parsePageConfig(pageConfig);
  if (!config) return null;
  for (const block of config.blocks) {
    if (block.type === "featuredAudio") return block.audioId;
  }
  return null;
}

