/**
 * Public Report Audio API — tokenless, allowlisted by the active snapshot.
 *
 *   /api/public/report-audio/[id]              → stream clip (Range-aware)
 *   /api/public/report-audio/[id]?download=1   → download with attachment header
 *
 * A clip is servable ONLY if its audio_files.id is in the active BioChoco
 * overview snapshot's curated allowlist. Streams from Drive with Range support,
 * mirroring the internal audio stream route (minus its auth).
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { audioFiles } from "@/db/schema";
import { eq } from "drizzle-orm";
import { downloadFileAsStream } from "@/lib/drive-client";
import { getReportAudioAllowlist } from "@/lib/public-report-snapshot";
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
