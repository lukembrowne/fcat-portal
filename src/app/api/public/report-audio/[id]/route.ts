/**
 * Public Report Audio API — tokenless, allowlisted by the active snapshot.
 *
 *   /api/public/report-audio/[id]              → stream clip (Range-aware)
 *   /api/public/report-audio/[id]?download=1   → download with attachment header
 *
 * A clip is servable ONLY if its audio_files.id is in the active BioChoco
 * overview snapshot's curated allowlist.
 *
 * MOBILE-AUDIO FIX: every clip is served as a browser-universal AAC
 * (`audio/mp4`) transcode from a bounded on-disk cache, whatever its source
 * format. Two separate reasons, and BOTH have burned this page:
 *
 *  - Compressed clips are FLAC, which iOS Safari cannot decode in `<audio>`.
 *  - Drive's `files.get?alt=media` ignores the `Range` header we forward to it
 *    and answers 200 with the whole body. iOS probes with a Range request
 *    before playing and refuses any clip whose server answers 200 instead of
 *    206 — so the raw-stream path silently broke uncompressed WAV clips on
 *    iPhone even though WAV itself is a format Safari supports. Only
 *    `serveCachedM4a` (local file, real 206s) satisfies that probe.
 *
 * Transcoding also cuts a 60 s clip from ~5.7 MB of PCM to ~1 MB.
 *
 * The raw Drive stream remains as a fallback when ffmpeg fails: degraded
 * (desktop-only) rather than broken. There is NO amplification vector here
 * (unlike the token-gated site route): the snapshot allowlist is a small fixed
 * set (~6 curated ids), so every eligible id is already bounded.
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { audioFiles } from "@/db/schema";
import { eq } from "drizzle-orm";
import { downloadFileAsStream } from "@/lib/drive-client";
import { getReportAudioAllowlist } from "@/lib/public-report-snapshot";
import { ensureAacTranscode } from "@/lib/audio-transcode";
import { serveCachedM4a } from "@/lib/audio-serve";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: idParam } = await params;
  const audioId = Number.parseInt(idParam, 10);
  if (!Number.isInteger(audioId) || audioId <= 0) {
    return NextResponse.json({ error: "Invalid audio ID" }, { status: 400 });
  }

  // Allowlist gate: only curated ids in the active snapshot are public.
  const allowlist = await getReportAudioAllowlist();
  if (!allowlist.has(audioId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const [audioFile] = await db
    .select({
      driveFileId: audioFiles.driveFileId,
      mimeType: audioFiles.mimeType,
      filename: audioFiles.filename,
      fileSize: audioFiles.fileSize,
    })
    .from(audioFiles)
    .where(eq(audioFiles.id, audioId));

  if (!audioFile || !audioFile.driveFileId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const download = new URL(request.url).searchParams.get("download") === "1";
  const rangeHeader = request.headers.get("range") ?? undefined;

  // Serve a cached AAC transcode so the clip plays on iOS/Safari and honors
  // Range. Bounded by the snapshot allowlist, so no per-id amplification
  // concern. On failure, fall through to the raw Drive stream (still plays on
  // desktop; degraded, not broken).
  try {
    const cachePath = await ensureAacTranscode({
      audioId,
      driveFileId: audioFile.driveFileId,
    });
    return await serveCachedM4a(cachePath, {
      rangeHeader,
      download,
      filename: audioFile.filename,
      // Same clip content per id → safe to cache immutably, like the raw path.
      cacheControl: "public, max-age=31536000, immutable",
    });
  } catch (err) {
    log.error(
      { err, audioId },
      "[public-report-audio] Transcode failed; falling back to raw Drive stream",
    );
  }

  try {
    const result = await downloadFileAsStream(audioFile.driveFileId, rangeHeader);

    const headers: Record<string, string> = {
      "Content-Type": audioFile.mimeType ?? result.contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "Accept-Ranges": "bytes",
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
    log.error({ err, audioId }, "[public-report-audio] Failed to stream clip");
    const is404 =
      err && typeof err === "object" && "code" in err && (err as { code: number }).code === 404;
    return NextResponse.json(
      { error: is404 ? "Not found" : "Upstream error" },
      { status: is404 ? 404 : 502 },
    );
  }
}
