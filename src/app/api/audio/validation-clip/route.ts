/**
 * Serves the pre-cut AAC clip for one validation sample.
 *
 *   GET /api/audio/validation-clip?sample=<birdnet_validation_samples.id>
 *   GET /api/audio/validation-clip?sample=N&download=1  → the clip as an attachment
 *   GET /api/audio/validation-clip?sample=N&source=1    → the WHOLE source
 *       recording, straight from Drive, under its original filename
 *
 * Returns `audio/mp4`, which plays in every desktop and mobile browser — unlike
 * the stored FLAC, which iOS Safari cannot decode at all. The `source=1` FLAC is
 * only ever downloaded, never played, so that limitation doesn't apply to it.
 *
 * Keyed by sample id so the review client never needs a Drive file id, and so
 * all three variants share one viewer + `requireDeploymentAccess` gate.
 *
 * Range support comes from the shared `serveCachedM4a`: iOS fires Range probes
 * on `<audio>` load and refuses a source that answers one with a 200 plus the
 * full body, which is the failure that made public FLAC clips unplayable.
 */

import { NextResponse, type NextRequest } from "next/server";

import { requirePermission } from "@/lib/auth";
import { requireDeploymentAccess } from "@/lib/camera-trap-auth";
import { ensureClipAudio } from "@/lib/birdnet-validation/clip-cache";
import { serveCachedM4a } from "@/lib/audio-serve";
import { driveAudioResponse } from "@/lib/drive-audio-response";
import { log } from "@/lib/log";
import { loadClipSource } from "../validation-clip-shared";
import { deploymentAccessFailure } from "../deployment-access-response";

export async function GET(request: NextRequest) {
  const user = await requirePermission("grabaciones", "viewer");

  const params = new URL(request.url).searchParams;
  const sampleId = Number(params.get("sample") ?? "");
  if (!Number.isInteger(sampleId) || sampleId <= 0) {
    return NextResponse.json({ error: "Muestra inválida" }, { status: 400 });
  }
  const download = params.get("download") === "1";
  const wantSource = params.get("source") === "1";

  const source = await loadClipSource(sampleId);
  if (!source) {
    return NextResponse.json({ error: "Muestra no encontrada" }, { status: 404 });
  }
  if (source.deploymentId != null) {
    const deploymentId = source.deploymentId;
    const denied = await deploymentAccessFailure(
      () => requireDeploymentAccess(user, deploymentId),
      "[validation-clip]",
      sampleId
    );
    if (denied) return denied;
  }

  if (wantSource) {
    return driveAudioResponse({
      driveFileId: source.driveFileId,
      filename: source.filename,
      mimeType: source.mimeType,
      fileSize: source.fileSize,
      rangeHeader: request.headers.get("range") ?? undefined,
      download: true,
      cacheControl: "private, max-age=3600",
      logTag: "[validation-clip:source]",
    });
  }

  try {
    const filePath = await ensureClipAudio(source);
    return await serveCachedM4a(filePath, {
      rangeHeader: request.headers.get("range") ?? undefined,
      download,
      filename: `validacion-${sampleId}.m4a`,
      // Private: these are internal review clips. Immutable because the cache
      // key is the sample id and a sample's window never changes once drawn.
      cacheControl: "private, max-age=31536000, immutable",
      noindex: true,
    });
  } catch (err) {
    log.error({ err, sampleId }, "[validation-clip] failed to produce clip");
    return NextResponse.json(
      { error: "No se pudo preparar el audio de esta detección" },
      { status: 500 }
    );
  }
}
