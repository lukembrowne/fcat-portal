---
title: "feat: Occupancy continuous-effort detection, null model, variant rename, and species-page refinements"
date: 2026-07-14
type: feat
status: planned
depth: standard
---

# feat: Occupancy continuous-effort detection, null model, variant rename, and species-page refinements

## Summary

Five bounded refinements to the occupancy module, driven by reading the run-7 model output for agouti, paca, and ocelot:

1. Rename the `geo` ψ variant to **`gradient`** ("gradiente ambiental") — a clearer name than the opaque `geo`.
2. Replace the **categorical** survey-effort detection covariate (`effort2d`/`effort4d`/`effortfull` dummies) with a **continuous** active-days covariate. The bucketed factor causes complete separation on sparse effort levels in *every* fitted model (e.g. `det:effort4d est=-7, SE=65`).
3. Add sortable **site-level forest cover + elevation** columns to the "Datos de entrada (sitio × ocasión)" table.
4. Fit a **null model (ψ~1)** per species and add it to the AIC comparison so ΔAIC shows whether covariates beat a no-covariate baseline.
5. Move the **"Comparación de modelos"** AIC/ΔAIC table into the **"Para científicos"** section (which today shows only a single AIC even when several models were fit).

Habitat-category collapsing is explicitly **out of scope** (deferred per user decision).

---

## Problem Frame

Run-7 output (post two-variant split) is behaving correctly but exposed three concrete issues and two presentation gaps:

- **Detection separation is universal.** Effort is bucketed into `full`/`1d`/`2d`/`3d`/`4d` levels (`occasions.ts` `effortLevel`) and fed to `occu` as a factor (`config.ts` `obsFactors: ["effort"]`). Sparse levels (few site-occasions land in a "4-day bin") produce complete separation — `est ≈ ±7, SE 60–90` — in agouti, paca, and ocelot alike. This wastes ~3 detection df and injects instability into otherwise-clean models. A single continuous active-days covariate fixes all models at once.
- **"geo" is an opaque internal name** that leaks into logs, DB rows, and conversation. The model is ψ ~ forest cover + elevation — a continuous environmental gradient — best named `gradient`.
- **No baseline for comparison.** The AIC table lists gradient vs. habitat but no ψ~1 null, so a reader can't tell whether the covariates improve on an intercept-only fit (paca's covariates are all non-significant — a null might well win).
- **The input matrix omits the covariate values** that drive ψ, so a reader can't sanity-check the forest/elevation gradient against the detection pattern.
- **"Para científicos" shows a lone AIC** while the multi-model comparison sits in a separate card above it — the scientific detail belongs together.

---

## Requirements

- **R1** — Rename the `geo` variant to `gradient` everywhere it is stored, fit, labeled, or queried; existing stored `geo` rows migrate to `gradient`. User-facing label reads "gradiente ambiental (bosque + elevación)".
- **R2** — Survey effort enters the detection model as a single standardized continuous covariate (active days per occasion), not a categorical factor. The detection block shows one `effort` term with a finite SE instead of per-level dummies.
- **R3** — Effort is still dropped from the detection formula (→ `p~1`) when it does not vary across the frame.
- **R4** — The "Datos de entrada" table gains sortable forest-cover and elevation columns sourced per site, degrading gracefully to "—" when a site's covariate is unresolved.
- **R5** — A null model (ψ~1, sharing the same `p` detection model) is fit per eligible species, persisted as variant `null`, and listed in the AIC comparison with its ΔAIC.
- **R6** — The null model participates in AIC-preferred selection; if it has the lowest AIC, it becomes the preferred model and drives the headline occupancy estimate.
- **R7** — The "Comparación de modelos" AIC/ΔAIC table renders inside the "Para científicos" section; the redundant standalone single-AIC display is removed or subsumed.

---

## Key Technical Decisions

**KTD1 — No table-recreation migration for the rename.** The `variant` column is plain `TEXT NOT NULL DEFAULT 'combined'` with **no SQLite `CHECK` constraint** (verified against `data/portal.db`). The `enum` in `schema.ts` is TypeScript-only. So adding `gradient`/`null` and renaming `geo` needs only: (a) update the TS enum, (b) an idempotent data migration `UPDATE occupancy_models SET variant='gradient' WHERE variant='geo'` in `push-schema.mjs`. This sidesteps the [Drizzle enum vs SQLite CHECK] gotcha entirely — there is no CHECK to recreate.

**KTD2 — Effort becomes an observation-level continuous covariate.** `frame.effort` changes from `(string|null)[][]` (bucketed labels) to `(number|null)[][]` (active-day counts per site×occasion). `config.ts` passes it via `obsCovs: { effort: <matrix> }` with `obsFactors: []`, standardized (mean/sd over non-null cells) and recorded in `standardizations` so the R runner relabels the coefficient in raw day units. The "effort varies" gate switches from `factorLevels(...).size >= 2` to "≥2 distinct finite values".

**KTD3 — The null model reuses the existing `fitVariant` machinery with empty covariates.** Calling `fitVariant("null", frame, sp, stream, [], [])` yields `psiFormula = "~1"` via `assembleRunConfig`, sharing the same continuous-effort `p` model. No map/curve/bar artifacts are written for `null` (no covariates to plot); it persists a model row + intercept effect + AIC only.

**KTD4 — `null` is a first-class AIC competitor.** It joins the `preferredByAic` pool alongside `gradient`/`habitat`. If `null` wins, the headline estimate is the intercept-only ψ (a valid occupancy estimate), and the page labels it preferred. The map/response-curve visuals still render from the `gradient` variant when present, with the existing "preferred variant" labeling making clear whether gradient was actually preferred.

**Model set (per eligible species, per stream):**

| Variant (code) | ψ formula | Drives on page | In AIC table | Preferred-eligible |
|---|---|---|---|---|
| `gradient` | ~forest + elevation | map surface, response curves, forest-plot slopes | yes | yes |
| `habitat` | ~habitat | habitat-use bars | yes | yes |
| `null` | ~1 | (nothing — baseline only) | yes | yes |
| `combined` (legacy) | ~forest+elevation+habitat | — | only for ineligible-species placeholder rows | no |

All three fitted variants share `p ~ effort` (continuous).

---

## Implementation Units

### U1. Rename the `geo` variant to `gradient`

**Goal:** Replace the opaque `geo` identifier with `gradient` across schema, fit, persistence, query, and UI, migrating existing rows.

**Requirements:** R1

**Dependencies:** none

**Files:**
- `src/db/schema.ts` — `occupancyModels.variant` enum `["geo","habitat","combined"]` → `["gradient","habitat","combined","null"]` (add `null` here now so U4 needs no further schema touch); update the explanatory comment.
- `scripts/push-schema.mjs` — add idempotent migration `UPDATE occupancy_models SET variant='gradient' WHERE variant='geo'` in the try/catch migration array. No column/CHECK change.
- `src/lib/occupancy/build-run.ts` — `fitVariant("geo", …)` → `fitVariant("gradient", …)`; the `variant === "geo"` gridSpecs guard → `"gradient"`; `writeGridArtifact` variant param/slug; local `geoSpecs`/`geoDropped`/`geoDroppedNames` naming (cosmetic, keep consistent).
- `src/app/ocupacion/actions.ts` — `VARIANT_LABEL`/label helper `geo` → `gradient` ("gradiente ambiental (bosque + elevación)"); `geoRow`/`geoV` references; the map/curves source variant string; legacy fallback still recognizes `combined`.
- `src/app/ocupacion/[slug]/page.tsx` — `VARIANT_LABEL` map entry; any `"geo"` literal.
- `tests/helpers/test-db.ts` — no change needed (no CHECK); confirm default still `'combined'`.
- `tests/unit/occupancy-build-run.test.ts` — update assertions that fitted variant is `geo` → `gradient`.

**Approach:** Pure rename + one data migration. Because there is no CHECK constraint (KTD1), the migration is a single idempotent UPDATE. Keep `combined` in the enum for legacy/ineligible rows.

**Patterns to follow:** existing idempotent migrations in `scripts/push-schema.mjs`; the `VARIANT_LABEL` map already in `page.tsx`.

**Test scenarios:**
- `occupancy-build-run.test.ts`: fitted eligible species produce variant `gradient` (never `geo`); habitat variant still `habitat`.
- Migration idempotency: running the `UPDATE geo→gradient` twice leaves rows as `gradient` and affects zero `habitat`/`combined` rows. (Assert via a lightweight DB-copy check or a targeted unit around the migration SQL string.)
- Label mapping: `gradient` → "gradiente ambiental (bosque + elevación)".

**Verification:** After migration, no `occupancy_models.variant = 'geo'` rows remain; species page renders "gradiente ambiental" where it previously said the bosque+elevación label; `tsc`/`eslint` clean.

---

### U2. Continuous survey-effort detection covariate

**Goal:** Fit `p ~ effort` with effort as a standardized continuous active-days covariate, eliminating per-level separation.

**Requirements:** R2, R3

**Dependencies:** U1 (shared edits in `build-run.ts`/`config.ts`; sequence after to avoid churn)

**Files:**
- `src/lib/occupancy/detection-history.ts` — `effort` matrix becomes numeric: `effortRow[j] = layout.nDays[j]` instead of `effortLevel(...)`; type `(number|null)[][]`; drop the `effortLevel` import.
- `src/lib/occupancy/config.ts` — gate `useEffort` on ≥2 distinct finite effort values (not `factorLevels`); pass `obsCovs: { effort }` + `obsFactors: []`; standardize effort (mean/sd over non-null) and add to `standardizations` (raw-unit label "días"); keep `detFormula = "~effort"` / `"~1"`.
- `src/lib/occupancy/occasions.ts` — `effortLevel` may become unused; remove it and its test if no other caller (confirm via grep) — otherwise leave and mark deprecated.
- **R runner** (the occu-invoking script that assembles `obsCovs`/`obsFactors` into the `p` formula — locate under `src/lib/occupancy/` R assets or the embedded R string) — ensure `effort` is passed to `unmarkedFrameOccu` `obsCovs` as numeric and referenced in `~effort`; verify no residual factor coercion. **This is the highest-risk edit — verify the R side explicitly.**
- `src/lib/occupancy/config.ts` types + any `EffortMatrix`/`obsCovs` typing.
- `tests/unit/occupancy-build-run.test.ts` / `tests/unit/occupancy-config.test.ts` (whichever covers detection assembly).

**Approach:** Effort day-counts already exist per occasion in the `OccasionLayout` (`layout.nDays[j]`); the change is to stop bucketing them. Standardization mirrors the continuous site-covariate path (forest/elevation) so the coefficient is on a sane z-scale and relabels to raw days.

**Execution note:** Characterization-first on the R runner — capture the current `p~effort` factor formula the runner emits before switching to numeric, so the numeric path is a deliberate diff.

**Patterns to follow:** continuous site-covariate standardization in `config.ts` (`standardizations` for forest/elevation); the existing `obsCovs`/`obsFactors` plumbing.

**Test scenarios:**
- `config.ts`: a frame with varying `nDays` yields `obsCovs.effort` (numeric matrix) + `detFormula === "~effort"` + an `effort` standardization entry; `obsFactors` is empty.
- `config.ts`: a frame with constant effort (all-full bins) drops effort → `detFormula === "~1"` and records the dropped reason.
- `detection-history.ts`: `frame.effort[i][j]` equals the occasion's active-day count (number), `null` outside the site window.
- Integration (real-R, existing build-run integration test): on the synthetic frame with varying effort, the det block has a **single** `effort` coefficient with a finite SE — assert no `effort2d`/`effort4d`/`effortfull` terms exist and the effort SE is finite (< some bound, e.g. 50).

**Verification:** A fresh batch on the dev clone shows one finite `p:effort` term per model (no separated per-level dummies); agouti/paca detection SEs are finite; `tsc`/`eslint`/vitest clean.

---

### U3. Site-level forest cover + elevation columns in the input table

**Goal:** Show and sort each site's forest cover and elevation alongside the detection matrix.

**Requirements:** R4

**Dependencies:** none (independent of U1/U2)

**Files:**
- `src/app/ocupacion/actions.ts` — in `getModelInputSample`, join `occupancy_site_covariates` for the latest run + stream by `site_id`, attaching `forestCover` + `elevation` to each `DetectionSampleRow`; extend the `DetectionSampleRow`/`ModelInputSample` row type.
- `src/app/ocupacion/detection-sample-table.tsx` — add two sortable columns (`forestCover`, `elevation`) to `SortKey`, `DEFAULT_DIR` (numeric → `desc`), the `<SortableTh>` header row, and the body cells; render forest as a percentage (e.g. `74%`) and elevation as metres (`m`), with `—` for `null`.
- `tests/unit/occupancy-actions.test.ts` or the input-sample test (locate existing coverage for `getModelInputSample`).

**Approach:** `occupancy_site_covariates` already stores `site_id`, `forest_cover`, `elevation`, `habitat` per run (verified). Build a `Map<siteId, {forestCover, elevation}>` from the latest run and look up each sample row. Sites present in the live cohort but missing a covariate row → `null` → "—".

**Patterns to follow:** the existing sortable-column pattern in `detection-sample-table.tsx` (`SortableTh`, `DEFAULT_DIR`, `useState` sort); the run-scoped query pattern in `actions.ts` (`latestCompletedRunId`, `eq(...runId)`).

**Test scenarios:**
- `getModelInputSample` rows carry `forestCover`/`elevation` from the matching `occupancy_site_covariates` row; a site with no covariate row yields `null` for both.
- Table sorts ascending and descending by forest cover and by elevation, with `null` rows ordered last (or consistently) in both directions.
- Rendering: a `0.74` forest value displays as `74%`; `null` displays as `—`.

**Verification:** The "Datos de entrada" table shows forest + elevation columns, both sortable, values matching the stored site covariates; no layout overflow in the wide matrix (test in full page context per UI convention).

---

### U4. Null model (ψ~1) in the fit and the AIC comparison

**Goal:** Fit an intercept-only occupancy model per eligible species and surface it in the AIC comparison and preferred-model selection.

**Requirements:** R5, R6

**Dependencies:** U1 (enum already includes `null`), U2 (null shares the continuous-effort `p` model)

**Files:**
- `src/lib/occupancy/build-run.ts` — after the gradient/habitat fits, call `fitVariant("null", frame, sp, stream, [], [])` for eligible species; guard `writeGridArtifact`/pred/curve writes so `null` writes none (empty covariates → nothing to plot). Increment `nModels`.
- `src/app/ocupacion/actions.ts` — `getSpeciesModel`: fetch the `null` variant row; include it in the `identifiable` pool passed to `preferredByAic`; add it to the `variants` summary (VariantSummary with ΔAIC); ensure headline uses `preferred` (which may now be `null`). `getCrossSpeciesData`: null rows must **not** contribute forest/habitat slopes to the synthesis (they have none) — confirm the existing `sufficientData`/variant filters already exclude them, add a variant guard if needed.
- `src/app/ocupacion/[slug]/page.tsx` — `VARIANT_LABEL` entry `null` → "nulo (ψ~1)"; the AIC table already iterates identifiable variants, so `null` appears once included; when `preferred === null`, the map/curve section shows the gradient surface with the existing "no fue el preferido" labeling.
- `tests/unit/occupancy-build-run.test.ts`, `tests/unit/occupancy-cross-species.test.ts`.

**Approach:** `fitVariant` already derives `psiFormula` from the covariate specs via `assembleRunConfig`; passing empty specs gives `~1`. The null row stores `estimated_occupancy`/`aic`/intercept effect like any fit but skips artifacts. `preferredByAic` is variant-agnostic and needs no change beyond being fed the null row.

**Test scenarios:**
- `build-run`: an eligible species produces exactly one `null` variant row with `psi_formula = "~1"`, `sufficient_data = 1` on convergence, a persisted AIC, and **no** grid/prediction artifacts.
- `build-run`: an ineligible species does **not** get a `null` fit (still one `combined` placeholder).
- `getSpeciesModel`: the `variants` summary includes `null` with a correct ΔAIC relative to the min-AIC model; when `null` has the lowest AIC it is the preferred variant and the headline occupancy equals the null model's estimate.
- `getCrossSpeciesData`: null rows contribute no forest/elevation/habitat slopes and don't double-count in the occupancy synthesis.

**Verification:** After a fresh batch, each eligible species has a `null` row; the species-page AIC table lists gradient/habitat/null with ΔAIC; paca (all-nonsignificant covariates) plausibly shows null competitive; `tsc`/`eslint`/vitest clean.

---

### U5. Move "Comparación de modelos" into "Para científicos"

**Goal:** Consolidate the multi-model AIC/ΔAIC table into the scientific-detail section and drop the redundant lone-AIC display.

**Requirements:** R7

**Dependencies:** U4 (the table now includes the null row)

**Files:**
- `src/app/ocupacion/[slug]/page.tsx` — relocate the "Comparación de modelos" Card into the "Para científicos" section (near the coefficient table / stats grid); remove or subsume the standalone single-AIC stat now that the full comparison lives there. Preserve the "preferido" marking and the degenerate-variant reason list.

**Approach:** Pure JSX relocation within one file — no data-layer change. Keep the existing card contents; change only placement and remove the now-duplicated single AIC.

**Test scenarios:** Test expectation: none — layout-only move within a Server Component. Covered by manual/visual verification.

**Verification:** The AIC comparison renders inside "Para científicos"; the section no longer shows a lone AIC divorced from the multi-model table; no empty space or duplicated AIC; verified in full page context (UI convention).

---

## Scope Boundaries

**In scope:** the five units above.

**Out of scope / deferred:**
- **Collapsing habitat categories** (7 levels → Forest/Cacao/Open) — deferred per user decision; the habitat variant keeps its current 7-level factor.
- **Tiered model policy by detection count** (ψ~1 fallback for sub-threshold species that currently get *no* fit) — the null model here is added for *eligible* species; extending a ψ~1 fallback to *ineligible* sparse species (e.g. ocelot) is a separate follow-up.
- **Dropping elevation** from the gradient variant — noted as low-value in analysis but retained.

### Deferred to Follow-Up Work
- ψ~1 fallback for ineligible/sparse species (recover a baseline occupancy number for ocelot-like species instead of no estimate).
- Habitat-category collapse as a fairer gradient-vs-habitat contest.

---

## Risks & Dependencies

- **R runner is the riskiest surface (U2).** Switching effort from factor to numeric `obsCov` must be reflected in the R-side frame assembly and formula. If the runner coerces `obsCovs` to factors or the formula still expects level dummies, the fit breaks. Mitigation: characterization-first (capture the current emitted formula), and a real-R integration assertion that the det block has a single finite `effort` coefficient.
- **Re-fit required to see effects.** U1/U2/U4 only change future runs (plus the U1 data migration for the rename). A fresh batch on the dev clone is the real end-to-end verification — the synthetic-seed integration test exercises the gradient path but not habitat/real data.
- **Null-preferred edge case (U4/U5).** When `null` wins AIC, the page must not imply the gradient map is the "preferred" model. The existing preferred-variant labeling handles this, but verify the map section copy when `preferred === null`.
- **Sequencing.** U1, U2, U4 all edit `build-run.ts`; U1, U3, U4, U5 all edit `actions.ts`/`page.tsx`. Execute serially in the order U1 → U2 → U3 → U4 → U5 to avoid churn; U3 is independent and can slot anywhere.

---

## Verification Strategy

1. `npx tsc --noEmit`, `npx eslint` on changed files, `npx vitest run` (including the real-R build-run integration test) — all green.
2. Migration: confirm zero `variant='geo'` rows remain and `habitat`/`combined` untouched.
3. Live batch on the prod-clone dev DB (container up → trigger the occupancy batch), then load:
   - `Cuniculus paca?stream=camera` — AIC table shows gradient/habitat/**null** with ΔAIC; detection block has a single finite `effort` term; input table shows forest/elevation columns, sortable.
   - `Leopardus pardalis?stream=camera` — still "ningún modelo identificable" (or null baseline if a null fallback is later added — not this scope).
   - `Dasyprocta punctata?stream=camera` — gradient preferred, "Comparación de modelos" now inside "Para científicos".
