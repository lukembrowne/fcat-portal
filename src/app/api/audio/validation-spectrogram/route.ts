/**
 * Serves the pre-rendered spectrogram for one validation sample.
 *
 *   GET /api/audio/validation-spectrogram?sample=<birdnet_validation_samples.id>
 *
 * A static image of the whole clip lets the reviewer read the call's shape
 * before pressing play. The live Web Audio canvas used elsewhere in the portal
 * cannot do that — it only paints as the audio plays, so judging a call would
 * cost a full playback every time.
 */

import { NextResponse, type NextRequest } from "next/server";
import { promises as fs } from "node:fs";

import { requirePermission } from "@/lib/auth";
import { requireDeploymentAccess } from "@/lib/camera-trap-auth";
import { ensureClipSpectrogram } from "@/lib/birdnet-validation/clip-cache";
import { log } from "@/lib/log";
import { loadClipSource } from "../validation-clip-shared";

export async function GET(request: NextRequest) {
  const user = await requirePermission("grabaciones", "viewer");

  const sampleId = Number(new URL(request.url).searchParams.get("sample") ?? "");
  if (!Number.isInteger(sampleId) || sampleId <= 0) {
    return NextResponse.json({ error: "Muestra inválida" }, { status: 400 });
  }

  const source = await loadClipSource(sampleId);
  if (!source) {
    return NextResponse.json({ error: "Muestra no encontrada" }, { status: 404 });
  }
  if (source.deploymentId != null) {
    await requireDeploymentAccess(user, source.deploymentId);
  }

  try {
    const filePath = await ensureClipSpectrogram(source);
    const data = await fs.readFile(filePath);
    return new NextResponse(new Uint8Array(data), {
      status: 200,
      headers: {
        "Content-Type": "image/webp",
        "Content-Length": String(data.byteLength),
        "Cache-Control": "private, max-age=31536000, immutable",
        "X-Robots-Tag": "noindex",
      },
    });
  } catch (err) {
    log.error({ err, sampleId }, "[validation-spectrogram] render failed");
    return NextResponse.json(
      { error: "No se pudo generar el espectrograma" },
      { status: 500 }
    );
  }
}
