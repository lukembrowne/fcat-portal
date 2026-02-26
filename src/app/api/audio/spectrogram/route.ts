/**
 * Spectrogram Image API
 *
 * Serves cached spectrogram PNGs for audio files.
 * Triggers download + generation on first request.
 *
 * GET /api/audio/spectrogram?fileId=<audioFileId>
 */

import { NextRequest, NextResponse } from "next/server";
import { promises as fs } from "fs";
import { db } from "@/db";
import { audioFiles, deployments } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { getUserCameraTrapProjects } from "@/lib/camera-trap-auth";
import { ensureAudioCached, ensureSpectrogramGenerated } from "@/lib/audio-cache";

export const dynamic = "force-dynamic";

// Formats that librosa can handle
const SUPPORTED_FORMATS = new Set(["wav", "flac", "mp3", "ogg"]);

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const hasAccess =
    user.globalRole === "super_admin" ||
    user.permissions.some((p) => p.projectId === "camera-trap");
  if (!hasAccess) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const fileId = request.nextUrl.searchParams.get("fileId");
  if (!fileId) {
    return NextResponse.json({ error: "Missing fileId" }, { status: 400 });
  }

  const audioFileId = parseInt(fileId, 10);
  if (isNaN(audioFileId)) {
    return NextResponse.json({ error: "Invalid fileId" }, { status: 400 });
  }

  // Look up audio file
  const [audioFile] = await db
    .select()
    .from(audioFiles)
    .where(eq(audioFiles.id, audioFileId));

  if (!audioFile) {
    return NextResponse.json(
      { error: "Archivo no encontrado" },
      { status: 404 }
    );
  }

  // Check format
  if (audioFile.format && !SUPPORTED_FORMATS.has(audioFile.format)) {
    return NextResponse.json(
      { error: "Formato no compatible para espectrogramas" },
      { status: 400 }
    );
  }

  // CT project-level access check
  const [deployment] = await db
    .select({ ctProjectId: deployments.cameraTrapProjectId })
    .from(deployments)
    .where(eq(deployments.id, audioFile.deploymentId));

  if (!deployment) {
    return NextResponse.json(
      { error: "Instalación no encontrada" },
      { status: 404 }
    );
  }

  const ctProjects = await getUserCameraTrapProjects(user);
  if (ctProjects !== "all") {
    if (
      deployment.ctProjectId == null ||
      !ctProjects.includes(deployment.ctProjectId)
    ) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  try {
    // Ensure audio is cached and spectrogram generated
    await ensureAudioCached(audioFileId);
    const { spectrogramPath } = await ensureSpectrogramGenerated(audioFileId);

    const data = await fs.readFile(spectrogramPath);

    return new Response(data, {
      status: 200,
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "public, max-age=31536000, immutable",
        "Content-Length": String(data.length),
      },
    });
  } catch (err) {
    console.error(
      `[spectrogram] Failed for file ${audioFileId}:`,
      err instanceof Error ? err.message : err
    );

    const message =
      err instanceof Error ? err.message : "Error generando espectrograma";

    // Check for specific error types
    if (message.includes("ML Python venv")) {
      return NextResponse.json(
        { error: "Entorno ML no disponible. Espere unos minutos." },
        { status: 503 }
      );
    }
    if (message.includes("no Drive file ID")) {
      return NextResponse.json(
        { error: "Archivo eliminado de Drive" },
        { status: 410 }
      );
    }

    return NextResponse.json({ error: message }, { status: 500 });
  }
}
