/**
 * Auth Middleware — Edge Runtime
 *
 * IMPORTANT: This runs in Edge runtime. NO DB imports, NO Node.js-only modules.
 * Only forwards the authenticated email from oauth2-proxy headers (or dev env var).
 */

import { NextResponse, type NextRequest } from "next/server";

export function middleware(request: NextRequest) {
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
    // Match all paths except static files and API routes
    "/((?!_next/static|_next/image|api/|favicon.ico).*)",
  ],
};
