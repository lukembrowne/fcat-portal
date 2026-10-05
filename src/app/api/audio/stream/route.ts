/**
 * Audio File Streaming Proxy
 *
 * Streams audio files from Google Drive with:
 * - Auth via getCurrentUser() + camera-trap project permission
 * - CT project-level access check per deployment
 * - HTTP Range request passthrough for seeking
 * - Download mode via ?download=true
 *
 * Usage:
 *   /api/audio/stream?fileId=abc123           → stream audio
 *   /api/audio/stream?fileId=abc123&download=true → download with attachment header
 */

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { audioFiles, deployments } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getCurrentUser } from "@/lib/auth";
import { getUserCameraTrapProjects } from "@/lib/camera-trap-auth";
import { driveAudioResponse } from "@/lib/drive-audio-response";

export const dynamic = "force-dynamic";

function isSafeParam(value: string): boolean {
  return !/[/\\]|\.\./.test(value);
}

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const hasAccess =
    user.globalRole === "super_admin" ||
    user.permissions.some((p) => p.projectId === "grabaciones");
  if (!hasAccess) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = request.nextUrl;
  const fileId = searchParams.get("fileId");
  const download = searchParams.get("download") === "true";

  if (!fileId || !isSafeParam(fileId)) {
    return NextResponse.json({ error: "Invalid fileId" }, { status: 400 });
  }

  // Look up audio file in DB to get deployment for access check
  const [audioFile] = await db
    .select()
    .from(audioFiles)
    .where(eq(audioFiles.driveFileId, fileId));

  if (!audioFile) {
    return NextResponse.json(
      { error: "Archivo no encontrado" },
      { status: 404 }
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

  // Stream from Drive with Range support
  return driveAudioResponse({
    driveFileId: fileId,
    filename: audioFile.filename,
    mimeType: audioFile.mimeType,
    fileSize: audioFile.fileSize,
    rangeHeader: request.headers.get("range") ?? undefined,
    download,
    cacheControl: "public, max-age=31536000, immutable",
    logTag: "[audio-stream]",
  });
}
