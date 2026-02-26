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
import { downloadFileAsStream } from "@/lib/drive-client";

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
  const rangeHeader = request.headers.get("range") ?? undefined;

  try {
    const result = await downloadFileAsStream(fileId, rangeHeader);

    const headers: Record<string, string> = {
      "Content-Type": audioFile.mimeType ?? result.contentType,
      "Cache-Control": "public, max-age=31536000, immutable",
      "Accept-Ranges": "bytes",
    };

    if (result.contentLength != null) {
      headers["Content-Length"] = String(result.contentLength);
    } else if (!rangeHeader && audioFile.fileSize != null) {
      // Drive may omit Content-Length for chunked streams; without it the
      // browser can't determine audio duration. Use the DB file size as fallback.
      headers["Content-Length"] = String(audioFile.fileSize);
    }
    if (result.contentRange) {
      headers["Content-Range"] = result.contentRange;
    }
    if (download) {
      headers["Content-Disposition"] =
        `attachment; filename="${audioFile.filename}"`;
    }

    const status = result.contentRange ? 206 : 200;

    return new Response(result.stream as unknown as ReadableStream, {
      status,
      headers,
    });
  } catch (err) {
    console.error(
      `[audio-stream] Failed to stream file ${fileId}:`,
      err instanceof Error ? err.message : err
    );
    const is404 =
      err && typeof err === "object" && "code" in err && (err as { code: number }).code === 404;
    return NextResponse.json(
      { error: is404 ? "Archivo no encontrado en Drive" : "Error de Drive API" },
      { status: is404 ? 404 : 502 }
    );
  }
}
