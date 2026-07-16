---
title: "feat: Páginas Públicas section + mobile-first landowner page redesign"
type: feat
date: 2026-07-16
status: ready
origin: docs/plans/2026-07-15-006-feat-landowner-page-builder-plan.md
design_spike: https://claude.ai/code/artifact/adc655a2-f457-4828-9cd8-71f747b8a530
---

# feat: Páginas Públicas section + mobile-first landowner page redesign

## Summary

Public-facing landowner pages are currently edited from inside **Resultados → click a site → internal detail view**, where the builder is buried next to internal-only panels and the layout looks nothing like what the landowner sees. This plan pulls all public-facing work into its own **"Página pública"** nav group, introduces a **sortable status table** of finca pages (published / viewed / needs work — no raw share links shown inline, to prevent copying the wrong one), moves the builder to a **dedicated route with live preview**, adds **lightweight view tracking**, and **rebuilds the public landowner page** as a mobile-first, social-style experience matching the approved design spike.

The already-shipped page-config model (`src/lib/landowner/page-config.ts`), token-gated media routes, and resolved content blocks are **reused as-is** — this plan is IA + a new table + a redesign, not a rework of the data layer.

---

## Problem Frame

Three distinct problems, all rooted in the same IA mistake (public work living inside the internal Resultados detail):

1. **Discoverability & confusion.** The team reaches the page builder through the internal results view. That view mixes internal panels (acoustic indices, BirdNET review) with the public builder, and its layout differs from the public page — so it's easy to conflate "what the team sees" with "what's public." The nav's existing "Página pública" item points at the *divulgation overview report* admin, not the per-site pages, compounding the confusion.
2. **No overview of progress.** There is no place to see which fincas have a published page, which were opened by the landowner, and which still need work. Each site must be visited individually.
3. **Desktop-first public page.** The current public page (`public-site-shell.tsx`) is a vertical stack of internal-style components. Landowners open it on a phone via WhatsApp; it should feel like a mobile story they want to swipe through and share, not a report.

---

## Scope Boundaries

**In scope**
- New **"Página pública"** nav group with two children: *Páginas de fincas* (biochoco editors+) and *Resumen divulgativo* (super-admin only, the existing `/admin/biochoco-overview`).
- New route `/biochoco/paginas-publicas` — a sortable status table of all biochoco sites.
- Dedicated builder route `/biochoco/paginas-publicas/[siteId]` hosting the existing `PageBuilder` + live preview + share controls.
- Lightweight view tracking (`first_viewed_at`, `last_viewed_at`, `view_count`) on `site_share_tokens`.
- Mobile-first redesign of `public-site-shell.tsx` matching the design spike, including a swipeable species carousel and IUCN status chips.

**Out of scope (non-goals)**
- The internal Resultados dashboard's own content/panels — untouched except for removing the now-relocated builder/share controls from the site detail.
- The divulgation overview report itself (`/admin/biochoco-overview`) — only its nav placement changes.
- The page-config model, parser, backfill, and token-gated media routes — reused unchanged.
- Video hosting / IUCN backfill pipeline — separate initiatives (the `iucn_status` column already exists; this plan only *reads* it).

### Deferred to Follow-Up Work
- Per-visitor / per-section analytics (this plan does token-level counts only).
- Notifying the team when a landowner first opens their page.
- Bulk actions on the pages table (publish-all, etc.).

---

## Key Technical Decisions

### KTD-1 — Nav becomes a grouped "Página pública" section
Replace the single super-admin `Página pública` link with a **parent nav group** whose children render conditionally:
- **Páginas de fincas** → `/biochoco/paginas-publicas` — visible to biochoco **editors and admins** (and super-admin).
- **Resumen divulgativo** → `/admin/biochoco-overview` — visible to **super-admin only** (unchanged gating).

Gating uses the same `isBiochocoEditor`-style predicate already computed in `src/components/sidebar-nav.tsx` for other editor-only items. The group header shows if the user can see *either* child.

### KTD-2 — Page status is derived, not stored
A finca's status is computed from existing data, never persisted (avoids drift):

| Status | Condition | Pill |
|--------|-----------|------|
| **Sin empezar** | No active (`revokedAt IS NULL`) share token | neutral/grey |
| **Publicado** | Active token, `last_viewed_at` null | blue/moss |
| **Visto** | Active token, `last_viewed_at` set | green + "hace N días" |

A secondary **"Personalizada"** badge shows when `pageConfig IS NOT NULL` (the team curated blocks beyond the default). Derivation lives in a pure helper (`deriveSitePageStatus`) so it is unit-testable without a DB.

### KTD-3 — View tracking is a fire-and-forget write, outside the cached fetch
`fetchSiteDetailByToken` is wrapped in React `cache()` and is called **twice** per request (once in `generateMetadata`, once in the page). It must stay side-effect free. View tracking is a **separate** action (`recordSiteView(token)`) invoked once from the page component body only (not `generateMetadata`, not inside the cached fetch), updating `last_viewed_at = now`, `view_count = view_count + 1`, and `first_viewed_at` via `COALESCE`. Failures are swallowed (a tracking write must never break the landowner's page render). Bot/prefetch mitigation: accept the small over-count; this is a soft signal, not analytics.

### KTD-4 — The table never renders a raw share URL
Per the explicit requirement (easy to copy the wrong link), the table has **no URL column**. Copy-link and WhatsApp are exposed only through a **per-row action menu** (dropdown), each scoped to that row's own token, mirroring the existing `SiteShareButton` popover actions. The primary row action is **"Editar"** → the builder route.

### KTD-5 — Redesign reuses the resolved data contract; only presentation changes
`PublicSiteDetail` / `ResolvedContentBlock` and the token-gated `/api/public/site-images` + `/api/public/site-audio` routes are unchanged. The redesign is a rewrite of `public-site-shell.tsx` presentation only: hero, count-up stat, swipe carousel, audio card, note, belonging, share bar. Species IUCN chips read the existing `biochoco_species.iucn_status` (already a column; may be null → chip omitted).

### KTD-6 — Builder relocation keeps a single source of truth
The `PageBuilder`, `SiteShareButton`, and preview move to the new builder route. The internal `site-detail-shell.tsx` drops them and gains a small **"Editar página pública →"** link (editors+ only) pointing at the builder route, so the internal view stays purely internal but remains a discoverable jump-off.

---

## High-Level Technical Design

### Navigation & route map (after)

```
BioChocó (nav group)
├── Cronograma, Datos, Hábitat, Temperatura, Resultados, Recursos, Herramientas   (unchanged)
└── Página pública            ← NEW grouped section (replaces single super-admin link)
    ├── Páginas de fincas   → /biochoco/paginas-publicas            (editors+)
    │     └── [siteId]       → /biochoco/paginas-publicas/[siteId]  builder + preview + share
    └── Resumen divulgativo → /admin/biochoco-overview              (super-admin, unchanged target)

Internal:  /biochoco/resultados/[siteId]   → keeps internal panels; builder REMOVED,
                                              gains "Editar página pública →" link
Public:    /public/(chrome)/biochoco/[token] → REDESIGNED shell; records view on render
```

### Status derivation (pure)

```
deriveSitePageStatus({ hasActiveToken, lastViewedAt, pageConfig }) →
  !hasActiveToken            → { key: 'sin_empezar', personalized: false }
  lastViewedAt == null       → { key: 'publicado',   personalized: pageConfig != null }
  else                       → { key: 'visto', viewedAt: lastViewedAt, personalized: pageConfig != null }
```

### Public page render + view-tracking sequence

```
GET /public/biochoco/[token]
  generateMetadata → fetchSiteDetailByToken(token)   [cache() hit #1, NO write]
  page component   → fetchSiteDetailByToken(token)   [cache() hit #2, NO write]
                   → recordSiteView(token)           [separate, fire-and-forget, swallows errors]
                   → <PublicSiteShell/>  (redesigned)
```

---

## Implementation Units

### U1. Nav: grouped "Página pública" section

**Goal:** Replace the single super-admin `Página pública` link with a parent group containing *Páginas de fincas* (editors+) and *Resumen divulgativo* (super-admin).

**Requirements:** Problem Frame #1; KTD-1.

**Dependencies:** none (can land first; child route arrives in U4 but the link can point ahead).

**Files:**
- `src/components/sidebar-nav.tsx` (modify — build a `NavItem` with `children`; reuse an editor predicate)
- `tests/unit/sidebar-nav-biochoco.test.ts` (create, if a testable extraction exists — otherwise extract the children-builder into a pure helper `buildBiochocoPublicNav(user)` and test that)

**Approach:** Introduce a small pure helper that, given the user's roles, returns the ordered child `NavItem[]` for the public group (empty when the user can see neither child). Render the group only when it has children. Keep the existing `NavItem` group/children rendering; do not invent a new nav primitive.

**Patterns to follow:** the existing `biochocoChildren` construction and `isBiochocoAdmin` / editor predicates in `src/components/sidebar-nav.tsx`; the `projectItems.push({ label, icon, children })` group shape.

**Test scenarios:**
- Editor (biochoco editor, not super-admin) → group present with only *Páginas de fincas*.
- Super-admin → group present with both children, correct order.
- Viewer-only (biochoco viewer) → group absent (no children).
- Non-biochoco user → group absent.

**Verification:** Nav shows the grouped section with correct children per role; no viewer sees *Páginas de fincas*; no non-super-admin sees *Resumen divulgativo*.

---

### U2. View tracking: schema + record action

**Goal:** Add `first_viewed_at`, `last_viewed_at`, `view_count` to `site_share_tokens` and record a view on public page render.

**Requirements:** Problem Frame #2; KTD-3.

**Dependencies:** none.

**Files:**
- `src/db/schema.ts` (modify — add three columns to `siteShareTokens`)
- `scripts/push-schema.mjs` (modify — append three idempotent `ALTER TABLE ... ADD COLUMN` migrations after line ~1022)
- `src/app/biochoco/resultados/actions.ts` (modify — add `recordSiteView(token)` server action)
- `src/app/public/(chrome)/biochoco/[token]/page.tsx` (modify — call `recordSiteView` once in the page body, not in `generateMetadata`)
- `tests/unit/landowner-record-site-view.test.ts` (create)

**Approach:** Columns: `first_viewed_at INTEGER` (nullable), `last_viewed_at INTEGER` (nullable), `view_count INTEGER NOT NULL DEFAULT 0`. `recordSiteView` resolves the active token, then `UPDATE ... SET last_viewed_at = <now>, view_count = view_count + 1, first_viewed_at = COALESCE(first_viewed_at, <now>) WHERE token = ? AND revoked_at IS NULL`. Timestamps written as **Unix seconds** (the `.mjs` migration is bare; the Drizzle action uses `mode:"timestamp"` columns → pass a `Date`). Wrap the call site in a try/catch that swallows errors. `recordSiteView` is **not** permission-gated (public route) but only mutates a row matched by an unguessable active token.

**Patterns to follow:** existing timestamp columns in `siteShareTokens` (`createdAt`, `revokedAt`); the seconds-vs-ms gotcha for raw `.mjs` scripts (see project memory); existing token-resolution query in `fetchSiteDetailByToken`.

**Test scenarios:**
- First view of a token → `first_viewed_at` set, `last_viewed_at` set, `view_count` = 1.
- Second view → `first_viewed_at` unchanged, `last_viewed_at` advanced, `view_count` = 2.
- Revoked token → no update, no throw.
- Unknown token → no update, no throw.
- Record failure (simulated DB error) → swallowed, does not propagate.

**Verification:** Opening a public page increments the count and stamps timestamps; a revoked/invalid token is a silent no-op; a tracking failure never breaks the render.

---

### U3. Server action: finca pages status list

**Goal:** One action returning every biochoco site with its derived public-page status, last-edited, and view info for the table.

**Requirements:** Problem Frame #2; KTD-2.

**Dependencies:** U2 (reads the new columns).

**Files:**
- `src/app/biochoco/paginas-publicas/actions.ts` (create — `fetchSitePublicPagesData()` + `SORTABLE_COLUMNS` map)
- `src/lib/landowner/page-status.ts` (create — pure `deriveSitePageStatus(...)`)
- `tests/unit/landowner-page-status.test.ts` (create)

**Approach:** `requirePermission("biochoco", "editor")`. Left-join the site list against active `site_share_tokens` (one active token per site, guaranteed by the unique partial index). For each site return: siteId, siteName, habitat, deploymentCount, status (via `deriveSitePageStatus`), `personalized`, `lastEditedAt` (token `createdAt` or a config-updated timestamp if available — else `createdAt`), `lastViewedAt`, `viewCount`. Sorting via URL params (SSR pattern) with a stable `siteId` tiebreaker. Status ordering for sort uses a rank (sin_empezar < publicado < visto or configurable).

**Patterns to follow:** `fetchResultadosData` in `src/app/biochoco/resultados/actions.ts`; the SSR sort URL-param pattern in `src/app/research-applications/page.tsx` and `src/app/admin/activity/page.tsx` (`SORTABLE_COLUMNS` map, `?sortBy=&sortDir=`).

**Test scenarios (pure helper):**
- No active token → `sin_empezar`, `personalized:false`.
- Active token, no views, `pageConfig` null → `publicado`, `personalized:false`.
- Active token, no views, `pageConfig` set → `publicado`, `personalized:true`.
- Active token + `lastViewedAt` set → `visto`, carries `viewedAt`.
- Revoked-only token (no active) → `sin_empezar`.

**Verification:** Action returns one row per site with a correct status; helper covers all four state combinations; sort params validated against the allowlist.

---

### U4. Páginas de fincas table page

**Goal:** The status table at `/biochoco/paginas-publicas` — sortable, status pills, no raw links, per-row action menu, "Editar" → builder.

**Requirements:** Problem Frame #1 & #2; KTD-2, KTD-4.

**Dependencies:** U3.

**Files:**
- `src/app/biochoco/paginas-publicas/page.tsx` (create — SSR, `requirePermission("biochoco","editor")`, reads sort params)
- `src/app/biochoco/paginas-publicas/pages-table.tsx` (create — client table: sort headers, pills, per-row `DropdownMenu`)
- `src/app/biochoco/paginas-publicas/loading.tsx` (create — skeleton, mirror resultados `loading.tsx`)
- `tests/unit/landowner-pages-table.test.tsx` (create)

**Approach:** Columns: **Finca** (name + siteId), **Estado** (pill + "Personalizada" badge + "visto hace N días"), **Última edición**, **Vistas** (count, tabular-nums), **Acciones** (`Editar` primary link + `⋯` menu with Copiar enlace / WhatsApp / Revocar). No URL column. Row click (or Editar) navigates to the builder route. Guard Radix menu clicks against row navigation (`e.currentTarget.contains(e.target)` — see project gotcha on portal event bubbling). Copy/WhatsApp reuse the token-scoped URL built client-side. Sortable per conventions (client `useState` local pattern *or* SSR URL param — match U3's choice; prefer SSR URL-param to preserve sort across reload).

**Patterns to follow:** `src/app/finance/expenses/expense-table.tsx` (client sortable) or the SSR pattern per U3; shared `SortIcon` from `@/components/sort-icon`; `SiteShareButton` popover for the copy/WhatsApp/revoke actions; the Radix-portal-bubbling guard gotcha.

**Test scenarios:**
- Renders a pill per status key with correct label/color.
- "Personalizada" badge shows only when `personalized:true`.
- "visto hace N días" shows only for `visto`.
- No cell renders the raw share URL (assert absence).
- Per-row menu exposes Copiar/WhatsApp/Revocar; clicking a menu item does **not** trigger row navigation.
- Sort by Estado / Última edición / Vistas reorders rows with a stable tiebreaker.

**Verification:** Table lists all sites with correct pills, no visible links, working per-row actions, sortable columns; "Editar" lands on the builder for the right site.

---

### U5. Dedicated builder route + internal-view decoupling

**Goal:** Move `PageBuilder` + share + preview to `/biochoco/paginas-publicas/[siteId]`; strip them from the internal Resultados detail, leaving a jump link.

**Requirements:** Problem Frame #1; KTD-6.

**Dependencies:** U4 (table links here); reuses existing `PageBuilder`, `SiteShareButton`, `getSiteShareLink`.

**Files:**
- `src/app/biochoco/paginas-publicas/[siteId]/page.tsx` (create — `requirePermission("biochoco","editor")`, loads site + `getSiteShareLink`)
- `src/app/biochoco/paginas-publicas/[siteId]/builder-shell.tsx` (create — header, `SiteShareButton`, `PageBuilder` w/ live preview; "create link first" empty state when no active token)
- `src/app/biochoco/resultados/[siteId]/site-detail-shell.tsx` (modify — remove `PageBuilder` + `SiteShareButton`; add editors-only "Editar página pública →" link to the builder route)
- `tests/e2e/landowner-pages-flow.spec.ts` (create — table → editar → builder → preview visible)

**Approach:** Reuse `PageBuilder` and `getSiteShareLink` unchanged. The builder route is the new home; if no active token exists, show a "Publicar enlace" primary action (creates the token, then reveals the builder) rather than hiding the builder behind the Resultados view. Internal detail keeps only the small link, gated to editors+ (`canShare`). Update the `SiteDetailShell` `SiteShareLink` prop wiring accordingly (or drop it there and load fresh in the builder route).

**Patterns to follow:** existing `site-detail-shell.tsx` composition; the current inline `PageBuilder` mount; breadcrumb pattern (`Página pública / Finca`).

**Test scenarios (E2E):**
- From the table, "Editar" opens the builder for the selected site.
- Builder shows the live preview iframe of the public URL.
- Saving a config change and reloading preview reflects it.
- Internal Resultados detail no longer shows the builder but shows the "Editar página pública →" link for an editor.
- A site with no active token shows the "Publicar enlace" empty state.

**Verification:** Builder is reachable only from the new section; internal view is decoupled; no duplicate builder mounts remain.

---

### U6. Public page redesign — story shell (hero, stat, note, belonging, share)

**Goal:** Rebuild `public-site-shell.tsx` presentation to the design spike: full-bleed hero, count-up species reveal, FCAT note, belonging card, share bar — mobile-first, desktop-graceful.

**Requirements:** Problem Frame #3; KTD-5. Matches design spike.

**Dependencies:** none on other units (data contract unchanged); can proceed in parallel with U1–U5.

**Files:**
- `src/app/public/(chrome)/biochoco/[token]/public-site-shell.tsx` (modify — restructure layout)
- `src/app/public/(chrome)/biochoco/[token]/story-stat.tsx` (create — count-up on view, `prefers-reduced-motion` guard)
- `tests/unit/landowner-public-shell.test.tsx` (create)

**Approach:** Keep the existing data destructuring (`site`, `contentBlocks`, `species`, counts) and the `resolveImageUrl`/`speciesHref` closures. Replace the visual structure with: hero (effective hero image + scrim + eyebrow/title/chips), the count-up stat block ("En su bosque encontramos N especies… 84 días"), then the configured `contentBlocks` (note/summary/featuredPhotos/featuredAudio/projectContext) restyled to match, then the species carousel (U7), then the share bar. Reuse `formatSiteDateRange`, `getHabitatName`. Video block and `hasIntroVideo` logic preserved. Count-up uses IntersectionObserver; falls back to the final number under reduced-motion or no-IO.

**Patterns to follow:** the current `public-site-shell.tsx` data wiring and `ContentBlock` cases (restyle, don't rebuild the data path); the design spike markup/tokens; `PhotoShareButton` overlay usage already present.

**Test scenarios:**
- Renders hero from `heroImageId`; falls back to header when null.
- Species count and days render correctly (0/1/plural Spanish forms).
- Reduced-motion: stat renders the final number without animating.
- Content blocks still render in configured order (note/summary/photos/audio/context).
- Contact form still renders at the end.

**Verification:** Public page matches the spike's structure on mobile widths, degrades cleanly on desktop, and preserves all existing content-block behavior; no layout overflow (per UI conventions).

---

### U7. Public page redesign — swipeable species carousel + IUCN chips

**Goal:** Horizontal scroll-snap species carousel with photo, name, scientific name, IUCN chip, and per-photo share — the social "feed" moment.

**Requirements:** Problem Frame #3; KTD-5.

**Dependencies:** U6 (mounted inside the redesigned shell).

**Files:**
- `src/app/public/(chrome)/biochoco/[token]/species-carousel.tsx` (create)
- `src/lib/landowner/iucn-chip.ts` (create — map `iucn_status` code → `{ label, color }`, null-safe)
- `tests/unit/landowner-iucn-chip.test.ts` (create)

**Approach:** CSS `scroll-snap-type: x mandatory` carousel (native touch swipe + desktop drag/scroll), each card = token-gated species photo (`resolveImageUrl(photoImageId,'large')`), common + scientific name, an IUCN chip when `iucn_status` is present, and a `PhotoShareButton` overlay. Card links to the species detail (`speciesHref`). Species lacking a photo are skipped or shown with a neutral tile. Swipe-hint affordance (animated, reduced-motion-guarded). Chip color mapping: LC→green, NT→amber, VU/EN/CR→escalating red, DD/null→omit or grey.

**Patterns to follow:** the design spike carousel CSS (snap, hidden scrollbar, card scrim); existing species data shape (`data.species` with `photoImageId`, common/scientific names) in `public-site-shell.tsx`; `PhotoShareButton` overlay variant.

**Test scenarios (chip helper):**
- `LC` → "Preocupación menor", green.
- `NT` → "Casi amenazado", amber.
- `VU`/`EN`/`CR` → correct Spanish labels, escalating severity color.
- `DD` / unknown / null → chip omitted (returns null).
- Carousel component: renders one card per species-with-photo; species without photo handled per rule; card links to species href.

**Verification:** Carousel swipes on touch and scrolls on desktop; chips render only for known statuses with correct Spanish labels/colors; per-photo share works; no horizontal overflow of the page body.

---

### U8. Responsive, accessibility & regression pass

**Goal:** Verify the redesigned public page and new table across mobile/desktop, themes, keyboard, and reduced-motion; no regressions in existing tests.

**Requirements:** UI Development conventions (no layout regressions; sortable tables).

**Dependencies:** U4, U6, U7.

**Files:**
- `tests/e2e/landowner-public-page.spec.ts` (create — mobile viewport render, carousel swipe, share bar)
- (verification only across existing suites)

**Approach:** Playwright at a phone viewport and a desktop viewport. Check hero, count-up, carousel scroll, audio card, share bar, contact form. Keyboard focus states visible on interactive elements; carousel reachable. Confirm `npm run build`, `npm run test:run`, and existing e2e stay green. Confirm the pre-existing unrelated `biochoco-overview-content.test.ts` failure is still the only known red (out of this scope).

**Test scenarios:**
- Mobile viewport: page renders full-bleed, no horizontal body scroll.
- Desktop viewport: device-framed/centered, content legible, no empty gaps.
- Carousel: swipe/scroll advances cards; focusable.
- Light and dark themes both legible.
- Reduced-motion: no count-up/animation.

**Verification:** All new + existing tests pass (modulo the known unrelated failure); no layout regressions on either viewport; a11y focus states present.

---

## Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| View-tracking write inside the `cache()`d fetch causes double/no writes | KTD-3: write is a separate action called once from the page body, never in `generateMetadata` or the cached fetch. |
| Timestamp unit mismatch (ms vs seconds) on the new columns | Migration uses bare `INTEGER`; Drizzle action uses `mode:"timestamp"` and passes a `Date`. Covered by U2 tests + the raw-scripts-seconds gotcha in memory. |
| Radix per-row menu clicks trigger row navigation in the table | Guard with `e.currentTarget.contains(e.target)` (known project gotcha). |
| Raw share URL leaks into the table (copy-wrong-link risk) | KTD-4: no URL column; explicit test asserts absence; actions are per-row token-scoped. |
| Redesign regresses existing content-block behavior | U6 reuses the data path unchanged; tests assert block order + contact form still render. |
| `iucn_status` mostly null → empty chips | Chip helper returns null for null/DD/unknown; carousel renders cleanly without a chip. |
| Server→Client serialization of icons/functions | Follow the established rule (string identifiers, resolve on client) — no components passed as props. |

## Dependencies / Sequencing

- **Independent, can start immediately:** U1 (nav), U2 (tracking), U6 (redesign shell).
- **U3** after U2. **U4** after U3. **U5** after U4. **U7** after U6. **U8** after U4+U6+U7.
- Redesign track (U6→U7→U8-partial) and IA track (U1→U2→U3→U4→U5) are largely parallel; they meet at U8.

## Operational Notes

- After merge, run the schema push to add the three columns:
  `docker compose exec portal node scripts/push-schema.mjs` (idempotent).
- No backfill needed — new tracking columns default sensibly (`view_count` 0, timestamps null → status derivation treats null-view as "publicado").
- No new env vars. Reuses existing token-gated media routes and `NEXT_PUBLIC_BASE_URL`.

## Sources & Research

- Design spike (approved direction): https://claude.ai/code/artifact/adc655a2-f457-4828-9cd8-71f747b8a530
- Origin: `docs/plans/2026-07-15-006-feat-landowner-page-builder-plan.md` (page-config model reused).
- Current public shell: `src/app/public/(chrome)/biochoco/[token]/public-site-shell.tsx`.
- Nav source: `src/components/sidebar-nav.tsx` (lines ~63–82).
- Token schema: `src/db/schema.ts` (`siteShareTokens`, ~1402); migrations in `scripts/push-schema.mjs` (~1017–1022).
- Sortable-table patterns: `src/app/research-applications/page.tsx`, `src/app/admin/activity/page.tsx`, `src/app/finance/expenses/expense-table.tsx`; `@/components/sort-icon`.
