/**
 * Shared helpers for serving a locally-cached transcoded audio file (`.m4a`)
 * with HTTP Range support. Used by the public audio routes that fix the iOS/
 * Safari FLAC-in-`<audio>` limitation by serving an on-demand AAC (`audio/mp4`)
 * transcode instead of the raw FLAC (see `audio-transcode.ts` / KTD-7).
 *
 * Caching/robots posture is parameterized so each route keeps its own policy:
 * the token-gated site route caches a day + noindex; the snapshot-gated report
 * route caches immutably and stays indexable.
 */

import { promises as fs } from "fs";

/** Swap a filename's extension to `.m4a` for the transcoded download name. */
export function toM4aName(filename: string): string {
  return filename.replace(/\.[^./\\]+$/, "") + ".m4a";
}

/**
 * Parse an HTTP `Range` header against a known total size. Supports a single
 * `bytes=start-end`, `bytes=start-`, and suffix `bytes=-N` form. Returns null
 * (→ serve 200 full) for absent/unsatisfiable/multi-range headers.
 */
export function parseRange(
  rangeHeader: string | undefined,
  total: number,
): { start: number; end: number } | null {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;
  const [, startStr, endStr] = match;

  let start: number;
  let end: number;
  if (startStr === "") {
    // Suffix range: last N bytes.
    if (endStr === "") return null;
    const n = Number.parseInt(endStr, 10);
    if (n <= 0) return null;
    start = Math.max(0, total - n);
    end = total - 1;
  } else {
    start = Number.parseInt(startStr, 10);
    end = endStr === "" ? total - 1 : Number.parseInt(endStr, 10);
  }

  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  if (start > end || start >= total) return null;
  if (end >= total) end = total - 1;
  return { start, end };
}

export interface ServeCachedM4aOpts {
  rangeHeader: string | undefined;
  download: boolean;
  filename: string;
  /** Cache-Control header value. Defaults to a 1-day public cache. */
  cacheControl?: string;
  /** When true, add `X-Robots-Tag: noindex` (for token-gated, private clips). */
  noindex?: boolean;
}

/**
 * Serve a locally-cached `.m4a` with Range support (206 partial / 200 full) and
 * `Content-Type: audio/mp4`.
 */
export async function serveCachedM4a(
  cachePath: string,
  opts: ServeCachedM4aOpts,
): Promise<Response> {
  const buf = await fs.readFile(cachePath);
  const total = buf.length;

  const headers: Record<string, string> = {
    "Content-Type": "audio/mp4",
    "Cache-Control": opts.cacheControl ?? "public, max-age=86400",
    "Accept-Ranges": "bytes",
  };
  if (opts.noindex) {
    headers["X-Robots-Tag"] = "noindex";
  }
  if (opts.download) {
    headers["Content-Disposition"] = `attachment; filename="${toM4aName(opts.filename)}"`;
  }

  const range = parseRange(opts.rangeHeader, total);
  if (range) {
    const chunk = buf.subarray(range.start, range.end + 1);
    headers["Content-Range"] = `bytes ${range.start}-${range.end}/${total}`;
    headers["Content-Length"] = String(chunk.length);
    return new Response(chunk, { status: 206, headers });
  }

  headers["Content-Length"] = String(total);
  return new Response(buf, { status: 200, headers });
}
