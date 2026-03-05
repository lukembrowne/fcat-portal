# Public Pages & Landowner Sharing

**Date:** 2026-02-28
**Status:** Brainstorm complete

## What We're Building

Two public-facing capabilities for the FCAT Portal:

1. **Public dashboard** — An unauthenticated page (e.g., `/public/dashboard`) showing aggregate camera trap data, species stats, or project highlights. Exact content TBD.

2. **Landowner share links** — Token-based URLs that let landowners view camera trap footage from their specific farm/deployment without needing a Google account or FCAT login. Example: `/public/share/abc123def456`

## Why This Approach

**Approach chosen: Public path prefix + share tokens**

The portal currently has triple-layered auth (nginx `auth_request` → oauth2-proxy → proxy.ts). Every request goes through all three layers. There is no existing public route infrastructure.

We chose the "public path prefix" approach over alternatives because:

- **Simpler than a separate subdomain** — no new DNS, TLS certs, or nginx server blocks
- **More flexible than oauth2-proxy `SKIP_AUTH_ROUTES`** — share tokens add a security layer beyond just "path is public"
- **Landowners often don't have Google accounts** — oauth2-proxy (Google OAuth) won't work for them
- **Moderate sensitivity** — some species location data could enable poaching if widely leaked, so links need to be hard to guess and revocable, but don't need maximum security

## Key Decisions

1. **Public path prefix**: All public routes live under `/public/*`. This path bypasses oauth2-proxy at the nginx layer and is excluded from proxy.ts email checks.

2. **Share tokens for landowner links**: Cryptographically random tokens stored in a `share_tokens` DB table. Each token maps to a specific deployment. Tokens can be revoked but don't expire by default.

3. **Who can create share links**: Camera-trap editors and admins (not viewers).

4. **No expiration by default**: Links stay active until manually revoked. Keeps maintenance low for landowners who revisit infrequently.

5. **Three-layer bypass for `/public/*`**:
   - **nginx**: New `location /public/` block WITHOUT `auth_request` directive, proxying directly to Next.js
   - **proxy.ts**: Add `/public/` to matcher exclusion list (or handle gracefully when no email header present)
   - **Route handlers**: Token validation at the application level (no `requirePermission()` — validate token instead)

6. **Image serving**: Public share pages need a way to serve camera trap images without auth. Either a new `/api/public/ct-images/` route or token-based query param on existing route.

## Open Questions

- **Public dashboard content**: What data to show? Aggregate stats only, or curated images too? This can be decided later — the infrastructure change (making `/public/*` work) is the same regardless.
- **Share link UI**: Where does the "share" button live? Deployment detail page? Results page?
- **Landowner notification**: How do landowners receive the link? Email from the app, or manually shared by staff?
- **Rate limiting**: Should public routes have stricter rate limiting to prevent abuse?
- **Image caching**: Current CT images use `max-age=31536000, immutable`. If a share link is revoked, cached images persist in the landowner's browser. Acceptable?
- **Scope of sharing**: Share a single deployment, or a group of deployments (all deployments on a farm)?
- **Landowner feedback**: Should landowners be able to leave comments or flag images, or is this view-only?

## Implementation Sketch (for planning phase)

The work breaks down into:

1. **Infrastructure**: nginx config change + proxy.ts change to allow `/public/*` unauthenticated
2. **Database**: `share_tokens` table (token, deployment_id, created_by, created_at, revoked_at)
3. **Share link management**: Server actions to create/revoke tokens, UI on deployment page
4. **Public share page**: `/public/share/[token]` showing deployment images + species detections
5. **Public image API**: Route to serve images validated against share token instead of user session
6. **Public dashboard**: `/public/dashboard` with aggregate data (can be built independently)
