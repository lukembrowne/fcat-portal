/**
 * Cron job authentication via Bearer token.
 *
 * API routes called by cron use this instead of user auth.
 * The CRON_SECRET env var is written to /etc/cron.d/portal-env
 * by docker-entrypoint.sh so cron jobs can pass it via curl.
 */

export function verifyCronSecret(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const header = request.headers.get("authorization");
  return header === `Bearer ${secret}`;
}
