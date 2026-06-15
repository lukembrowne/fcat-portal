/**
 * Field-upload endpoint: hand the desktop app its Google service-account
 * credential ONCE at first run, so the long-lived key is never baked into the
 * distributed binary (the app encrypts it with safeStorage and stores it
 * locally; this endpoint lets us rotate centrally without an app release).
 *
 * Returns a DEDICATED field-upload SA (`FIELD_UPLOAD_SA_KEY`, base64 JSON),
 * separate from the portal's own `GOOGLE_SERVICE_ACCOUNT_KEY`. This SA must be
 * scoped to only the BioChoco drives (Content Manager member), with zero extra
 * IAM and no domain-wide delegation — it is full Drive read/write/delete (no
 * write-only scope exists), so every hit is audit-logged and rate-limited.
 *
 * Auth: dedicated Bearer `FIELD_UPLOAD_TOKEN` (timing-safe), like the cron routes.
 * See the deepened plan, Appendix B for the stronger short-lived-token variant.
 */

import { verifyFieldUploadToken } from "@/lib/field-upload-auth";
import { rateLimitAllow } from "@/lib/simple-rate-limit";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

function clientKey(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown"
  );
}

export async function GET(request: Request) {
  if (!verifyFieldUploadToken(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const key = clientKey(request);
  // Tighter limit than the deployment list — this hands out a real credential.
  if (!rateLimitAllow(`field-upload-cred:${key}`, 10)) {
    return Response.json({ error: "Too Many Requests" }, { status: 429 });
  }

  const raw = process.env.FIELD_UPLOAD_SA_KEY;
  if (!raw) {
    log.error("[field-upload] FIELD_UPLOAD_SA_KEY not configured");
    return Response.json({ error: "Credencial no configurada" }, { status: 503 });
  }

  let saJson: string;
  try {
    saJson = Buffer.from(raw, "base64").toString("utf-8");
    JSON.parse(saJson); // validate it's real JSON before handing it out
  } catch {
    log.error("[field-upload] FIELD_UPLOAD_SA_KEY is not valid base64 JSON");
    return Response.json({ error: "Credencial inválida" }, { status: 500 });
  }

  // Audit: warn-level so it surfaces as a notable event, not buried in info.
  log.warn({ key }, "[field-upload] service-account credential served");

  return new Response(saJson, {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
