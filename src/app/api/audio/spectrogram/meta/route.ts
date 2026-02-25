/**
 * Spectrogram Metadata API
 *
 * Returns JSON metadata for a spectrogram (dimensions, frequency range, etc).
 * Also indicates whether the spectrogram is ready or still generating.
 *
 * GET /api/audio/spectrogram/meta?fileId=<audioFileId>
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { audioFiles, deployments } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { getUserCameraTrapProjects } from "@/lib/camera-trap-auth";
import {
  ensureAudioCached,
  ensureSpectrogramGenerated,
  type SpectrogramMetadata,
} from "@/lib/audio-cache";

export const dynamic = "force-dynamic";

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
    await ensureAudioCached(audioFileId);
    const { metadata } = await ensureSpectrogramGenerated(audioFileId);

    return NextResponse.json({
      ready: true,
      ...metadata,
    });
  } catch (err) {
    console.error(
      `[spectrogram-meta] Failed for file ${audioFileId}:`,
      err instanceof Error ? err.message : err
    );

    return NextResponse.json({
      ready: false,
      error: err instanceof Error ? err.message : "Error",
    });
  }
}
