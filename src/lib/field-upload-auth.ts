/**
 * Auth + project allow-listing for the field-upload endpoint.
 *
 * This is a MACHINE endpoint (the field uploader desktop app), not a logged-in
 * user, so it uses a dedicated Bearer token instead of `requirePermission()` —
 * the same pattern as the cron routes (`verifyCronSecret`). The token is
 * separate from `CRON_SECRET` so the two blast radii don't overlap.
 */

import { timingSafeEqual } from "crypto";

/** Timing-safe Bearer check against `FIELD_UPLOAD_TOKEN`. */
export function verifyFieldUploadToken(request: Request): boolean {
  const secret = process.env.FIELD_UPLOAD_TOKEN;
  if (!secret) return false;
  const header = request.headers.get("authorization");
  if (!header) return false;
  const expected = `Bearer ${secret}`;
  // Constant-time comparison to avoid leaking the token via timing. Lengths must
  // match for timingSafeEqual; the length check itself is not secret.
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Allow-listed camera-trap project names (matches `ct_projects.name`). Project
 * names are data (created in the admin UI), so the list is env-configured rather
 * than a code literal — but the endpoint still REFUSES any project not on it, so
 * a leaked token can never enumerate other projects' drives.
 */
export function getAllowedProjects(): string[] {
  return (process.env.FIELD_UPLOAD_ALLOWED_PROJECTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isProjectAllowed(projectName: string): boolean {
  const allowed = getAllowedProjects();
  return allowed.length > 0 && allowed.includes(projectName);
}
