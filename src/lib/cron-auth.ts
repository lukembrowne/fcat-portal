/**
 * Cron job authentication via Bearer token.
 *
 * API routes called by cron use this instead of user auth.
 * The CRON_SECRET env var is written to /etc/cron.d/portal-env
 * by docker-entrypoint.sh so cron jobs can pass it via curl.
 */

import { timingSafeEqual } from "crypto";

export function verifyCronSecret(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization");
  if (!header) return false;
  const expected = `Bearer ${secret}`;
  // Constant-time comparison to avoid leaking the secret via timing. Lengths
  // must match for timingSafeEqual; the length check itself is not secret.
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
