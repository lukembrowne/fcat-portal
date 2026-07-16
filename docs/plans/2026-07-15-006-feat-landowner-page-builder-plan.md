---
title: "feat: Landowner Dashboard — Per-Site Page Builder"
type: feat
date: 2026-07-15
origin: docs/plans/2026-07-14-feat-landowner-biodiversity-dashboard-vision-plan.md
---

# feat: Landowner Dashboard — Per-Site Page Builder

## Summary

Give the BioChoco team a self-serve, no-code builder for the public landowner page
(`/public/biochoco/{token}`) that consolidates today's scattered curation primitives
— hero image, personalized note, featured audio clip — into one editable **page
config**, and adds the remaining curation the vision calls for: a set of featured
photos (~5), a free-text summary/description block, and an optional "Sobre el
proyecto BioChoco" context card. The builder ships with a **preview-as-landowner**
mode so the team sees the exact mobile view before sending, and un-curated sites keep
rendering sensible defaults (hero = best photo, all verified species). This is Feature
6 of the roadmap; it deliberately does **not** build the `sites` table, engagement
tracking, or the montage.

## Problem Frame

Curation primitives already exist but are scattered and partial: `heroImageId` is
chosen at share-link creation, and a `landownerNote` + `featuredAudioId` were added to
`site_share_tokens` as the first personalization fields (with an inline editor in the
share popover). There is no single surface where the team composes a landowner page,
no way to feature multiple photos, no summary block, and no way to preview the
landowner's exact view before sending a WhatsApp link. The result is that
personalization is possible but awkward, and the page can't yet be tailored per site
at any scale. This plan turns those one-off fields into a coherent builder.

---

## Scope Boundaries

### In scope

- A **page config** model (ordered, typed blocks) stored on the site's active share
  token, with a one-time backfill folding the existing `heroImageId` / `landownerNote`
  / `featuredAudioId` into it.
- A **builder UI** on the internal results page: media picker (photos + audio scoped
  to the site's verified detections), text blocks (summary + thank-you note), hero
  selection, and an optional project-context card toggle.
- **Featured photos** (~5) surfaced on the public page, reusing the existing
  starred/"Destacadas" curation UI where possible.
- **Preview-as-landowner**: render the public page exactly as the landowner will see
  it, from the builder, before the link is sent.
- **Graceful defaults**: an un-curated (or config-less) token renders today's page.
- Public page reads config-first with a fallback to the legacy columns during
  transition.
- `recordEvent()` on config save.

### Deferred / out of scope

- **`sites` table / stable site↔deployment key** (Architecture item). This plan keeps
  config on `site_share_tokens` per the vision's explicit storage decision ("live
  config on a single token, not versioned snapshots"), so it does **not** block on the
  sites table. If the sites table lands later, config migrates by key — noted in KTD-1.
- **Engagement tracking** (Feature 7) — separate Phase 2 unit.
- **The montage** (Feature 4) and the token-scoped **video** route — Phase 3.
- **"¿Sabía que…?" natural-history facts** — content-authoring feature; can be added
  as a new block type later without schema change (KTD-2 makes block types additive).
- Version history / drafts. Config is live-edit; landowners don't need versions.

### Outside this product's identity (from origin)

- No confidence scores, acoustic indices, taxonomic ranks, GPS, or maps on the
  landowner surface. The builder must not expose these even as options.

---

## Requirements

### Config & storage

- R1. A site's active share token carries a **page config**: an ordered list of typed
  blocks. Absent/invalid config → the page renders today's default layout.
- R2. A one-time backfill folds existing `heroImageId`, `landownerNote`, and
  `featuredAudioId` on active tokens into an equivalent config, so no live page
  changes appearance at cutover.
- R3. All block types are **additive**: adding a new type never requires a schema
  migration (the config is a single JSON column; unknown block types are ignored by
  older readers).

### Builder UI (internal, editor+)

- R4. From the internal results page, an editor can open a builder for a site that has
  an active share link, composed of: hero picker, featured-photos picker (≤ a capped
  count), summary text block, thank-you note text block, featured-audio picker,
  project-context card toggle.
- R5. The media pickers are scoped to the **site's own** verified detections (photos)
  and the site's Drive-backed playable audio — never another site's media. Reuse the
  starred/"Destacadas" selection UI for photos where practical.
- R6. **Preview-as-landowner** renders the exact public mobile view from the current
  (unsaved or saved) config without sending the link.
- R7. Saving validates every referenced image/audio id against the site's snapshot
  (reject cross-site ids), caps text length, and caps featured-photo count. Save calls
  `recordEvent()`.

### Public page

- R8. The public page renders blocks in config order, each block degrading to nothing
  when its referenced media is missing/stale (mirrors today's featured-audio guard).
- R9. Featured photos render as a shareable gallery reusing the watermarked large-image
  tier and the existing per-photo share button.
- R10. The optional project-context card shows 2–3 sentences excerpted from the
  overview `content.ts` plus a "Conozca más" link to `/public/biochoco-overview`
  (single source of copy — no duplication).

---

## Key Technical Decisions

### KTD-1 — Config lives on `site_share_tokens`, not a new table (yet)

The vision's storage decision is explicit: live config on a single token, not
versioned snapshots. Add one nullable `page_config` TEXT (JSON) column to
`site_share_tokens`. This avoids taking on the `sites`-table refactor as a hard
dependency. **Trade-off**: config is tied to the active token's lifetime — revoking a
link and creating a new one starts fresh. Mitigate by copying `page_config` forward in
`createSiteShareLink` when an existing (about-to-be-revoked) token has one, so
re-issuing a link preserves curation. If the `sites` table later lands, config moves
to a `site_page_config` table keyed by site and the token column is dropped.

### KTD-2 — Config schema: ordered list of discriminated-union blocks

```
type PageBlock =
  | { type: "hero"; imageId: number | null }
  | { type: "summary"; text: string }
  | { type: "note"; text: string }
  | { type: "featuredPhotos"; imageIds: number[] }
  | { type: "featuredAudio"; audioId: number | null }
  | { type: "projectContext"; enabled: boolean }
type PageConfig = { version: 1; blocks: PageBlock[] }
```

Directional only — validated at the edges with a hand-written guard (the project has no
zod dependency in this path; mirror the defensive `JSON.parse` + shape checks already
in `fetchSiteDetailByToken` for `deploymentIds`). Unknown `type` values are dropped on
read, which is what makes R3 hold. A pure `parsePageConfig(raw): PageConfig | null`
lives in a non-server module so it is unit-testable and shared by the public reader,
the builder, and the backfill.

### KTD-3 — Reuse, don't fork, the render primitives

The public shell already renders hero, note, featured-audio, species cards, and the
per-photo share button. The builder's public output is the **same components driven by
config** rather than by ad-hoc props. Refactor `public-site-shell.tsx` to map
`config.blocks` → the existing block renderers, keeping the default (config-less) path
as the fallback ordering. Preview-as-landowner renders this same shell against the
in-progress config — no second renderer.

### KTD-4 — Featured photos scoped via the token snapshot

Photo ids are validated against the site's `deploymentIds` snapshot exactly like the
featured-audio validation shipped in `updateSiteSharePersonalization`. The featured-
photos picker lists verified detections for the snapshot's deployments (reuse
`fetchSpeciesImagesForDeployments` / the "Destacadas" starred set). This keeps the one
security invariant — a token can only ever surface its own site's media.

---

## Implementation Units

### U1 — Page config schema + parser (foundation)

- **Goal**: Introduce `page_config` storage and a pure, tested parser/serializer.
- **Files**: `src/db/schema.ts` (add `pageConfig: text("page_config")` to
  `siteShareTokens`), `scripts/push-schema.mjs` (append `ALTER TABLE site_share_tokens
  ADD COLUMN page_config TEXT`), **create** `src/lib/landowner/page-config.ts`
  (`PageBlock`/`PageConfig` types, `parsePageConfig`, `serializePageConfig`,
  `defaultConfigFromLegacy({heroImageId, landownerNote, featuredAudioId})`),
  **create** `tests/unit/landowner-page-config.test.ts`.
- **Approach**: Mirror the bare-TEXT migration pattern used for `iucn_status` /
  `landowner_note`. Parser is defensive (like the `deploymentIds` guard).
- **Execution note**: test-first — the parser's contract (valid, malformed, unknown
  block, legacy-fold) is the crux.
- **Test scenarios**: valid config round-trips; malformed JSON → null; unknown block
  type dropped, known blocks kept; `defaultConfigFromLegacy` produces hero+note+audio
  blocks in the current default order; empty legacy → minimal config.
- **Verification**: unit tests green; `node scripts/push-schema.mjs` idempotent.

### U2 — Backfill legacy fields into config

- **Goal**: Every active token with legacy curation gets an equivalent `page_config`.
- **Files**: **create** `scripts/backfill-page-config.mjs` (in-container, synchronous
  better-sqlite3), read active `site_share_tokens`, write
  `defaultConfigFromLegacy(...)` where `page_config IS NULL`.
- **Approach**: One-shot script (matches the IUCN backfill posture). Idempotent (skip
  rows that already have config).
- **Test scenarios**: N/A (operational script) — dry-run log of affected rows.
- **Verification**: run in-container; spot-check a token renders identically before/after.

### U3 — Public page reads config-first with legacy fallback

- **Goal**: `fetchSiteDetailByToken` returns a resolved `PageConfig`; the shell renders
  blocks in order; config-less tokens render today's layout.
- **Files**: `src/app/biochoco/resultados/actions.ts` (resolve + validate config,
  resolve featured-photo metadata like featured-audio is resolved today),
  `src/app/public/(chrome)/biochoco/[token]/public-site-shell.tsx` (block-driven
  render; extract per-block renderers), `src/app/biochoco/resultados/[siteId]/types.ts`
  if new payload types are needed.
- **Approach**: KTD-3. Keep every block's "degrade to nothing on missing media" guard.
- **Execution note**: characterization-first — snapshot the current default render, then
  prove the config path reproduces it for a backfilled token.
- **Test scenarios**: config with all block types renders each; block referencing a
  deleted image renders nothing; config-less token renders default; featured-photos
  cross-site id rejected at resolve.
- **Verification**: build passes; a backfilled token is pixel-equivalent to pre-change.

### U4 — Builder UI + save action

- **Goal**: A composer on the internal results page writing `page_config`.
- **Files**: **create** `src/app/biochoco/resultados/[siteId]/page-builder.tsx`
  (client), extend `src/app/biochoco/resultados/actions.ts`
  (`updateSitePageConfig(siteId, config)` replacing/superseding
  `updateSiteSharePersonalization`; keep the latter as a thin shim or migrate its two
  callers), reuse `fetchSiteAudioOptions` + add `fetchSitePhotoOptions`.
- **Approach**: Full validation server-side per R7 (KTD-4 for ids). The builder can
  live behind the existing "Personalizar página" affordance in the share popover, or
  graduate to a dedicated panel on the results page — decide during execution based on
  the popover's size budget (**Deferred to Implementation**).
- **Test scenarios**: save with valid config persists + `recordEvent`; cross-site image
  id rejected; over-cap photo count rejected; over-length text rejected; no active link
  → clear error.
- **Verification**: build passes; edit → save → public page reflects change after refresh.

### U5 — Preview-as-landowner

- **Goal**: Render the exact public view from the in-progress config.
- **Files**: `src/app/biochoco/resultados/[siteId]/page-builder.tsx` (preview toggle),
  reuse `PublicSiteShell` against a preview payload; possibly a
  `/biochoco/resultados/[siteId]/preview` route or an in-place modal
  (**Deferred to Implementation**).
- **Approach**: KTD-3 — same shell, preview data. No second renderer.
- **Test scenarios**: preview reflects unsaved edits; preview uses the watermarked image
  tier and public routes (not internal auth'd routes).
- **Verification**: manual — preview matches the sent page.

### U6 — Project-context card

- **Goal**: Optional "Sobre el proyecto BioChoco" block.
- **Files**: `public-site-shell.tsx` (block renderer), a small excerpt selector reading
  the overview `content.ts` (single source), `page-config.ts` (block type already
  defined in U1).
- **Approach**: Pull 2–3 sentences + site-count belonging framing from the same
  snapshot the overview uses; link to `/public/biochoco-overview`.
- **Test scenarios**: card renders when enabled; hidden when disabled; copy comes from
  `content.ts` (no duplicated strings).
- **Verification**: build passes; link resolves.

---

## Sequencing & Dependencies

```
U1 (schema+parser) → U2 (backfill) → U3 (public read) → U4 (builder) → U5 (preview)
                                              └────────────→ U6 (context card)
```

U1 is the hard prerequisite for everything. U3 must land (and be verified pixel-equivalent
via the U2 backfill) before U4 is worth building. U5 depends on U4; U6 depends only on U1/U3.

## Verification (whole feature)

- `npm run build` passes; `npm run test:run` green (new `page-config` tests included).
- A backfilled token renders identically to its pre-change appearance.
- An editor can compose hero + featured photos + summary + note + audio + context card,
  preview the landowner view, save, and see it live — with all media scoped to the site.
- Un-curated tokens still render the default page.

## Deferred to Implementation

- Builder placement: expanded share popover vs. dedicated results-page panel (U4).
- Preview surface: dedicated route vs. in-place modal (U5).
- Featured-photo cap value and whether to reuse the starred set as the picker source.
- Whether `updateSiteSharePersonalization` is kept as a shim or fully replaced by
  `updateSitePageConfig`.
