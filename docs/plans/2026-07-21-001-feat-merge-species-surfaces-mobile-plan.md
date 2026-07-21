---
title: "feat: Merge farmer-page species surfaces into one mobile-first showcase"
type: feat
date: 2026-07-21
status: ready
depth: standard
origin: none (direct request, follow-up to docs/plans/2026-07-17-002-feat-farmer-sharing-pages-refinement-plan.md)
---

# feat: Merge farmer-page species surfaces into one mobile-first showcase

## Summary

The public landowner page (`/public/biochoco/[token]`) currently shows the site's
species **twice**, back to back:

- **"Quiénes viven aquí"** (`SpeciesCarousel`) — a horizontal swipe feed of only
  the species that have a photo. Tapping a card opens an on-page fullscreen
  lightbox (`SpeciesLightbox`) that lazy-fetches that species' photos. This is
  the buggy path: photo download/share is a single unlabeled icon, and the
  inline fetch/scroll behaviour is fragile.
- **"Todas las especies registradas"** (`SpeciesTable`) — a compact table of
  **all** species with tiny thumbnails. Tapping a species name navigates to the
  full-page `especies/[slug]` gallery (`GalleryClient`), which already has clear
  **Descargar** + **Compartir** buttons, pinch/wheel zoom, prev/next arrows, and
  adjacent-image preloading — the good photo-interaction experience.

The two are redundant. This plan **merges them into a single section** — a
mobile-first card grid (`SpeciesShowcase`) that keeps the carousel's big imagery
and name/status look, lists **all** species (table's completeness), sorts
most-at-risk first, and routes every photo tap to the good full-page gallery.
The buggy inline carousel + lightbox are deleted. A one-line copy fix changes the
project blurb's "N fincas" to "N sitios".

---

## Problem Frame

Luke reviewed the live page and reported: (1) the species table needs to be
responsive/mobile-friendly; (2) "Quiénes viven aquí" is redundant with the
table — he likes the carousel's *look* but the table's photo interaction is
better, and the carousel's gallery "kind of sucks and is buggy" with unclear
download/share; (3) merge the two into a "table-ish view with bigger hero images
like in the quienes viven aquí section"; (4) the "Sobre el proyecto BioChoco"
blurb says "102 fincas" but it should say "102 sitios".

The root cause of the redundancy is that the two surfaces were built for
different jobs (a visual highlight reel vs. a complete index) and never
reconciled. The photo-interaction split is the key insight: the table already
links to the *better* gallery; the carousel links to the *worse* one. Merging
lets us keep one imagery-forward surface AND the better gallery, and delete the
buggy code entirely.

---

## Requirements

- **R1** — One species section, not two. The merged section shows **all**
  species (photographed or not), sorted most-at-risk first.
- **R2** — Imagery-forward, mobile-first layout: each species gets a prominent
  image (not a 9×9 thumbnail), with common name, scientific name, IUCN status
  chip, and detection count. Single column on phones; 2–3 columns on wider
  screens. No horizontal swipe mechanic.
- **R3** — Tapping a species that has photos opens the existing full-page
  `especies/[slug]` gallery (clear Descargar/Compartir, zoom, arrows). Species
  with no photo render but are not tappable.
- **R4** — The buggy inline path (`SpeciesCarousel` + `SpeciesLightbox`) is
  removed; nothing on the page regresses (the featured-photo fullscreen gallery
  and its shared arrow helpers keep working).
- **R5** — The "Sobre el proyecto BioChoco" blurb says "N sitio/sitios", not
  "N finca/fincas".

Scope note: the individual-landowner captions ("su finca", "mi finca") stay —
those correctly refer to the landowner's own land. Only the **project-wide
count** changes to "sitios".

---

## Key Technical Decisions

**KTD1 — Photo tap navigates to the full-page gallery; delete the inline
lightbox.** The `especies/[slug]` route (`GalleryClient`) is already the good
experience Luke praised: labeled Descargar + Compartir, zoom, arrows, preloading,
and no-JS-safe download anchors. The merged cards link there (as `SpeciesTable`
already does), so we delete `SpeciesLightbox` entirely rather than rebuild its
missing affordances. Trade-off accepted: a photo tap is a page navigation, not an
on-page popup. (Confirmed with user.)

**KTD2 — New `SpeciesShowcase` replaces both old components.** The mental model
shifts from "carousel + table" to one "showcase" card grid, so a fresh component
is clearer than mutating either. `species-carousel.tsx`, `species-lightbox.tsx`,
and `species-table.tsx` are all deleted. The existing pure sort/name helpers in
`src/lib/landowner/copy.ts` (`sortSpeciesForTable`, `speciesCommonName`,
`iucnSeverityRank`) are reused unchanged.

**KTD3 — Relocate the surviving pure helpers into `copy.ts` before deleting
their host files.** Deleting `species-carousel.tsx` and `species-lightbox.tsx`
would strand three still-used exports: `buildSpeciesStatsText` (used by the
showcase caption + a unit test) and `lightboxArrowState` /
`LIGHTBOX_PREV_LABEL` / `LIGHTBOX_NEXT_LABEL` (used by the *featured-photo*
`StarredGalleryLightbox` that lives inside `public-site-shell.tsx`, plus the
`gallery-nav` test). Move all four to `copy.ts` (their natural home — pure,
DB-free) and repoint imports. This also lets `landowner-public-shell.test.tsx`
drop its now-obsolete `vi.mock` of `species-lightbox`.

**KTD4 — Keep the "Quiénes viven aquí" heading + `ConservationKey`.** The name
Luke likes stays on the merged section; the IUCN legend stays right after it
(it explains the chips shown on the cards).

---

## High-Level Technical Design

Public page section order — before vs. after (only the species region changes):

```
BEFORE                                AFTER
  … content blocks …                    … content blocks …
  SpeciesCarousel  ("Quiénes…")   ─┐    SpeciesShowcase  ("Quiénes viven aquí")
     └─ tap → SpeciesLightbox      │       └─ tap (has photo) → especies/[slug]
        (inline, buggy)            │          (full-page GalleryClient: good)
  ConservationKey                  ├──►  ConservationKey
  SpeciesTable ("Todas…")          │     SiteResultsContent (habitat)
     └─ tap → especies/[slug]     ─┘     PageShare / ContactForm
  SiteResultsContent …
```

`SpeciesShowcase` card anatomy (mobile 1-col → desktop 2–3-col grid):

```
┌─────────────────────────────┐
│  [ prominent species image ] │  ← photoImageId "large"; placeholder if none
│   ⟨IUCN chip⟩                │
│  Ocelote                      │  ← common name (bold)
│  Leopardus pardalis (italic)  │  ← scientific
│  128 registros   Ver fotos →  │  ← detection count + tap affordance (if photo)
└─────────────────────────────┘
   whole card = <a href={speciesHref}> when photoImageId != null, else plain div
```

---

## Implementation Units

### U1. `SpeciesShowcase` merged component

**Goal:** A single imagery-forward, all-species, mobile-first card grid that
replaces both the carousel and the table.

**Requirements:** R1, R2, R3.

**Dependencies:** none (reuses existing `copy.ts` helpers; `buildSpeciesStatsText`
is relocated in U2 but can be imported from its final `copy.ts` home — sequence
U2's helper move first if implementing strictly in order, or import from
`copy.ts` and let U2 land the move).

**Files:**
- `src/app/public/biochoco/[token]/species-showcase.tsx` (create)
- `src/app/public/biochoco/[token]/__tests__/species-showcase.test.tsx` (create)

**Approach:**
- Props: `species: SiteSpecies[]`, `resolveImageUrl: (id, size) => string`,
  `speciesHref: (speciesName) => string`. Server-renderable (no client state
  needed — it's links + images), so no `"use client"`.
- Return `null` when `species.length === 0`.
- Heading block: "Quiénes viven aquí" eyebrow + `buildSpeciesStatsText(species)`
  caption (relocated helper).
- Body: `sortSpeciesForTable(species)` → responsive grid
  (`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3`). Each card:
  - Image area (`aspect-[4/3]` or `3/2`) using `resolveImageUrl(photoImageId,
    "large")` with `loading="lazy"`; a neutral `bg-muted` placeholder when
    `photoImageId == null`.
  - IUCN chip (via `iucnChip(sp.iucnStatus)`), common name
    (`speciesCommonName(sp)`), scientific name (italic, `sp.speciesName`),
    detection count ("N registro/registros"), and a "Ver fotos →" affordance
    only when the species has a photo.
  - Card is an `<a href={speciesHref(sp.speciesName)}>` **only when
    `photoImageId != null`**; otherwise a plain `<div>` (no dead link).
- Reuse the carousel's TypeIcon idea only if it adds value; not required.

**Patterns to follow:** the visual language of `species-carousel.tsx` (image +
gradient scrim + name overlay + chip) and the completeness/linking logic of the
current `species-table.tsx`. Chip rendering mirrors `ConservationKey` /
`iucn-chip.ts`.

**Test scenarios** (`species-showcase.test.tsx`, `renderToStaticMarkup` — no
jsdom, follow `landowner-public-shell.test.tsx`):
- Renders one card per species including species with `photoImageId == null`
  (completeness): given 3 species (2 with photos, 1 without), all 3 names appear.
- Species **with** a photo render an `<a href>` to `speciesHref`; species
  **without** a photo do **not** (assert the no-photo species' name is present
  but not wrapped in an anchor to its slug).
- Most-at-risk-first order: a CR species appears before an LC species in the
  markup (delegates to `sortSpeciesForTable`; assert DOM order).
- IUCN chip label renders for assessed species; renders no chip for DD/null.
- Caption uses `buildSpeciesStatsText` (e.g. contains "especies ·").
- Returns nothing for an empty species list (empty string markup).

---

### U2. Land the merge: relocate helpers, delete old components, rewire the shell

**Goal:** Swap `SpeciesShowcase` into the page, delete the three superseded
components, and move the surviving pure helpers so nothing dangles.

**Requirements:** R1, R4.

**Dependencies:** U1.

**Files:**
- `src/lib/landowner/copy.ts` (modify — add relocated helpers)
- `src/app/public/biochoco/[token]/public-site-shell.tsx` (modify)
- `src/app/public/biochoco/[token]/species-carousel.tsx` (delete)
- `src/app/public/biochoco/[token]/species-lightbox.tsx` (delete)
- `src/app/public/biochoco/[token]/species-table.tsx` (delete)
- `src/app/public/biochoco/[token]/__tests__/gallery-nav.test.tsx` (modify — import path)
- `tests/unit/landowner-public-shell.test.tsx` (modify — import path, drop obsolete mock)

**Approach:**
- **Relocate into `copy.ts`:** move `buildSpeciesStatsText` (from
  `species-carousel.tsx`) and `lightboxArrowState`, `LIGHTBOX_PREV_LABEL`,
  `LIGHTBOX_NEXT_LABEL` (from `species-lightbox.tsx`) verbatim. `copy.ts` is
  DB-free and already the home for landowner pure helpers.
- **`public-site-shell.tsx`:**
  - Replace the `SpeciesCarousel` (line ~255) **and** `SpeciesTable` (line ~263)
    renders with a single `<SpeciesShowcase species={data.species}
    resolveImageUrl={resolveImageUrl} speciesHref={speciesHref} />`, keeping
    `ConservationKey` immediately after it.
  - Update imports: drop `./species-carousel`, `./species-table`, and the
    `./species-lightbox` helper import; import `SpeciesShowcase` from
    `./species-showcase` and the three lightbox helpers from
    `@/lib/landowner/copy`. `StarredGalleryLightbox` (the featured-photo gallery,
    still in this file) keeps working via the relocated helpers.
- **Delete** `species-carousel.tsx`, `species-lightbox.tsx`, `species-table.tsx`.
- **`gallery-nav.test.tsx`:** repoint `lightboxArrowState` / labels import from
  `../species-lightbox` to `@/lib/landowner/copy` (assertions unchanged).
- **`landowner-public-shell.test.tsx`:** repoint `buildSpeciesStatsText` import
  from `species-carousel` to `@/lib/landowner/copy`; delete the
  `vi.mock("@/app/public/biochoco/[token]/species-lightbox", …)` (component gone,
  no longer imported by the shell).

**Patterns to follow:** the existing `SpeciesTable` wiring in
`public-site-shell.tsx` (same three props, same slot).

**Verification:** `npm run test:run` green (incl. relocated `buildSpeciesStatsText`
and `gallery-nav` suites); `npx tsc --noEmit` shows no *new* errors; `grep -rn
"species-carousel\|species-lightbox\|species-table" src tests` returns no live
imports; the page renders the single showcase + `ConservationKey` + habitat.

**Test scenarios:**
- Relocated `buildSpeciesStatsText` still passes its existing cases (import path
  only — behaviour unchanged).
- Relocated `lightboxArrowState` + labels still pass the `gallery-nav` cases.
- `landowner-public-shell.test.tsx` still renders the shell (species region now
  the showcase; assert species markup present, no lightbox mock needed).

---

### U3. Copy fix: "fincas" → "sitios" in the project blurb

**Goal:** The project-wide count in the "Sobre el proyecto BioChoco" block reads
"N sitio/sitios".

**Requirements:** R5.

**Dependencies:** none (independent of U1/U2).

**Files:**
- `src/app/public/biochoco/[token]/public-site-shell.tsx` (modify — `projectContext`
  case, ~line 650–657)
- `tests/unit/landowner-public-shell.test.tsx` (modify — assertion)

**Approach:** In the `projectContext` block, change
`{block.siteCount === 1 ? "finca" : "fincas"}` to
`{block.siteCount === 1 ? "sitio" : "sitios"}`. Leave `PROJECT_CONTEXT_BLURB`
("fincas de cacao") and the per-landowner "su finca"/"mi finca" captions
untouched.

**Test scenarios:**
- The "promotes projectContext…" test asserts `"42 sitios"` (was `"42 fincas"`).
- (Optional) a `siteCount: 1` render asserts singular "1 sitio".

---

## Scope Boundaries

**In scope:** merging the two species surfaces into `SpeciesShowcase`; deleting
the carousel + inline lightbox + table; relocating four pure helpers; the
fincas→sitios copy fix; updating the affected tests.

**Not in scope (unchanged):** hero, StoryStat, video, `projectContext` layout,
habitat/`SiteResultsContent`, audio blocks, `PageShare`, `ContactForm`, the
internal page-builder, and the `especies/[slug]` gallery itself (we route to it,
not rebuild it).

### Deferred to Follow-Up Work
- None identified.

---

## Risks & Dependencies

- **Helper relocation must precede deletion.** If `species-lightbox.tsx` /
  `species-carousel.tsx` are deleted before their four exports land in `copy.ts`,
  the shell's `StarredGalleryLightbox` and the `gallery-nav` test break. U2
  sequences the move first — do not reorder.
- **`buildSpeciesStatsText` import in tests.** Two files import it; both must
  repoint to `copy.ts` or the suites fail to resolve.
- **Baseline `tsc` noise.** ~29 pre-existing unrelated `tsc` errors
  (tests/integration, tests/unit/finance) predate this work — judge success by
  "no *new* errors", not a clean `tsc`.

---

## Sources & Research

- Current components read this session: `public-site-shell.tsx`,
  `species-carousel.tsx`, `species-lightbox.tsx`, `species-table.tsx`,
  `especies/[slug]/page.tsx`, `especies/[slug]/gallery-client.tsx`,
  `photo-share-button.tsx`, `src/lib/landowner/copy.ts`.
- Import/usage scan (`grep`) confirming the four helpers to relocate and the
  three test files to touch.
- Prior plan: `docs/plans/2026-07-17-002-feat-farmer-sharing-pages-refinement-plan.md`
  (this is a follow-up refinement of that feature).
