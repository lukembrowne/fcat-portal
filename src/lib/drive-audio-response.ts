/**
 * Stream an audio recording straight from Google Drive as an HTTP response.
 *
 * Shared by `/api/audio/stream` (the recordings browser) and
 * `/api/audio/validation-clip?source=1` (the full minute behind a validation
 * clip), so there is one copy of the Range passthrough, the Content-Length
 * fallback and the Drive error mapping. Callers do their own auth first.
 *
 * NOT for anything iOS must play: Drive's `alt=media` ignores Range, and a
 * FLAC body is unplayable in mobile Safari. Downloads and desktop playback only.
 */

import "server-only";

import { NextResponse } from "next/server";

import { downloadFileAsStream } from "@/lib/drive-client";
import { log } from "@/lib/log";

export interface DriveAudioResponseOpts {
  driveFileId: string;
  /** Original filename, used for `Content-Disposition` when downloading. */
  filename: string;
  /** Stored MIME type; falls back to whatever Drive reports. */
  mimeType: string | null;
  /** Stored size, used when Drive omits Content-Length on a full response. */
  fileSize: number | null;
  rangeHeader?: string;
  download: boolean;
  cacheControl: string;
  /** Prefix for error logs, e.g. `[audio-stream]`. */
  logTag: string;
}

/** Quote-safe `Content-Disposition` value for an arbitrary filename. */
export function attachmentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export async function driveAudioResponse(
  opts: DriveAudioResponseOpts
): Promise<Response> {
  try {
    const result = await downloadFileAsStream(opts.driveFileId, opts.rangeHeader);

    const headers: Record<string, string> = {
      "Content-Type": opts.mimeType ?? result.contentType,
      "Cache-Control": opts.cacheControl,
      "Accept-Ranges": "bytes",
    };

    if (result.contentLength != null) {
      headers["Content-Length"] = String(result.contentLength);
    } else if (!opts.rangeHeader && opts.fileSize != null) {
      // Drive may omit Content-Length for chunked streams; without it the
      // browser can't determine audio duration. Use the DB file size instead.
      headers["Content-Length"] = String(opts.fileSize);
    }
    if (result.contentRange) {
      headers["Content-Range"] = result.contentRange;
    }
    if (opts.download) {
      headers["Content-Disposition"] = attachmentDisposition(opts.filename);
    }

    const status = result.contentRange ? 206 : 200;
    return new Response(result.stream as unknown as ReadableStream, {
      status,
      headers,
    });
  } catch (err) {
    log.error(
      { err, fileId: opts.driveFileId },
      `${opts.logTag} Failed to stream file`
    );
    const is404 =
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: number }).code === 404;
    return NextResponse.json(
      { error: is404 ? "Archivo no encontrado en Drive" : "Error de Drive API" },
      { status: is404 ? 404 : 502 }
    );
  }
}
