---
title: "feat: Drop the triage stage and fix the validation review UI"
date: 2026-08-10
type: feat
depth: deep
status: planned
origin: none (direct request, with screenshots)
---

# feat: Drop the triage stage and fix the validation review UI

## Summary

One structural change and a set of interface repairs on `/audio/validacion`, all from a second round of real use.

**The structural change: triage goes away.** Adding a species will draw its 200-clip stratified sample immediately, and the reviewer goes straight into the queue. The `triage` stage, the top-scoring draw, the go/no-go screen and the three triage columns are removed. This is a deliberate reversal of KTD-6 in the 2026-08-05 plan, which argued for keeping triage as an explicit decision point.

**The repairs.** The Estado column stretches the table because an unusable-fit sentence is rendered inside the cell. "Detalle" goes exactly where the species name already goes. The Muestra column carries the same number for nearly every row. The review screen has a paragraph nobody needs, a checkbox crammed onto the shortcut row that shifts the page when toggled, and no link to xeno-canto.

**Two bugs found while reading the code for the above**, neither reported and both worse than anything on the list: the reviewer's total double-counts after any refresh (this is the "20 de 10" in the screenshot), and "Cargar siguientes" leaves the reviewer stuck on the completion screen with no way back into the queue.

---

## Problem Frame

Triage was built to answer one question cheaply — *are BirdNET's ten best guesses for this species ever right?* — so nobody spends 200 clips on a species with no true positives at any score. The mechanism works. The problem is that it costs a stage: a species is created, then triaged, then decided on, then sampled, then reviewed, and at every boundary the interface has to explain where you are and what the next move is. The screenshots are all of that explanation failing. The user's read, after using it: the shortcut is not worth the workflow it imposes.

The cheap-bailout value does not have to die with the stage. `abandonCampaign` already exists, is already reversible, and can be offered at the end of every batch — 50 clips in, not 10, but at a moment when the reviewer has just heard the evidence and is already being asked what to do next. That is where it goes.

---

## Findings

Measured against the dev database inside the container, not inferred. Each one changes a decision below.

### F1. The stratified draw costs ~2 s per species, and the cost barely depends on the species

| Species | Detections | Triage draw (top 10) | `countByBin` | 9 bin draws | **Stratified total** |
|---|---:|---:|---:|---:|---:|
| *Ramphastos ambiguus* | 173,641 | 1538 ms | 301 ms | 1970 ms | **2270 ms** |
| *Nyctiphrynus rosenbergi* | 25,735 | 311 ms | 193 ms | 1636 ms | **1829 ms** |
| *Cephalopterus penduliger* | 21,117 | 266 ms | 188 ms | 1552 ms | **1740 ms** |
| *Attila torridus* | 2,185 | 214 ms | 168 ms | 1491 ms | **1659 ms** |
| *Tringa flavipes* | 93 | 179 ms | 274 ms | 1580 ms | **1854 ms** |

The floor is ~170 ms per bin regardless of abundance — nine windowed queries against the 2.5M-row `audio_identifications` table, each paying the species-index scan. A species with 93 detections costs the same as one with 25,000.

Two consequences. Auto-drawing on create is affordable for a single species (a ~2 s spinner). And the bulk importer's `COMMIT_CHUNK_SIZE` must come down, because the per-species cost rises from a typical 0.2 s to a near-constant 1.9 s (F2).

### F2. `COMMIT_CHUNK_SIZE` should be 5, not 10

The current 10 was sized against a triage draw of 0.2–1.3 s, i.e. a worst-case request of ~13 s. At 1.7–2.3 s per stratified draw, **5 species keeps the same worst case** (~11.5 s) while raising the typical chunk from ~2 s to ~8 s. Because the cost is flat in abundance (F1), there is no per-species tuning available — the chunk size is the only lever.

### F3. Nothing is applied, so the wipe is free

`birdnet_species_thresholds` holds exactly one row: *Cryptoleucopteryx plumbea*, `is_active = 0`, unusable ("Muestra insuficiente…"). No threshold is applied anywhere, so dropping the validation tables changes no species count, chart, export or occupancy input.

That same row is the direct cause of the reported Estado-column width — its `unusable_reason` string is rendered inline in the table cell.

### F4. The module has never been committed, so there is no production data

`git log` over `src/app/audio/validacion` and `src/lib/birdnet-validation` is empty; both directories are untracked. Prod holds no campaigns, samples or reviews. The dev database holds 35 campaigns, 887 samples and 67 reviews — all test data.

**Decision (user, this session): wipe the five `birdnet_validation_*` tables and start clean.** No data migration is needed anywhere. This also means the new create-and-draw path gets exercised end to end when the species are re-imported.

### F5. Every campaign still sitting in `triage` has zero reviews

28 of the 35 campaigns are in `triage`; none of them has a single review. The only 6 campaigns with reviewed triage clips had already moved past the stage. Recorded because it confirms the stage was being skipped in practice, not used — which is the same conclusion the user reached from the other side.

---

## Key Technical Decisions

### KTD-1. Creation draws the sample; the manual draw survives as the recovery path

`createCampaign` inserts the row and then draws, in one action. If the draw throws — no accessible detections, ODK down mid-lookup — the campaign stays created in `draft` and the error is reported. The species table already renders "Preparar" for `sampled === 0`, which calls the existing `drawSample`, so the recovery path needs no new UI.

This is the fault-isolation contract the bulk importer already relies on, unchanged: one species failing its draw must leave that species created, reported, and the batch continuing.

### KTD-2. `triage` is deleted from the status union, not deprecated in place

Leaving a status nothing can produce means `STAGE_LABEL`, `STAGE_TONE`, `STAGE_HINT` and `STAGE_FILTERS` all keep an entry for a stage that cannot occur, and the totality tests keep asserting on it. Since F4 says nothing is deployed and the tables are being wiped, the enum, the SQLite `CHECK`, and the three columns (`triage_size`, `triage_true_positives`, `is_triage`) all go.

Note the `text({ enum })` gotcha: Drizzle's enum is TypeScript-only. The `CHECK(status IN (...))` lives in `scripts/push-schema.mjs` and must be edited there or the change passes types and tests and throws `SQLITE_CONSTRAINT_CHECK` at runtime.

### KTD-3. One `key` fixes both review-screen bugs

Both bugs have the same root: `index` and `answers` are client state that survives a `router.refresh()`, which replaces `items` and `reviewedCount` from the server.

- **The "20 de 10"**: `totalReviewed = reviewedCount + answeredHere`. Once the server's count catches up with the answers still held in `answers`, every answer is counted twice.
- **The stuck completion screen**: after answering the 50th clip `index` is 50; "Cargar siguientes" refreshes, a fresh 50 arrives, `index` is still 50, so `done` stays true. The reviewer cannot get back into the queue. There is no `key` on `<ReviewClient>` and no effect that resets `index`.

Remounting on a new batch resets both to their correct starting values and lets the server's count be authoritative again. Losing `answers` on remount costs nothing — every answer was persisted the moment it was given.

The key is derived by a pure `batchKey(items)` in `review-progress.ts` so it is unit-testable: same batch → same key, new batch → different key, empty batch → a stable constant.

### KTD-4. The end-of-batch screen is where "stop here" lives

Removing triage removes the cheap exit from a hopeless species. The replacement is not a stage but a moment: at the end of every batch, alongside "continue", offer "discard this species" with one line saying what it means. This is the answer to *"there should be three options with some sort of brief explanation"* — the same screen the user was describing, moved from clip 10 to the end of each batch of 50.

"Ajustar el modelo" appears only once the reviewer's own count clears `MIN_REVIEWS_FOR_FIT` (20), and it links to the species page rather than firing the fit — the fit's output is a chart and a threshold, which need somewhere to land.

### KTD-5. Reversing the "two labelled destinations" decision

KTD-5 of the 2026-08-05 plan added the "Detalle" button because the row had two destinations (the species name and the action button) and an unlabelled pair read as one control behaving inconsistently. In use, the pair reads as a redundant control instead — "Detalle" and the species name go to the same URL, which is worse than the ambiguity it fixed.

Removing it and putting a `title` on the species-name link. Recording the reversal so it does not get re-added by someone reading the older plan.

### KTD-6. The unusable reason leaves the table cell and keeps its neutrality

Rendering a full sentence inside a status cell is what widened the column. The reason moves to the pill's `title` and to the species page, where there is room for it.

It must stay neutrally coloured wherever it lands. Most species BirdNET reports have no true positives at any score, so "sin umbral utilizable" is the expected result of a correctly-run validation, not a failure — the existing test asserting `STAGE_TONE.unusable` contains no red/rose/destructive class stays.

### KTD-7. Muestra and Revisadas collapse into one Progreso column

`sampled` is 200 for every drawn species and 0 for every undrawn one, so as a sortable column it is a boolean wearing a number. `Progreso` renders `84 / 200` — which answers "how big is the sample" and "how far along" in one cell — and sorts by `reviewed`.

`sampled` leaves `SORTABLE_COLUMNS`. An existing bookmark carrying `?sortBy=sampled` already degrades to the default sort via the `SORTABLE_COLUMNS.includes(...)` guard on the page, so no redirect handling is needed.

---

## Requirements

| # | Request | Unit |
|---|---|---|
| R1 | Estado column is too wide because of the unusable-fit sentence | U5 |
| R2 | "Detalle" goes to the same place as the species name | U5 |
| R3 | Do we need the Muestra column? | U5 |
| R4 | Remove "Tus respuestas se guardan al instante…" | U4 |
| R5 | "Mostrar confianza antes de responder" shifts the page and looks cramped | U4 |
| R6 | xeno-canto link on the review screen and the species page | U6 |
| R7 | End-of-batch screen gives no clear next step; wants options with brief explanations | U3 |
| R8 | Remove triage entirely; go straight to the 200-clip workflow | U1, U2 |
| D1 | *(found)* Reviewer total double-counts after a refresh — the "20 de 10" | U3 |
| D2 | *(found)* "Cargar siguientes" leaves the reviewer stuck on the completion screen | U3 |

---

## Implementation Units

### U1. Draw the stratified sample at creation

**Goal.** Adding a species — one at a time or in bulk — leaves it with its 200-clip sample drawn and ready to review.

**Files**
- Create `src/lib/birdnet-validation/sample-core.ts` (replaces `triage-core.ts`): keeps `attachHabitat` verbatim; `runTriageCore` becomes `drawSampleCore(campaign, ctProjects)` calling `drawStratifiedSample` + `presentationOrder`, inserting with `sampledAt` set and status `sampled`.
- Delete `src/lib/birdnet-validation/triage-core.ts`.
- Modify `src/lib/birdnet-validation/sampling.ts`: delete `drawTopScoring`; update the `presentationOrder` and file-header docstrings, which both reference triage.
- Modify `src/app/audio/validacion/actions.ts`: `createCampaign` draws after insert; delete `runTriagePass` and `finalizeTriage`; `drawSample` keeps its `sampledAt` guard as the recovery path; drop `triageDrawn`/`triageReviewed` from `CampaignProgress`, `triageSize`/`triageTruePositives` from `CampaignSummary` and `listCampaigns`.
- Modify `src/app/audio/validacion/import-actions.ts`: call `drawSampleCore`; rename the `triaged` result field to `drawn`; update the docstring's cost figures.
- Modify `src/app/audio/validacion/species-import.ts`: `COMMIT_CHUNK_SIZE` 10 → 5 (F2), with the measurement in the comment.
- Modify `src/app/audio/validacion/species-import-card.tsx`: `triaged` → `drawn`; the instruction copy ("ejecuta su triaje automáticamente") and the per-row failure copy ("ejecuta el triaje desde su página") both become sample-drawing language.
- Modify `src/app/audio/validacion/new-campaign-dialog.tsx`: remove the "Clips de triaje" input, `DEFAULT_TRIAGE_SIZE` import and the explanatory sentence.

**Patterns to follow.** `runTriageCore`'s existing shape — throw with a Spanish message so `errorResult` surfaces it verbatim and the bulk caller can catch per species. `drawSample` in `actions.ts` for the draw-then-transaction ordering (better-sqlite3 transactions are synchronous and cannot await the ODK habitat lookup).

**Execution note.** Test-first on the fault-isolation behaviour — that a failed draw leaves the campaign created is the property most likely to regress and the least visible when it does.

**Test scenarios**
- `createCampaign` on a species with detections returns a campaign whose status is `sampled` and whose sample row count is > 0.
- `createCampaign` on a species with no accessible detections leaves the campaign in `draft` with zero samples, and reports the failure rather than throwing.
- `drawSample` on that `draft` campaign afterwards succeeds and moves it to `sampled` (the recovery path).
- `drawSample` on an already-drawn campaign still refuses with "La muestra ya fue extraída".
- The drawn sample is still bin-stratified and still spreads across deployments — one clip per site per bin before any site's second.
- `commitSpeciesImport` refuses more than 5 names; a mid-list species whose draw fails is reported as created-with-error while later species in the same slice still succeed.
- Project scoping holds: a campaign scoped to one ct_project draws nothing from another.

**Verification.** `docker compose exec portal npx vitest run tests/integration/birdnet-` passes; adding a species through the dialog on `localhost:3003` lands on a row showing "Revisar", not "Preparar".

---

### U2. Remove the triage stage from the schema, the types and the vocabulary

**Goal.** No stage, column, status or label named triage survives.

**Files**
- `src/lib/birdnet-validation/types.ts`: drop `"triage"` from `CampaignStatus`; delete `DEFAULT_TRIAGE_SIZE`.
- `src/db/schema.ts`: drop `triage` from the campaigns status enum; drop `triageSize` and `triageTruePositives`; drop `isTriage` from `birdnetValidationSamples`.
- `scripts/push-schema.mjs`: update `CHECK(status IN (...))` and remove the three columns from the two `CREATE TABLE` statements (KTD-2).
- `src/lib/birdnet-validation/fit-eligibility.ts`: drop `isTriage` from the row type and the select; update the header comment listing triage as a consumer.
- `src/app/audio/validacion/restore-status.ts`: the `sampleCount > 0 → "triage"` branch collapses into `"sampled"`.
- `src/app/audio/validacion/labels.ts`: remove the `triage` entries from `STAGE_LABEL`, `STAGE_HINT`, `STAGE_TONE`, `STAGE_FILTERS`; rewrite `STAGE_HINT.draft` — it currently tells the reader to run a triage, and after U1 `draft` means the draw failed.
- Create `scripts/reset-birdnet-validation.mjs`: drops the five `birdnet_validation_*` / `birdnet_species_thresholds` tables so `push-schema.mjs` recreates them (F3, F4). Must write timestamps as Unix **seconds** if it writes any at all.

**Test scenarios**
- `deriveRestoredStatus` returns `sampled` (never `triage`) for a campaign with samples but no reviews; the other branches are unchanged.
- The `labels` totality tests iterate a 7-status list and pass; the "never says campaña" guard still passes.
- `STAGE_TONE.unusable` still contains no red/rose/destructive class (KTD-6).
- A campaign row cannot be inserted with `status = 'triage'` — the `CHECK` rejects it.

**Verification.** `docker compose exec portal node scripts/reset-birdnet-validation.mjs && docker compose exec portal node scripts/push-schema.mjs`, then confirm `PRAGMA table_info(birdnet_validation_samples)` has no `is_triage` and the page loads empty.

---

### U3. Fix the review-screen state bugs and rebuild the end-of-batch screen

**Goal.** The counts are right, "Cargar siguientes" works, and the screen at the end of a batch says what to do next.

**Files**
- `src/app/audio/validacion/[slug]/revisar/review-progress.ts`: add `batchKey(items)`; delete `triageStage` and `TriageFacts`.
- `src/app/audio/validacion/[slug]/revisar/page.tsx`: pass `key={batchKey(items)}` to `<ReviewClient>`; drop the `triageDrawn`/`triageReviewed`/`campaignStatus` props; pass what the new end screen needs (`reviewedByMe`, `sampled`, and whether the caller may edit).
- `src/app/audio/validacion/[slug]/revisar/review-client.tsx`: rebuild the `done` branch (below); remove the `TriageDecision` import and the `isTriage` badge.
- Delete `src/app/audio/validacion/[slug]/revisar/triage-decision.tsx`.
- `src/app/audio/validacion/[slug]/page.tsx`: remove the `triageDecisionDue` block, the `TriageDecision` render and the `triageStage` import.
- `src/app/audio/validacion/[slug]/campaign-controls.tsx`: remove the `triage` action and its "Ejecutar triaje" button.

**The end-of-batch screen.** A heading stating the reviewer's own position (`N de M`), then up to four options, each with one explanatory line:
1. **Cargar las siguientes K** — primary when more clips remain for this reviewer.
2. **Ajustar el modelo** — shown once `reviewedByMe - uncertain >= MIN_REVIEWS_FOR_FIT`; links to the species page, where the fit's chart and threshold have somewhere to land.
3. **Descartar esta especie** — calls `abandonCampaign` with a reason; the line says it stops the work without deleting it and can be undone (KTD-4).
4. **Volver a la especie** — always present.

**Execution note.** Characterization-first. Before changing `review-client.tsx`, write the two failing tests for D1 and D2 against `batchKey` and the count arithmetic, and confirm they fail.

**Test scenarios**
- `batchKey` returns the same value for the same clips, a different value when the batch changes, and a stable constant for an empty batch.
- Answering every clip in a batch and loading the next one puts the reviewer back at clip 1 of the new batch, not on the completion screen (D2).
- After the batch changes, the displayed total equals the server's count — an answer given in the previous batch is counted once, not twice (D1).
- The end screen offers "Ajustar el modelo" at 20 usable reviews and not at 19.
- The end screen offers "Descartar" to an editor and not to a viewer.
- The end screen never offers "Cargar siguientes" when the reviewer has answered every clip in the sample.

**Verification.** Manually review a full 50-clip batch on `localhost:3003` against a species with 200 clips, press "Cargar siguientes", and confirm clip 1 of 50 appears with a correct running total.

---

### U4. Review screen: remove the save note, fix the confidence toggle

**Goal.** Nothing on the screen moves when the toggle is clicked, and the toggle is not wedged into the shortcut row.

**Files**
- `src/app/audio/validacion/[slug]/revisar/review-client.tsx`.

**Approach.** Delete the "Tus respuestas se guardan al instante…" paragraph (R4). Move the checkbox off the shortcut row onto its own right-aligned line (R5). The amber warning must not push content down when it appears — render it in a slot that already occupies its space, or inline beside the checkbox. Check the result at a narrow viewport too; the shortcut row already wraps at the width in the screenshot.

**Test scenarios.** Layout-only; covered by the manual check below rather than by assertions. The keyboard-shortcut resolver is untouched and its existing tests must still pass.

**Verification.** Toggle "Mostrar confianza antes de responder" on `localhost:3003` and confirm no element below it changes position; repeat at ~600 px wide.

---

### U5. Species table: Estado, Progreso, and the redundant button

**Goal.** The table fits without the Estado column stretching it, and every control has a distinct destination.

**Files**
- `src/app/audio/validacion/campaign-table.tsx`: Estado cell renders the pill only, with the reason as its `title`; `Muestra` and `Revisadas` merge into `Progreso` (`84 / 200`, keeping the `(N inc.)` suffix), sorted by `reviewed`; `sampled` leaves `SORTABLE_COLUMNS`; the "Detalle" link is removed and the species-name link gains a `title`; reduce `min-w-[58rem]` to match the narrower table.
- `src/app/audio/validacion/stage-tag.tsx`: accept an optional `title`; keep the pill on one line.
- `src/app/audio/validacion/[slug]/page.tsx`: make sure the unusable reason is visible here, since it no longer renders in the table (KTD-6).

**Test scenarios**
- `sortCampaignRows` orders by `reviewed` for the `progreso` column, with nulls last and the stable `id` tiebreaker intact.
- `SORTABLE_COLUMNS` no longer contains `sampled`; a URL carrying `?sortBy=sampled` falls back to the default sort rather than throwing.
- `filterCampaignRows` is unchanged — the search and status filters keep working, including the accent-insensitive match.
- Sort links still carry `search` and `status` through (the existing regression guard).

**Verification.** `/audio/validacion` at ~1000 px: no horizontal scroll from the Estado column, and a species with an unusable fit shows the reason on hover and on its own page.

---

### U6. xeno-canto links

**Goal.** A reviewer can hear reference recordings for the species they are judging, from either page.

**Files**
- `src/app/audio/validacion/[slug]/page.tsx` — header, beside the stage pill.
- `src/app/audio/validacion/[slug]/revisar/review-client.tsx` — header, beside the scientific name.

**Patterns to follow.** `src/app/audio/species/[slug]/page.tsx:118-140` — same slug construction (`scientificName.trim().replace(/\s+/g, "-")`), same `target="_blank"` + `rel="noopener noreferrer"` + `ExternalLink` icon. Extract the URL builder to a small shared helper rather than writing the third copy.

**Test scenario.** The builder produces `https://xeno-canto.org/species/Ramphastos-ambiguus` for `"Ramphastos ambiguus"`, and collapses double spaces.

**Verification.** Link resolves to a real xeno-canto page for two species with different name shapes.

---

### U7. Documentation

**Goal.** `CLAUDE.md` describes the module that now exists, and records why triage was removed so it is not reintroduced as an optimisation.

**Files** — `CLAUDE.md`, "BirdNET threshold validation" section.

**Changes**
- Delete the "triage clips are ADDITIVE" bullet — no longer true; a species holds exactly its stratified sample.
- Delete the `drawTopScoring` sentence from the stratification bullet; keep the measured per-bin/per-site numbers, which still hold.
- Delete "Applies to triage too" from the queue-order bullet.
- Rewrite the importer bullet with the F1/F2 measurements and `COMMIT_CHUNK_SIZE` 5.
- Rewrite the delete-vs-discard bullet: discard is now also offered at the end of each review batch.
- Add a bullet: the sample is drawn at creation, costs ~2 s, and the cost is flat in species abundance because of the nine-bin floor — so the importer's chunk size is the only lever.
- Add a bullet: triage existed and was removed on 2026-08-10, with the reason (the stage cost more workflow than the shortcut saved) and where its value went (KTD-4).

**Verification.** The claims in the section match the code after U1–U6.

---

## Test Migration

Removing a status and a column breaks tests that assert on both. Handle these inside the unit that breaks them, not as a cleanup pass:

| File | Action |
|---|---|
| `tests/integration/birdnet-triage-decision.test.ts` | Delete |
| `tests/integration/birdnet-campaign-actions.test.ts` | `runTriagePass` → `createCampaign` draws |
| `tests/integration/birdnet-campaign-lifecycle.test.ts` | Same; the delete/restore guards are unaffected |
| `tests/integration/birdnet-multi-reviewer.test.ts` | Same |
| `tests/integration/birdnet-site-coverage.test.ts` | Drop `isTriage` from the sample factory |
| `tests/integration/birdnet-species-import.test.ts` | `triaged` → `drawn`; chunk cap 10 → 5 |
| `tests/helpers/test-db.ts` | Drop `is_triage` from the samples DDL |
| `.../revisar/__tests__/review-progress.test.ts` | Drop the `triageStage` block; add `batchKey` |
| `.../__tests__/labels.test.ts` | 8-status list → 7 |
| `.../__tests__/restore-status.test.ts` | Drop the triage expectation |
| `.../__tests__/campaign-table.test.ts` | Drop triage rows; update for `Progreso` |

---

## Risks

**Losing the cheap exit.** Discovering a hopeless species now costs however many clips the reviewer listens to before giving up, rather than 10. Mitigated by KTD-4 — discard is one click from the end of every batch — but the first batch is 50 clips, not 10. If this bites, the cheapest reintroduction is not the stage but a hint on the species page once the first batch is answered with zero correct.

**A slower "add species".** The dialog goes from instant to ~2 s and a 50-species import from ~10 chunks to ~10 chunks of 5 at ~8 s each (~80 s, versus ~20 s today). The importer's existing per-chunk progress display carries this; the single-species dialog needs a spinner it does not currently have.

**Wiping is irreversible.** F3 and F4 say it costs nothing real, but it does discard 67 test reviews. Take an hourly backup first (see the `db-backup-restore` skill) — the wipe should run against a database that has one.

---

## Scope Boundaries

Not in this change:

- **The sampling design.** Nine bins, 200 clips, the per-bin deployment round-robin and the seed-reproducible order all stay exactly as they are. Only *when* the draw runs changes.
- **The fit, the threshold maths, or `applySpeciesConfidenceFilter`.** Untouched.
- **Blinding.** The score stays hidden until the reviewer answers, `getReviewQueue` still returns no outcome field, and `binIndex` still travels to the client unrendered. The "Mostrar confianza" toggle keeps its warning — U4 changes where it sits, not whether it exists.
- **The multi-reviewer model.** One fit-eligible review per clip via `resolveFitEligibleReviews`, the roster, agreement and the disagreements page are all unchanged.
- **Background-job infrastructure for the importer.** The chunked-request approach stays; F2 keeps the worst-case request where it already was.
- **Renaming `campaign`-prefixed internals.** The UI vocabulary rule (species and stages, never "campaña") is unchanged and its test stays.
- **A Wikipedia link.** xeno-canto only, as asked.

---

## Deferred to Implementation

- Exactly where the confidence-toggle warning sits so nothing reflows (U4) — inline beside the checkbox versus a reserved slot; pick whichever reads better once the deleted paragraph is gone.
- Whether the shared xeno-canto helper lives in `src/lib/species-slug.ts` or a new small module (U6).
- The final `min-w` for the table once a column is gone (U5).
