---
title: "feat: Funders and acknowledgements section on the BioChoco public page"
type: feat
date: 2026-07-28
origin: docs/brainstorms/2026-07-14-biochoco-public-report-requirements.md
---

# feat: Funders and acknowledgements section on the BioChoco public page

## Summary

Add a text-only funders and acknowledgements section to the end of `/public/biochoco-overview`, above the footer. It thanks Wedgetail Foundation, the National Science Foundation, and private donors as funders, and separately credits Ecuador's Ministry of the Environment, Water and Ecological Transition (MAATE) for institutional support and research permitting. The section is static bilingual copy that renders on the live page and in the self-contained download export.

---

## Problem Frame

The page is a recruiting and outreach artifact aimed at collaborators, funders, and the public, and it currently ends with the "Where collaborators come in" call-to-action and a one-line footer. Nothing on it credits the organizations that pay for the work or the ministry that authorizes it. Funder acknowledgement is both an obligation of the awards and a credibility signal for the audience this page is written for.

The MAATE relationship is categorically different from the others: it is permitting and institutional support, not money. Listing it alongside the funders would misrepresent it, so the section has to make that distinction structurally rather than in a footnote a reader can skip.

---

## Requirements

**Content**

- R1. The page ends with a funders and acknowledgements section positioned between the collaborators call-to-action and the footer.
- R2. The funders group names Wedgetail Foundation, the National Science Foundation, and private donors.
- R3. MAATE appears in a separate, distinctly labeled group credited for institutional support and research permitting, never among the funders.
- R4. The section is text only — no logo images and no new static assets.

**Bilingual and delivery**

- R5. Section copy exists in English and Spanish with an identical key shape and equal per-group entry counts, and either language can be edited without touching the other. (see origin: `docs/brainstorms/2026-07-14-biochoco-public-report-requirements.md`, R4/R5)
- R6. The section appears in the self-contained HTML download in the language the visitor selected. (see origin: R14)
- R7. The section needs no admin re-publish — it ships with a deploy and does not read from the report snapshot.

**Tests**

- R8. `tests/unit/biochoco-overview-content.test.ts` passes, including the currently failing collaboration-opportunities expectation.

---

## Key Technical Decisions

- **KTD1 — Model the section as an array of labeled groups, not a flat funder list.** The funders-versus-permitting distinction (R3) is the reason this section exists, so it belongs in the data shape rather than in prose the renderer can drop. Both renderers iterate groups, so a future group needs no renderer change.

- **KTD2 — Text only; no logo fields in the data shape.** Logos would mean sourcing image assets and clearing usage terms (NSF restricts logo use by non-NSF organizations), plus inlining each one as a data URI in the export. Entries carry an optional `note` line for things like an award number. Adding an image field later is purely additive.

- **KTD3 — Static page copy in `content.ts`, not snapshot data.** Nothing here derives from the database, so the section ships with a deploy, and the export picks it up from `CONTENT` for free. Routing it through `public_report_snapshots` would tie unchanging copy to an admin publish step for no benefit.

- **KTD4 — Reuse each renderer's existing design vocabulary.** The live page gets a small addition to its scoped `.bc-root` stylesheet, following the `.obj` card treatment. The export reuses its simplified `.card` / `.grid2` classes and needs no new CSS. The two stylesheets are already independent; keeping them that way avoids a shared-CSS refactor for one section.

---

## Implementation Units

### U1. Acknowledgements content block (types + bilingual copy)

**Goal:** `CONTENT.en` and `CONTENT.es` carry the section's copy in a group-shaped structure.
**Requirements:** R2, R3, R4, R5.
**Dependencies:** none.
**Files:**
- `src/app/public/biochoco-overview/content.ts` — add an `AckGroup` interface (`title`, `body`, `entries: { name: string; note?: string }[]`), add `acknowledgements: { heading: string; intro: string; groups: AckGroup[] }` to `ReportContent` between `contacts` and `footer`, and populate both `en` and `es`.

**Approach:** two groups in fixed order — funders first, institutional support second. Group order is load-bearing (U4 asserts MAATE sits in the second group), so document it with a short comment the way `stats.tiles` documents its index coupling. Organization proper names stay untranslated where they have no official Spanish form; "Private donors" and the ministry's name do translate, so the parity test asserts counts, not name equality.

Copy to use:

- English — heading "Funders and acknowledgements"; intro along the lines of "BioChocó is possible because of the organizations and individuals who fund this work, and the institutions that support and authorize it."
  - Group 1: title "Funders", body "Support for the BioChocó monitoring network comes from:", entries `Wedgetail Foundation`, `National Science Foundation`, `Private donors`.
  - Group 2: title "Institutional support", body "We also thank the Ecuadorian authorities whose support and permitting make this fieldwork possible:", one entry `Ministry of the Environment, Water and Ecological Transition (MAATE)` with note "Research permitting and institutional support".
- Spanish — heading "Financiadores y agradecimientos"; intro "BioChocó es posible gracias a las organizaciones y personas que financian este trabajo, y a las instituciones que lo apoyan y lo autorizan."
  - Group 1: title "Financiadores", body "El apoyo a la red de monitoreo BioChocó proviene de:", entries `Wedgetail Foundation`, `National Science Foundation`, `Donantes privados`.
  - Group 2: title "Apoyo institucional", body "También agradecemos a las autoridades ecuatorianas cuyo apoyo y permisos hacen posible este trabajo de campo:", one entry `Ministerio del Ambiente, Agua y Transición Ecológica (MAATE)` with note "Permisos de investigación y apoyo institucional".

**Patterns to follow:** the existing `collaborate.oppList` / `platform.gallery` blocks — typed interface above, parallel `en` / `es` objects with identical key shape, no i18n library.
**Test scenarios:** covered by U4 (this unit adds data; the assertions live with the test file).
**Verification:** `npx tsc --noEmit` clean — the shared `ReportContent` type forces both language objects to carry the new block.

---

### U2. Render the section on the live page

**Goal:** the section renders between the collaborators call-to-action and the footer, styled consistently with the rest of the page and degrading correctly on mobile and in print.
**Requirements:** R1, R3, R4, R7.
**Dependencies:** U1.
**Files:**
- `src/app/public/biochoco-overview/report-shell.tsx` — insert a new `<section>` after the collaborate section's closing tag (~`:679`) and before the footer block (~`:681`); renumber the footer's `{/* 10 · Footer */}` comment to 11. Add the scoped CSS for it to the `CSS` template, add its grid class to the `max-width:820px` single-column collapse list (~`:238`), and add its card class to the `@media print` `break-inside:avoid` list (~`:246`).

**Approach:** follow the section skeleton every other section uses — `<section>` → `.wrap` → `.section-head` (`.rule`, `h2`, intro `<p>`) → content grid. Render `acknowledgements.groups` as a two-column grid of `--paper` cards matching the `.obj` treatment (border `--line`, radius, `--shadow`), each card carrying its title in the serif face, its body line in `--ink-soft`, and its entries as an unstyled list with the name in serif and the optional note beneath in `--ink-soft`. Group titles do the work of separating funders from permitting, so no extra badge or icon is needed.

Because the entries have no `email`-style optional link and no images, this is the simplest section on the page — resist adding a card variant that other sections would then diverge from.

**Patterns to follow:** the objectives grid (`.obj-grid` / `.obj`, `report-shell.tsx` `:110-114`) for the card treatment; the platform "Also in the platform" block (`.also` / `.also-t`, `:206-210`) for a titled sub-list inside a section.
**Test expectation: none** — rendering `report-shell.tsx` in a test would need a full snapshot fixture plus mocks for `next/dynamic`, the map, and the spectrogram clip, which is disproportionate for static copy. U4 covers the content shape and U3 covers the same `CONTENT` block through the export renderer. Verified manually.
**Verification:** on `http://localhost:3003/public/biochoco-overview`, the section appears above the footer in both languages via the toggle; the two groups read as distinct and MAATE is not visually grouped with the funders; at a narrow viewport the grid collapses to one column; browser print preview keeps each card intact and does not orphan the heading. No admin publish step is required for it to appear.

---

### U3. Render the section in the download export

**Goal:** the self-contained HTML download carries the same section, in the selected language.
**Requirements:** R6.
**Dependencies:** U1.
**Files:**
- `src/app/public/biochoco-overview/download/route.ts` — build the section markup in `buildHtml` alongside the existing `oppList` / `contacts` string builders, and emit it as a `<section>` after the collaborate section (~`:400`) and before `<footer>` (~`:402`). Export `buildHtml` so the test can call it directly.
- `tests/unit/biochoco-overview-download-html.test.ts` (new) — assertions below.

**Approach:** reuse the export stylesheet's existing `.grid2` and `.card` classes; no `DESIGN_CSS` change. Every interpolated string goes through the existing `esc()` helper, matching how `contacts` and `oppList` are built. Exporting `buildHtml` is the only structural change to the route — the `GET` handler is untouched.

**Patterns to follow:** the `oppList` and `contacts` builders (`download/route.ts` `:279-290`) for the string-concatenation-plus-`esc()` shape; the mocked-`@/db` route-test harness in `tests/unit/biochoco-overview-media-routes.test.ts`.
**Test scenarios:**
- `buildHtml` with a minimal snapshot (empty `images` and `audio`, so no Drive or `sharp` work is reached) and `lang: "en"` returns HTML containing the English heading, all three funder names, and the English MAATE name.
- Same with `lang: "es"` returns the Spanish heading, "Donantes privados", and the Spanish MAATE name — and does not contain the English funders-group title.
- MAATE's name appears after the last funder name in the output string, confirming the group ordering survives rendering.
- The acknowledgements markup appears before the closing `<footer>` marker in the output string.
- A funder name containing an ampersand or angle bracket is HTML-escaped (guards the `esc()` wiring on the new builder).

**Verification:** `/public/biochoco-overview/download?lang=es` and `?lang=en` both return 200 and the saved file shows the section when opened offline; `npm run test:run` green.

---

### U4. Content parity assertions + fix the stale collaboration-opportunities expectation

**Goal:** the content test pins the new section's shape and grouping, and the file passes again.
**Requirements:** R3, R5, R8.
**Dependencies:** U1.
**Files:**
- `tests/unit/biochoco-overview-content.test.ts` — correct `collaborate.oppList.length` from 5 to 7 for both languages (`:29-30`); add the acknowledgements assertions below; add the acknowledgements heading to the headline-drift test (`:35-45`).

**Approach:** the `oppList` expectation is stale, not a real failure — `content.ts` carries seven opportunities in both languages while the test still expects five, so the file fails today for reasons unrelated to this work. Correcting it is what makes `npm run test:run` a usable signal for U3.

Assert grouping by position rather than by string search across the whole block, so a future entry moved into the wrong group fails loudly.

**Patterns to follow:** the existing length-parity and headline-pinning tests in the same file.
**Test scenarios:**
- `en.collaborate.oppList.length` and `es.collaborate.oppList.length` are both 7.
- `en.acknowledgements.groups.length` and `es.acknowledgements.groups.length` are both 2.
- Per-group `entries.length` matches across languages (3 in the funders group, 1 in the support group).
- The funders group contains "Wedgetail Foundation" and "National Science Foundation" in both languages.
- The second group's entries include a MAATE name in both languages, and no entry in the first group mentions MAATE — the structural guard for R3.
- `en.acknowledgements.heading` is pinned to its exact string, alongside the other pinned headlines.
- The existing key-shape parity test still passes with the new block present.

**Verification:** `npx vitest run tests/unit/biochoco-overview-content.test.ts` green, then `npm run test:run` green.

---

## Scope Boundaries

**Out of scope (non-goals):**
- Logo images of any kind, and the static-asset plus data-URI-inlining work they would require.
- Sourcing acknowledgements from the grant-tracking module's `funders` table — that data is internal, English-only, and shaped for grant management, not public curation.
- Acknowledgements on any other public surface (landowner pages, the research-application page).
- Any change to the snapshot, publish action, or stats pipeline.

**Deferred to follow-up work:**
- Adding NSF award numbers or other grant identifiers to entry `note` lines once the numbers are confirmed (the data shape already accommodates them).
- The EDI dataset link and DOI citation block the origin requirements deferred — adjacent in spirit and a natural neighbor for this section, but a separate piece of work.

---

## Open Questions

- Confirm MAATE's current official name and preferred acknowledgement wording before shipping; the plan uses the name as given in the request, and Ecuadorian ministry names have changed over the years.
- Whether any award or permit numbers should appear on the entry `note` lines. None are included as planned; adding them later is a content-only edit.

---

## Risks & Dependencies

- **Funder wording is externally consequential.** Award terms sometimes prescribe acknowledgement language. The copy above is a reasonable default, not a checked-against-award-terms formulation — worth a read by whoever administers the awards before this goes out publicly.
- **The content test is red on `main`.** Anyone verifying this work with `npm run test:run` before U4 lands will see a failure that has nothing to do with this change.
- **Two renderers, one content block.** The live page and the export render `CONTENT` independently, so a section added to one and forgotten in the other is a silent divergence. U3's test covers the export; U2's manual check covers the page.

---

## Sources & Research

- `src/app/public/biochoco-overview/content.ts` — the bilingual `ReportContent` contract the new block extends; `contacts` (`:335-346`, `:560-571`) is the closest existing shape (typed list, parallel languages, optional field).
- `src/app/public/biochoco-overview/report-shell.tsx` — scoped `.bc-root` stylesheet (`:66-249`), the collaborate section and footer that bracket the insertion point (`:642-690`), and the responsive and print rules the new grid must join (`:233-248`).
- `src/app/public/biochoco-overview/download/route.ts` — `buildHtml` string builders and `esc()` (`:46-52`, `:279-290`), the export's independent `DESIGN_CSS` (`:131-195`), and the collaborate-to-footer insertion point (`:389-404`).
- `tests/unit/biochoco-overview-content.test.ts` — parity, length, and headline-pinning patterns. Confirmed failing on `main`: `collaborate.oppList.length` expects 5, content has 7.
- `tests/unit/biochoco-overview-media-routes.test.ts` — the mocked-`@/db` harness pattern the new export test follows.
- `docs/plans/2026-07-23-001-fix-biochoco-public-page-plan.md` — the prior pass on this page; its nginx work already exempts `/biochoco-overview/` and `/_next/static/` from auth, so no asset-serving work is implied here (and none is needed, since this section adds no assets).
