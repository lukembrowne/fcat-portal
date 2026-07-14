---
date: 2026-07-14
topic: biochoco-public-report
---

# BioChoco Public Collaborator Report — Requirements

## Summary

Move the standalone BioChoco collaborator-recruiting report into the fcat-portal
as a public, bilingual (EN/ES) page under the existing `/public/*` route pattern.
The page shows curated camera-trap photos and audio plus live-derived stats, is
republished on demand from an admin control in the portal, and offers a
self-contained HTML/PDF download. It reuses the existing report's content and
build logic (~90%) rather than rebuilding, and rides on public-route
infrastructure that already exists.

## Problem Frame

The report today is a ~6 MB standalone HTML file, rebuilt from a separate
mini-repo (`~/apps/biochoco-report/`) and hand-delivered as an email attachment
or PDF. Three costs follow from that shape. It is **stale the moment it is sent** —
any refresh means re-pulling prod, rebuilding, and re-sending a new file to
everyone. It **can't carry audio well** — inline base64 audio bloats an already
heavy file, so the acoustic side of the project goes unshown. And it is
**invisible as a link** — the whole point of recruiting collaborators is sending
a URL they can open, forward, and cite, which an attachment can't be.

Separately, the portal is trending toward more public surface (two prior public
brainstorms, an existing public layout and route carve-out). A public recruiting
page is a natural first real instance of that direction, so building it in-portal
compounds rather than creates one-off infrastructure.

## Key Decisions

- **Cached/static rendering, not per-request.** The page is generated at
  publish time and served as cached output, so the database is never exposed to
  the public internet. "Live" means current-to-last-publish, which is right for
  recruiting stats that move slowly. This preserves the safety of the current
  static file while removing the re-send friction.

- **In the portal repo, not the separate mini-repo.** The report becomes a page
  in fcat-portal under `/public/*`. One deploy, one codebase, and it establishes
  the reusable public-page pattern the portal is heading toward. The mini-repo's
  `template.html` content and curation data (`habitat-map.json`, reserve
  boundary) migrate in; its role as a *host* is retired. No prior work is lost.

- **Curated media over an auto-gallery.** A curation manifest (same shape as the
  existing `habitat-map.json`) lists the showcase photos and audio clips, so a
  human picks what goes public. This gives editorial strength and — critically on
  a public page — keeps landowner names and sensitive coordinates out by default.

- **Bilingual via page-local content blocks, no i18n library.** Content is stored
  as parallel `en`/`es` blocks with a language toggle, matching the portal's
  hardcoded-strings convention. Claude drafts the Spanish; FCAT staff review and
  correct before publish. Both languages ship together.

- **Reuse the existing public-route carve-out.** `/public/*` and `/api/public/*`
  already bypass auth at nginx and in `proxy.ts`, and a public layout already
  exists. The report is a new page inside that pattern, not new infrastructure.

## Requirements

**Content and reuse**

- R1. The page reproduces the current report's sections and narrative, sourced
  from `~/apps/biochoco-report/template.html`, migrated into portal components.
- R2. Stats are derived from the production database using the existing
  extraction logic (`extract.mjs`), scoped to BioChoco (`ct_projects.id = 1`,
  excluding soft-deleted deployments), preserving the honest-number rules
  (real-species filter, retrieved-only deployment counts, audio-as-candidates).
- R3. The page renders under the existing `/public/*` pattern at a tokenless
  slug distinct from the existing token-gated `/public/biochoco/[token]/` site
  galleries.

**Bilingual**

- R4. All report copy exists in both English and Spanish as parallel content
  blocks, switchable by an on-page language toggle, with no i18n library.
- R5. Either language can be edited independently without touching the other.

**Media and curation**

- R6. Camera-trap photos and audio clips shown on the page are drawn from a
  human-maintained curation manifest, not auto-selected.
- R7. Curated media is delivered without requiring authentication — bundled into
  the published output by default, or served via an `/api/public/*` route if
  bundle size warrants (planning decides which).
- R8. Audio clips are playable inline on the page.

**Publishing**

- R9. An authenticated admin control in the portal regenerates and publishes the
  page (re-pull stats, rebuild, swap the cached output) in one action.
- R10. Publishing records a system event, consistent with the portal's
  instrumentation policy for admin-facing mutations.

**Public delivery and privacy**

- R11. The published page is reachable with no login and no token.
- R12. Public output strips landowner names to site codes and omits or coarsens
  sensitive coordinates.
- R13. The auth carve-out exposes only the report's public path and does not make
  the internal auth-gated `/biochoco` module (or any other internal route)
  reachable without login.

**Download**

- R14. Visitors can download a self-contained artifact of what they see — a
  single HTML file (media inlined) and/or a print-to-PDF path — in the currently
  selected language.

## Acceptance Examples

- AE1. **Covers R11, R13.** An anonymous visitor opens the report URL and sees
  the full page. The same visitor opening `/biochoco` (internal module) is
  challenged for login.
- AE2. **Covers R9.** An admin clicks "Regenerate & publish"; after it completes,
  the public page reflects the latest prod stats without a code deploy.
- AE3. **Covers R4.** A visitor toggles to Spanish; all copy, captions, and stat
  labels switch; media and layout are unchanged.
- AE4. **Covers R12.** A curated photo from site `CCN-001 - Don Adrian` appears
  on the public page labeled `CCN-001`, with no landowner name and no precise
  location exposed in markup or metadata.
- AE5. **Covers R14.** A visitor downloads the self-contained HTML in Spanish and
  opens it offline; copy is Spanish, curated media renders, no network calls.

## Scope Boundaries

**Deferred for later**

- Per-visit-fresh data straight from the database (the republish model is
  deliberate; revisit only if freshness becomes a real audience need).
- An auto-generated, self-refreshing media gallery.
- A portal-wide i18n system — the toggle is page-local for this one page.
- EDI dataset links / DOI citation section (an established public-dashboard
  convention worth adding later, not required for v1).

**Outside this scope**

- Changing or extending the token-gated `/public/biochoco/[token]/` landowner
  galleries — a separate feature that only shares a URL prefix.

## Dependencies / Assumptions

- **Existing public-route infrastructure (verified present).** nginx serves
  `/public/` and `/api/public/` without auth, rate-limited
  (`nginx/portal.fcat-ecuador.org:68`); `src/proxy.ts` excludes both; a public
  shell exists at `src/app/public/layout.tsx`. The report reuses this; no new
  carve-out is required.
- **Public hostname and final slug.** Whether the report lives at a subpath
  under the portal host or a dedicated public subdomain, and the exact slug, is
  an open naming/infra choice for planning (assumption: subpath under the
  existing `/public/*` segment, since the carve-out is already there).
- **Media source pipeline.** Curated photos come from camera-trap detections and
  audio from the audio module; the mechanism to export curated assets into the
  published output is a planning concern.
- **Spanish review capacity.** Bilingual ship assumes an FCAT reviewer corrects
  the drafted Spanish before publish.

## Outstanding Questions

**Resolve before planning**

- Final public slug for the report (must not collide with
  `/public/biochoco/[token]/`); subpath vs dedicated subdomain.

**Deferred to planning**

- Bundle-vs-`/api/public/`-route decision for serving curated media (R7).
- Where the curation manifest lives and how assets are exported at publish time.
- Download mechanism: retain the mini-repo `build.mjs` inline-everything step, or
  generate the self-contained file from the portal route.
- Whether to add the report to a public "Público" sidebar section / dashboard
  registry now or later.

## Sources / Research

- `~/apps/biochoco-report/` — existing report repo: `template.html` (content),
  `extract.mjs` (prod stats pull), `build.mjs`, `data/habitat-map.json`,
  `data/reserve.geojson`. Primary reuse source.
- `docs/brainstorms/2026-02-28-public-pages-brainstorm.md` — established the
  `/public/*` path-prefix carve-out and three-layer bypass.
- `docs/brainstorms/2026-03-09-public-dashboards-brainstorm.md` — public
  dashboard pattern, "Público" sidebar, dashboard registry, EDI/Umami
  conventions the report should align with.
- `src/app/public/layout.tsx`, `src/app/public/biochoco/[token]/`,
  `src/app/public/share/[token]/` — existing public pages proving the pattern;
  the `[token]` biochoco site is the adjacent, distinct feature to avoid.
- `nginx/portal.fcat-ecuador.org:68` — public/no-auth location blocks and rate
  limits.
- `src/proxy.ts` — matcher excludes `public/` and `api/public/`.
