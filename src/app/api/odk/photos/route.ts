import { NextRequest, NextResponse } from "next/server";
import { fetchAttachment } from "@/lib/odk-client";
import { getCurrentUser } from "@/lib/auth";
import {
  GIZ_PROJECT_ID, GIZ_FORM_TREE_PLANTING, GIZ_FORM_CACAO_MONITORING,
  BIOCHOCO_PROJECT_ID, BIOCHOCO_FORM_DEPLOY, BIOCHOCO_FORM_RETRIEVE,
  BIOCHOCO_FORM_HABITAT,
  MONITOREO_PROJECT_ID, MONITOREO_FORM_SOCIAL_ACTIVITIES,
} from "@/lib/odk-constants";

// Map ODK project IDs to internal project IDs for permission checks
const ODK_PROJECT_MAP: Record<string, string> = {
  [GIZ_PROJECT_ID]: "giz",
  [BIOCHOCO_PROJECT_ID]: "biochoco",
  [MONITOREO_PROJECT_ID]: "monitoreo",
};

// Only allow known form IDs to prevent arbitrary ODK access
const ALLOWED_FORMS = new Set([
  GIZ_FORM_TREE_PLANTING,
  GIZ_FORM_CACAO_MONITORING,
  BIOCHOCO_FORM_DEPLOY,
  BIOCHOCO_FORM_RETRIEVE,
  BIOCHOCO_FORM_HABITAT,
  MONITOREO_FORM_SOCIAL_ACTIVITIES,
]);

// Validate that a parameter contains no path traversal characters
function isSafeParam(value: string): boolean {
  return !/[/\\]|\.\./.test(value);
}

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

  // Validate against allowlists
  const internalProject = ODK_PROJECT_MAP[projectId];
  if (!internalProject) {
    return NextResponse.json({ error: "Invalid projectId" }, { status: 400 });
  }

  if (!ALLOWED_FORMS.has(formId)) {
    return NextResponse.json({ error: "Invalid formId" }, { status: 400 });
  }

  // Path traversal protection
  if (!isSafeParam(id) || !isSafeParam(file)) {
    return NextResponse.json({ error: "Invalid parameter" }, { status: 400 });
  }

  // Project-level permission check
  const hasAccess =
    user.globalRole === "super_admin" ||
    user.permissions.some((p) => p.projectId === internalProject);
  if (!hasAccess) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  try {
    const photoRes = await fetchAttachment(projectId, formId, id, file);
    const contentType =
      photoRes.headers.get("content-type") ?? "image/jpeg";
    const body = photoRes.body;

    if (!body) {
      return NextResponse.json({ error: "No photo data" }, { status: 404 });
    }

    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=3600",
    };

    if (searchParams.get("download") === "true") {
      headers["Content-Disposition"] = `attachment; filename="${file}"`;
    }

    return new NextResponse(body, { headers });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch photo" },
      { status: 500 }
    );
  }
}
