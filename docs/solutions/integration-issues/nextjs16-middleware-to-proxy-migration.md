---
title: "Next.js 16: middleware.ts Renamed to proxy.ts"
type: gotcha
date: 2026-02-08
category: integration-issues
tags: [nextjs, middleware, proxy, nextjs-16, migration]
module: auth
symptoms: ["The middleware file convention is deprecated. Please use proxy instead.", "⚠ middleware.ts deprecation warning in dev console"]
---

# Next.js 16: middleware.ts Renamed to proxy.ts

## Problem

After scaffolding a new Next.js 16 project with `create-next-app`, creating `src/middleware.ts` produces a deprecation warning on every request:

```
⚠ The "middleware" file convention is deprecated. Please use "proxy" instead.
```

The app still works, but the convention will be removed in a future version.

## Root Cause

Next.js 16 renamed the `middleware.ts` file convention to `proxy.ts`. The reasons:

1. **Naming clarity**: "middleware" was confused with Express.js middleware. "proxy" better describes its role — a network boundary in front of the app.
2. **Runtime change**: `proxy.ts` runs in **Node.js runtime** by default (not Edge runtime). This is a significant improvement for use cases that need Node.js APIs.

## Solution

### 1. Rename the file

```bash
mv src/middleware.ts src/proxy.ts
```

### 2. Rename the exported function

```typescript
// Before (middleware.ts)
export function middleware(request: NextRequest) { ... }

// After (proxy.ts)
export function proxy(request: NextRequest) { ... }
```

### 3. Update config flag names (if used)

```typescript
// Before
export const config = {
  skipMiddlewareUrlNormalize: true,
};

// After
export const config = {
  skipProxyUrlNormalize: true,
};
```

### 4. Alternative: Use the codemod

```bash
npx @next/codemod@canary middleware-to-proxy .
```

## Key Differences

| Aspect | middleware.ts (deprecated) | proxy.ts (current) |
|--------|--------------------------|-------------------|
| Runtime | Edge (default) | Node.js (default) |
| Function name | `middleware()` | `proxy()` |
| Config flags | `skipMiddlewareUrlNormalize` | `skipProxyUrlNormalize` |

## Impact on Auth Pattern

For the `X-Forwarded-Email` header forwarding pattern used in this project, the migration is straightforward:

```typescript
// src/proxy.ts
import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  const email =
    request.headers.get("x-forwarded-email") ||
    process.env.DEV_USER_EMAIL ||
    null;

  if (!email) {
    return new NextResponse("No autorizado", { status: 401 });
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-user-email", email.toLowerCase().trim());

  return NextResponse.next({
    request: { headers: requestHeaders },
  });
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|api/|favicon.ico).*)",
  ],
};
```

The Node.js runtime is actually **better** for this use case — no Edge runtime limitations.

## Prevention

- When starting new Next.js 16+ projects, use `proxy.ts` from the start
- When upgrading from Next.js 15, run the codemod as part of the upgrade
- If you need Edge runtime specifically, you can still use `middleware.ts` (for now), but it's deprecated

## References

- [Next.js docs: Renaming Middleware to Proxy](https://nextjs.org/docs/messages/middleware-to-proxy)
- [Next.js docs: proxy.ts file convention](https://nextjs.org/docs/app/api-reference/file-conventions/proxy)
- [Next.js 16 upgrade guide](https://nextjs.org/docs/app/guides/upgrading/version-16)
