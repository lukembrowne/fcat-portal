import { NextRequest, NextResponse } from "next/server";
import { fetchAttachment } from "@/lib/odk-client";
import { getCurrentUser } from "@/lib/auth";

export async function GET(request: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = request.nextUrl;
  const projectId = searchParams.get("projectId");
  const formId = searchParams.get("formId");
  const id = searchParams.get("id");
  const file = searchParams.get("file");

  if (!projectId || !formId || !id || !file) {
    return NextResponse.json(
      { error: "Missing projectId, formId, id, or file parameter" },
      { status: 400 }
    );
  }

  try {
    const photoRes = await fetchAttachment(projectId, formId, id, file);
    const contentType =
      photoRes.headers.get("content-type") ?? "image/jpeg";
    const body = photoRes.body;

    if (!body) {
      return NextResponse.json({ error: "No photo data" }, { status: 404 });
    }

    return new NextResponse(body, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch photo" },
      { status: 500 }
    );
  }
}
