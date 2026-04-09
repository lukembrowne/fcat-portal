---
title: Biochoco Site Results Public Sharing
date: 2026-04-09
status: Brainstorm complete
supersedes_scope_of: docs/brainstorms/2026-02-28-public-pages-brainstorm.md
related_plan: docs/plans/2026-02-28-feat-public-pages-landowner-share-links-plan.md
---

# Biochoco Site Results — Landowner Share Links

## What We're Building

A WhatsApp-friendly public share link for the biochoco per-site results page (e.g. `/biochoco/resultados/NAC-005`) so FCAT staff can send each landowner a read-only link to the monitoring results from their farm. The public view aggregates camera trap, habitat, and temperature data across all deployments at that site, and lets landowners browse every captured image on their phone and save pictures to share.

This **retargets** the prior share-link plan (which was scoped to a single camera-trap deployment) to the biochoco **site** level, because a site aggregates the multiple CT deployments, ARU stations, iButton loggers, and habitat assessments that a landowner cares about together.

## Why This Approach

The `/public/*` infrastructure already exists from the 2026-02-28 plan:
- nginx `location /public/` bypass (no `auth_request`)
- `src/proxy.ts` matcher excludes `public` and `api/public`
- `src/app/public/layout.tsx` (logo-only standalone layout)
- `share_tokens` DB table
- `/api/public/ct-images/[token]/[id]` thumbnail API tied to a deployment

We reuse all of that. The changes are:
1. **Generalize `share_tokens`** to point at either a site code or a deployment (or add a `biochoco_site_id` column alongside the existing `deployment_id`, whichever is smaller).
2. **New public route**: `src/app/public/biochoco/[siteId]/[token]/page.tsx` (or `/public/share/site/[token]`).
3. **New public image API** that validates token → site → owns all of that site's deployments' images.
4. **Share button** moves to the biochoco site detail page, visible to biochoco editors+.
5. **Redesign the site detail UI** so the same components work for both the internal page and the public page, with compact cards and Fauna-above-Hábitat order.

## Key Decisions

1. **One active share link per site.** Revoking replaces the link. Simpler than tracking multiple labeled links. Uses site code (`NAC-005`) as the natural key; token remains the secret.

2. **Fauna above Hábitat, Audio removed.** New section order on the public (and internal) page:
   1. Compact header + compact stat cards (see #6)
   2. Fauna (species cards + image gallery)
   3. Hábitat
   4. Temperatura
   5. ~~Audio~~ (hidden in v1 — no annotations yet; revisit later)

3. **Image browsing: top 20 per species, "ver todas" expands.** Mobile-first: light initial payload for WhatsApp in-app browser, then full browse on demand with paginated "Cargar más" (50/page). Applies to both internal and public views.

4. **Save-to-phone.** Each image in the gallery gets a download button that hits the public image API with `?download=true`, sending `Content-Disposition: attachment` with a filename like `FCAT-NAC-005-Puma-2026-03-14.jpg`. Reuse the existing `PhotoDownloadButton` pattern from `src/components/photo-download-button.tsx`. **Full-size download, not just thumbnail** — this is the one place we relax the "thumbnails only" rule from the prior plan, because the whole point is letting landowners share pictures with friends.

5. **Privacy on the public view:**
   - Hide GPS coordinates (text)
   - Hide site name if it encodes location; show site code (`NAC-005`) only
   - **Keep** temperature data and the small location map (landowner already knows where their farm is)
   - No Drive links, no raw file paths, no QA notes, no user emails
   - No coordinates on EXIF of downloaded images (strip on serve, or confirm the thumbnail pipeline already does)

6. **Compact stat cards at top.** Match the denser card style used elsewhere in the app (e.g. finance/climate dashboards). Current cards use `pt-4 pb-4` with large 2xl numbers — shrink to inline rows (icon + label + value) in a single compact row across the header.

7. **Mobile-first layout.** The current `site-detail-shell.tsx` is already responsive but was designed for desktop-first. Public view should be tested in WhatsApp's in-app browser on both iOS and Android. Species cards → single column on mobile; image grid → 2 columns on mobile, 3-4 on tablet, 4-5 on desktop.

8. **OG meta tags for WhatsApp previews.** `generateMetadata()` returns site code + top-3 species names + image count, so the link preview is enticing. Use a generated OG image (first camera trap image or a composite) if feasible; otherwise static FCAT branding.

9. **Share UI lives on the internal site detail page.** A "Compartir" button in the header of `/biochoco/resultados/[siteId]`, visible to biochoco editors+. Opens a popover with: copy-link, WhatsApp-prefilled-message, revoke. Similar to `docs/plans/2026-02-28-feat-public-pages-landowner-share-links-plan.md` Phase 6 but on biochoco instead of camera-trap.

10. **Reuse not fork.** The internal `SiteDetailShell` and the public page should render from the same components, gated by an `isPublic` prop that hides coordinates, admin actions, and QA notes. This avoids drift. The page.tsx wrappers differ (one calls `requirePermission("biochoco", "viewer")`, one validates a share token), but the UI tree is shared.

## Open Questions

- **Location map on public view.** The small `SiteLocationMap` reveals coordinates visually even if we hide the text. Acceptable because landowners already know? Or swap to a zoomed-out regional map (Ecuador + a dot at province level) for the public view?
- **Image count per site.** A typical NAC-* site has how many CT images total? If it's tens of thousands, the "ver todas" path needs careful pagination to not DoS the thumbnail cache. (Worth measuring on NAC-005 before building.)
- **Multi-deployment attribution.** A site has multiple CT visits over time. On the public view, do we show species aggregated across all deployments (simpler) or broken out by visit date (more informative but more UI)? Suggest: aggregate in v1, add a "Historial de visitas" collapsible section later.
- **Downloaded filename format.** `FCAT-NAC-005-Puma-2026-03-14.jpg` is my guess — confirm with staff what's useful.
- **Analytics.** Should we log each public page view (IP, user agent, timestamp) to detect leaks or measure engagement? Prior plan said no; might reconsider now that this is site-level.
- **What about iButton temperature & habitat photos?** Habitat assessments include field photos — do we show those on the public page? They're less sensitive than CT but have the same download-to-phone appeal.

## Implementation Sketch (for the plan phase)

1. **DB schema** — either add `biochoco_site_id TEXT` to `share_tokens` with a check constraint (exactly one of `deployment_id` / `biochoco_site_id` set), or create a new `site_share_tokens` table. Prefer the former for UI simplicity.
2. **Server actions** — `createSiteShareLink(siteId)`, `revokeSiteShareLink(siteId)`, `getSiteShareLink(siteId)` in `src/app/biochoco/resultados/actions.ts`. Call `requirePermission("biochoco", "editor")`.
3. **Public page** — `src/app/public/biochoco/[siteId]/[token]/page.tsx`. Validate token → site match, fetch the same data as the internal page via `fetchSiteDetail(siteId)`, render `SiteDetailShell` with `isPublic`.
4. **Public image API** — `src/app/api/public/biochoco-images/[token]/[imageId]/route.ts`. Validate token, verify image belongs to a deployment at this site, serve thumb or full-size with optional `?download=true`.
5. **Refactor `SiteDetailShell`** — reorder sections (Fauna before Hábitat), drop Audio, compact the top cards, add `isPublic` prop.
6. **Species image gallery** — extend `SpeciesCards` / new component to show top-20 + expand to paginated full list, with download button per image, mobile-friendly grid.
7. **Share UI** — "Compartir" button + popover in `site-detail-shell.tsx`, editors+ only, with copy-link and WhatsApp prefill (`https://wa.me/?text=<encoded url>`).
8. **OG metadata** — `generateMetadata()` on the public page.

## Reference

- Prior brainstorm: `docs/brainstorms/2026-02-28-public-pages-brainstorm.md`
- Prior plan (infrastructure we reuse): `docs/plans/2026-02-28-feat-public-pages-landowner-share-links-plan.md`
- Current internal page: `src/app/biochoco/resultados/[siteId]/site-detail-shell.tsx`
- Public layout: `src/app/public/layout.tsx`
- Existing share routes: `src/app/public/share/[token]/`, `src/app/api/public/ct-images/`
- Photo download component: `src/components/photo-download-button.tsx`
