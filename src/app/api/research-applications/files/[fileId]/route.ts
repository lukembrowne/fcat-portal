import { NextResponse, type NextRequest } from "next/server";
import { requirePermission } from "@/lib/auth";
import {
  downloadFileToBuffer,
  getFileMetadata,
} from "@/lib/drive-client";
import { sanitizeFilename } from "@/lib/upload-validation";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ fileId: string }> }
) {
  await requirePermission("researcher-applications", "viewer");
  const { fileId } = await params;

  try {
    const [meta, buffer] = await Promise.all([
      getFileMetadata(fileId),
      downloadFileToBuffer(fileId),
    ]);

    const safeName = sanitizeFilename(meta.name);

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": meta.mimeType,
        "Content-Disposition": `attachment; filename="${safeName}"`,
        "Content-Length": buffer.length.toString(),
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "File not found" },
      { status: 404 }
    );
  }
}
