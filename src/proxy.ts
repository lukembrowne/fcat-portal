/**
 * Auth Proxy — Node.js Runtime
 *
 * Runs before routes are rendered. Forwards the authenticated email
 * from oauth2-proxy headers (or DEV_USER_EMAIL env var in dev).
 *
 * Next.js 16 renamed middleware.ts → proxy.ts.
 * This runs in Node.js runtime (not Edge).
 */

import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  // In production, oauth2-proxy sets X-Forwarded-Email
  // In dev, use DEV_USER_EMAIL env var
  const email =
    request.headers.get("x-forwarded-email") ||
    process.env.DEV_USER_EMAIL ||
    null;

  if (!email) {
    // No authenticated user — return 401
    return new NextResponse("No autorizado", { status: 401 });
  }

  // Forward email as a request header for downstream use
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-user-email", email.toLowerCase().trim());

  return NextResponse.next({
    request: { headers: requestHeaders },
  });
}

export const config = {
  matcher: [
    // Match all paths except static files
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
