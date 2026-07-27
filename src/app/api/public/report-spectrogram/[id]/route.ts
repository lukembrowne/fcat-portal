/**
 * Public Report Spectrogram API — tokenless, allowlisted by the active snapshot.
 *
 *   /api/public/report-spectrogram/[id]?v=<publish timestamp>
 *
 * Serves the spectrogram image that was pre-rendered at publish time and stored
 * on the curated clip (`spectrogramPng`, a data URI). Splitting it out of the
 * page payload is the point: as an inlined data URI each image was serialized
 * twice per page load (SSR HTML + RSC flight payload) and could never be cached
 * on its own.
 *
 * A spectrogram is servable ONLY if its audio id is in the active snapshot,
 * which is the same allowlist the audio route enforces.
 *
 * The `v` param is the snapshot's publish time. It is not read here — it only
 * makes the URL change when a re-publish re-renders the image, which is what
 * lets the response be cached immutably.
 */

import { NextResponse } from "next/server";
import { getActiveReportSnapshot } from "@/lib/public-report-snapshot";

export const dynamic = "force-dynamic";

/** Split a `data:<mime>;base64,<payload>` URI. Null if it isn't one. */
function parseDataUri(uri: string): { mime: string; bytes: Buffer } | null {
  // `[\s\S]*` rather than `.*` with the /s flag — the TS target predates it.
  const match = /^data:([\w.+/-]+);base64,([\s\S]*)$/.exec(uri);
  if (!match) return null;
  return { mime: match[1], bytes: Buffer.from(match[2], "base64") };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: idParam } = await params;
  const audioId = Number.parseInt(idParam, 10);
  if (!Number.isInteger(audioId) || audioId <= 0) {
    return NextResponse.json({ error: "Invalid audio ID" }, { status: 400 });
  }

  const snapshot = await getActiveReportSnapshot();
  const clip = snapshot?.audio.find((a) => a.audioId === audioId);
  if (!clip?.spectrogramPng) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const parsed = parseDataUri(clip.spectrogramPng);
  if (!parsed) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return new NextResponse(new Uint8Array(parsed.bytes), {
    headers: {
      "Content-Type": parsed.mime,
      // Safe to cache forever: a re-publish changes the `v` param, so a new
      // render is always requested under a new URL.
      "Cache-Control": "public, max-age=31536000, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
