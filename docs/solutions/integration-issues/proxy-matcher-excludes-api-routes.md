---
title: "API Routes Not Receiving Auth Headers Due to Proxy Matcher Exclusion"
type: gotcha
date: 2026-02-09
category: integration-issues
tags: [authentication, proxy, api-routes, headers, nextjs-16]
module: auth
symptoms:
  - "API routes return 401 Unauthorized for authenticated users"
  - "getCurrentUser() returns null in /api/* handlers"
  - "Client-side <img> tags show 'Error cargando' for ODK photos"
  - "x-user-email header missing in API route handlers"
root_cause: "Proxy matcher pattern excluded api/ routes, preventing auth header injection"
severity: high
time_to_fix: 5 minutes
related:
  - nextjs16-middleware-to-proxy-migration.md
---

# API Routes Not Receiving Auth Headers Due to Proxy Matcher Exclusion

## Problem

Photos in the GIZ tree planting dashboard showed "Error cargando" for all three photo types. The `<img>` tags fetched `/api/odk/photos?projectId=2&formId=siembra_arboles&id=...&file=...` but got **401 Unauthorized**, even though the user was authenticated and other pages loaded fine.

## Investigation

1. ODK Central credentials confirmed working — page data loaded correctly
2. `curl` to the photo API returned 401 (no auth header present)
3. `getCurrentUser()` reads the `x-user-email` header set by `proxy.ts`
4. The proxy matcher pattern was:
   ```
   "/((?!_next/static|_next/image|api/|favicon.ico).*)"
   ```
5. The `api/|` in the negative lookahead **excluded all API routes** from the proxy

## Root Cause

The proxy matcher excluded API routes so they wouldn't go through the auth proxy. This was a leftover from initial scaffolding. When the `/api/odk/photos` route was added with `getCurrentUser()` for auth, it relied on the `x-user-email` header that only the proxy injects.

Browser `<img src="/api/odk/photos?...">` requests are normal HTTP GETs. They hit the proxy matcher, which saw `/api/` and skipped the proxy entirely. No header was injected → `getCurrentUser()` returned null → 401.

Page routes (like `/giz/tree-planting`) worked fine because they were NOT excluded from the proxy matcher.

## Solution

Remove `api/|` from the proxy matcher exclusion in `src/proxy.ts`:

**Before:**
```typescript
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|api/|favicon.ico).*)",
  ],
};
```

**After:**
```typescript
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
```

## Why This Is Subtle

- Page routes worked → auth seemed fine
- Server Actions worked → they run in the page context which has the header
- Only client-initiated requests to API routes failed (like `<img>`, `fetch()` from client components)
- The 401 was silently caught by `<img onError>`, showing a generic "Error cargando" message

## Prevention

- **Rule**: If any API route uses `getCurrentUser()`, the proxy must cover API routes
- **Simpler default**: Include all routes in the proxy. Only exclude static assets (`_next/static`, `_next/image`, `favicon.ico`)
- **Alternative**: API routes could implement their own auth (e.g., read cookies directly) instead of relying on proxy headers — but this duplicates logic
