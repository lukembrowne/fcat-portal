---
title: "feat: Split occupancy models (geo vs habitat) + post-fit degeneracy guard"
type: feat
status: ready
date: 2026-07-13
origin: docs/brainstorms/2026-07-03-occupancy-modeling-requirements.md
related_plans:
  - docs/plans/2026-07-06-001-feat-occupancy-modeling-pipeline-plan.md
  - docs/plans/2026-07-13-001-fix-occupancy-covariates-and-matrix-diagnostics-plan.md
depth: standard
---

# feat: Split occupancy models (geo vs habitat) + post-fit degeneracy guard

## Summary

Today the pipeline fits **one** ψ model per species × stream — `ψ ~ forest + elevation + habitat`, `p ~ effort` — and it collapses. Forest cover and categorical habitat are near-redundant (both encode the same forest gradient), so the continuous forest slope flips sign against the habitat factor (multicollinearity), and for sparse species every parameter runs off to ±∞ (complete separation) while the model is still stored as a "successful" fit with a confident occupancy estimate.

This plan **splits the single ψ model into two** per species × stream, sharing the same detection model:

- **`geo`** — `ψ ~ forest + elevation`, `p ~ effort`. Drives the **ψ map surface**, the **forest/elevation response curves**, and the cross-species **forest/elevation forest-plot** slopes.
- **`habitat`** — `ψ ~ habitat`, `p ~ effort`. Drives the **habitat-use bar chart**.

Each visualization is now driven by a model that can actually identify it. **AIC** picks a *preferred* variant per species (shown with ΔAIC). A **post-fit degeneracy guard** marks a fully non-identifiable model (all/most coefficients separated) as `sufficientData = false` with a Spanish reason, and the cross-species **synthesis** (forest plot + occupancy plot) excludes it — no more ±20 slopes or phantom "26%" estimates polluting the aggregate.

Scope: the occupancy build pipeline (`src/lib/occupancy/**`), one schema column + index swap, the cross-species synthesis action, and the species-page UI. No new R modeling code — the split is orchestrated in TypeScript by calling the existing runner twice.

---

## Problem Frame

From two production-clone fits (2026-07-13):

- **Paca (`Dasyprocta punctata`, 16 detected sites):** `forest = −0.676` — a forest species with a *negative* forest slope. Not biology: the habitat factor (reference = Bosque Primario, the highest level) already encodes the forest gradient, so the continuous forest term fits residual noise and flips. Every coefficient is non-significant; occupancy CI is 12–86% (nearly the whole range). Three habitat/effort levels report "no estimable — separación."
- **Ocelot (`Leopardus pardalis`, 4 detected sites):** *every* coefficient is "no estimable — separación" — the 13-parameter model is completely unidentified. Yet the page shows "Convergencia: sí", "Ocupación estimada: 26%" (naive 9%), "p = 0.05". The 26% is a pure artifact of an unfounded p driven by 10 detections; the habitat bar even shows Bosque Primario = 0% because the 4 detections happened to land in secondary/reforestation. A reader has no signal that nothing was estimable.

Root causes:

1. **One over-specified model.** `ψ ~ forest + elevation + habitat` puts two redundant forest-gradient axes in the same design (`src/lib/occupancy/build-run.ts` fit loop, `src/lib/occupancy/config.ts` `assembleRunConfig`), producing collinearity for data-rich species and separation for data-thin ones.
2. **Degeneracy is display-only, never a model-level fact.** `src/lib/occupancy/separation.ts` `isSeparated(estimate, se)` is applied per-coefficient at render time in `src/app/ocupacion/[slug]/page.tsx`. It is not stored, not a model flag, and does not gate the synthesis. A model where *all* coefficients separate is still stored `sufficientData = 1` with fitted outputs.
3. **Synthesis ingests degenerate slopes.** `getCrossSpeciesData` (`src/app/ocupacion/actions.ts:584-603`) builds `forestRows`/`elevRows` from `slopeRows`, which joins covariate effects for the run **without filtering `sufficientData`** — so a separated ±20 forest slope pollutes the cross-species forest plot. (`overallPlot` at `actions.ts:654-675` *is* filtered on `sufficientData = true`, but would now double-count two variants per species.)

The outcome we want: each species page shows a geo model and a habitat model, each answering the question it can; a preferred model is named by AIC; a model that couldn't be identified is labeled as such and left out of the aggregate rather than presented as a real estimate.

---

## Key Technical Decisions

- **KTD-1 — Two variants per species × stream, stored side-by-side; AIC picks the preferred.** Add a `variant` discriminator (`'geo' | 'habitat'`, plus legacy `'combined'`) to `occupancy_models`. Both variants share the same detection history `y` and the same `p ~ effort` detection formula (so their AICs are comparable — same data, same likelihood structure, differing only in the ψ covariates). "Preferred" = the identifiable variant with the lower AIC; ΔAIC = `aic − min(aic over identifiable variants)`. Preferred/ΔAIC are computed at **read time** from the two rows' AICs — no extra stored column. *(User choice: "Store both, AIC picks preferred.")*
- **KTD-2 — Each variant drives the visualization it can identify.** `geo` writes the ψ map surface (`occupancy_predictions`), the forest/elevation response curves, and the forest/elevation forest-plot slopes. `habitat` writes the habitat-use bars. The species-page header shows the AIC-preferred variant's occupancy estimate. This is a natural fit — the ψ raster is only mappable from continuous forest/elevation, and the habitat bars only come from the categorical factor; today's single model tried to source all three and collapsed.
- **KTD-3 — Post-fit degeneracy guard, not pre-fit.** After each variant fits, a model-level classifier (`src/lib/occupancy/separation.ts`) decides identifiability from the returned coefficients: degenerate if the state **intercept** is separated, or **all** non-intercept state coefficients are separated (the ocelot case). A degenerate variant is stored `sufficientData = false` with a Spanish reason (`"modelo no identificable: separación en todos los términos"`), fitted outputs nulled, and no prediction/curve artifacts written — the same treatment ineligible species already get. *(User choice: "Post-fit guard only." A pre-fit design-matrix gate was considered and deferred — see Alternatives.)*
- **KTD-4 — Synthesis excludes degenerate models and dedupes to the preferred variant.** `getCrossSpeciesData` gains a `sufficientData = true` filter on `slopeRows` (plus a per-coefficient `isSeparated` skip as a finer backstop, so a *kept* model's single separated habitat level can't inject a ±20 slope), and `overallPlot` dedupes to one row per species — the AIC-preferred variant — so no species is counted twice.
- **KTD-5 — Migration is additive; legacy rows are never displayed.** `ALTER TABLE occupancy_models ADD COLUMN variant TEXT NOT NULL DEFAULT 'combined'`, then drop and recreate the unique index as `(run_id, species, stream, variant)`. No full table recreation and **no DB-level CHECK** on `variant` — the Drizzle `text({ enum })` guards values in app code (per the enum/CHECK gotcha: a DB CHECK would force a table-recreation migration). Legacy rows keep `variant = 'combined'`; the page reads only the latest completed run, so once a post-migration run completes, everything it shows is `geo`/`habitat`.

---

## High-Level Technical Design

Per species × stream, the build loop forks the one fit into two, guards each, and persists both:

```
                         detection frame (y, effort)  ── shared ──┐
                                                                  │
   site covariates ──┬─ [forest, elevation] ─► assembleRunConfig ─┼─► runOccupancyModel ─► geo result
                     │                          (ψ~forest+elev)   │      │
                     │                          + AOI grid        │      ├─ classifyIdentifiability(effects)
                     │                                            │      │     ├─ degenerate ─► store sufficientData=false + reason (no artifacts)
                     │                                            │      │     └─ ok ─► store geo row + prediction(map) + curves
                     │                                            │
                     └─ [habitat] ────────────► assembleRunConfig ┴─► runOccupancyModel ─► habitat result
                                                (ψ~habitat)               │
                                                                          ├─ classifyIdentifiability(effects)
                                                                          │     ├─ degenerate ─► store sufficientData=false + reason
                                                                          │     └─ ok ─► store habitat row + habitatUse bars
                                                                          ▼
   read time:  preferred = argmin AIC over identifiable variants;  ΔAIC per variant
               synthesis: forest/elev slopes ← geo (identifiable, non-separated); overallPlot ← preferred variant only
```

*Directional guidance, not implementation specification.* Both variants reuse the shared detection frame and site-covariate snapshot; only the ψ covariate subset and the grid (geo only) differ.

---

## Implementation Units

### U1. Add `variant` column + index swap to `occupancy_models`

**Goal:** Persist two model variants per species × stream without collision.

**Requirements:** Enables KTD-1, KTD-5.

**Dependencies:** none.

**Files:**
- `src/db/schema.ts` — add `variant: text("variant", { enum: ["geo", "habitat", "combined"] }).notNull().default("combined")`; change `uniqueIndex("idx_occupancy_models_run_species_stream")` to also key on `table.variant`.
- `scripts/push-schema.mjs` — idempotent migration: `ALTER TABLE occupancy_models ADD COLUMN variant TEXT NOT NULL DEFAULT 'combined'` guarded by a `PRAGMA table_info` check; `DROP INDEX IF EXISTS idx_occupancy_models_run_species_stream` then `CREATE UNIQUE INDEX ... ON occupancy_models(run_id, species, stream, variant)`.
- `scripts/seed-occupancy-dev.ts` — no change needed unless it hardcodes the insert column list (verify).

**Approach:** Additive column, no table recreation, no DB CHECK (Drizzle enum guards values — see the `text({ enum })` gotcha). Index recreation is safe on a live SQLite DB (indexes are independent objects).

**Patterns to follow:** existing `ALTER TABLE ... ADD COLUMN` idempotency guards in `scripts/push-schema.mjs`; the enum/CHECK gotcha in `docs/solutions/`.

**Test scenarios:**
- Running `push-schema.mjs` twice is idempotent — second run adds nothing, throws nothing. *(Covers KTD-5.)*
- After migration, two rows with the same `(run_id, species, stream)` but different `variant` insert without a uniqueness violation; two rows with the *same* variant collide.
- Existing pre-migration rows read back with `variant = 'combined'`.

**Verification:** `node scripts/push-schema.mjs` run against a copy of the dev DB adds the column + index; `npm run test:run` schema/DDL-dependent occupancy tests pass with the new column.

---

### U2. Fit both variants in the build loop

**Goal:** Replace the single combined fit with a geo fit and a habitat fit per species, sharing the detection model.

**Requirements:** KTD-1, KTD-2.

**Dependencies:** U1.

**Files:**
- `src/lib/occupancy/build-run.ts` — in the per-species loop (currently ~`build-run.ts:259-344`), partition the resolved covariate specs into a geo subset (`forest`, `elevation` — continuous, with grid specs) and a habitat subset (`habitat` — factor, no grid); call `assembleRunConfig` + `runOccupancyModel` once per subset; persist a row per variant with the new `variant` value. Only the geo variant collects `renderModels`/`pendingPreds` (the map surface) and writes `writeGridArtifact`; only the habitat variant's `habitatUse` is meaningful.
- `src/lib/occupancy/build-run.ts` — extend `insModel` call sites to pass `variant`.

**Approach:** The detection frame (`y`, `effort`) and the per-stream site-covariate snapshot are built once and shared by both configs. Each variant independently runs the existing covariate-drop logic in `assembleRunConfig` (a variant whose covariates all drop collapses to `ψ~1`, which the U3 guard/eligibility handles). `curves` come back only for the geo variant (continuous covariates); `habitatUse` only for the habitat variant. Progress ticks (`onProgress`) should count variants so `X de Y` stays monotonic and the total reflects the doubled model count.

**Execution note:** Characterize the current single-fit persistence with a test before splitting — the row-count and artifact-write expectations change.

**Patterns to follow:** the existing fit loop and `writeGridArtifact`/`renderModels` collection in `build-run.ts`; `assembleRunConfig` covariate partitioning in `config.ts`.

**Test scenarios:**
- A species eligible for both variants produces exactly two `occupancy_models` rows (`geo`, `habitat`) with the shared `n_sites`/`total_detections` but distinct `psi_formula` (`~forest + elevation` vs `~habitat`) and distinct AIC.
- The geo variant writes one `occupancy_predictions` row + curve artifacts; the habitat variant writes none.
- The habitat variant's stored effects include `habitat*` params; the geo variant's include `forest`/`elevation`.
- `total_models`/progress total equals `2 × eligible species` (+ ineligible rows) — `onProgress` counter stays monotonic.
- A species where habitat has <2 levels: the habitat variant collapses to `~1` and is handled (not a crash); the geo variant still fits normally.

**Verification:** A dev-DB batch run produces paired geo/habitat rows; the species page (U5) can read both; Docker logs show two fits per eligible species.

---

### U3. Post-fit model-level degeneracy guard

**Goal:** Detect a non-identifiable variant from its returned coefficients and store it as insufficient rather than a confident estimate.

**Requirements:** KTD-3.

**Dependencies:** U2.

**Files:**
- `src/lib/occupancy/separation.ts` — add `classifyModelIdentifiability(effects: {param,estimate,se}[]): { identifiable: boolean; reason?: string }`. Reuse `isSeparated`. Degenerate when the state **intercept** (`Int`/`(Intercept)`) is separated, or every non-intercept **state** coefficient is separated.
- `src/lib/occupancy/build-run.ts` — after each successful `runOccupancyModel`, call the classifier; if degenerate, persist the row with `sufficientData = false`, `ineligibleReasonsJson = ["modelo no identificable: …"]`, fitted outputs (`estimatedOccupancy`, bounds, `meanDetection`, effects) nulled/skipped, and **no** prediction/curve artifacts. Keep the diagnostic fields (`nSites`, `nSitesDetected`, `totalDetections`, `nOccasions`, `naiveOccupancy`, `aic`, `psiFormula`) so the page can still explain what was attempted.

**Approach:** Mirror the existing ineligible-species persistence branch (`build-run.ts:268-277`) — same `sufficientData = false` shape, different reason. The guard runs per variant, so a species can have an identifiable geo model and a degenerate habitat model (or vice versa).

**Test scenarios:**
- `classifyModelIdentifiability` returns `identifiable: false` when the intercept SE is NaN/∞ (ocelot case) and when all non-intercept state coefficients are ±20.
- Returns `identifiable: true` when the intercept and ≥1 state slope are finite/normal, even if one habitat level is separated (paca case).
- Returns `identifiable: true` for a clean `~1` intercept-only fit with a finite intercept (a reduced-but-estimable model is not "degenerate").
- A degenerate variant is persisted with `sufficientData = false`, a Spanish reason, null `estimatedOccupancy`, and no `occupancy_predictions` row.
- Edge: empty effects array → `identifiable: false` with a reason (defensive).

**Verification:** Re-running the batch on the ocelot data yields a habitat (and likely geo) variant stored `sufficientData = false` with a "no identificable" reason; the species page shows the insufficient state instead of "26% · convergencia sí".

---

### U4. Exclude degenerate models + dedupe the cross-species synthesis

**Goal:** Keep non-identifiable models and double-counted variants out of the forest plot and the occupancy plot.

**Requirements:** KTD-4.

**Dependencies:** U3.

**Files:**
- `src/app/ocupacion/actions.ts` — in `getCrossSpeciesData` (`~584-690`): add `eq(occupancyModels.sufficientData, true)` to the `slopeRows` join; when building `forestRows`/`elevRows`, skip coefficients where `isSeparated(estimate, se)` (finer backstop). Change `overallPlot` (`654-675`) to select the AIC-**preferred** identifiable variant per species (group by `species+stream`, pick `min(aic)`), so a species contributes one row, not two.
- `src/app/ocupacion/actions.ts` — `nSpeciesModeled` counts distinct species (preferred variants), not model rows.

**Approach:** `forestRows`/`elevRows` naturally come only from the geo variant (only it carries `forest`/`elevation` effects), so the main synthesis change is the `sufficientData` filter + per-coefficient `isSeparated` skip. `overallPlot` is the double-count risk — dedupe there.

**Patterns to follow:** the existing `sufficientData = true` filter already used for `overallPlot` at `actions.ts:663`; `isSeparated` usage in `[slug]/page.tsx`.

**Test scenarios:**
- A run with a degenerate geo model: its `forest` slope does **not** appear in `forestPlot`; a separated habitat level in a *kept* model does not appear in any plot.
- `overallPlot` lists each species once — the AIC-preferred variant — even though two `sufficientData = true` variants exist.
- `nSpeciesModeled` equals distinct species count, not row count.
- A run where a species has one identifiable and one degenerate variant: the identifiable one is the preferred/plotted one.

**Verification:** On the dev-DB run, `/ocupacion` cross-species forest plot shows no ±20 outliers and lists each species once; ocelot is absent from the occupancy plot.

---

### U5. Species page: render both variants + AIC comparison

**Goal:** Show the geo model (map, curves, forest/elevation table), the habitat model (bars), a preferred/ΔAIC header, and the insufficient state when a variant is degenerate.

**Requirements:** KTD-1, KTD-2, KTD-3.

**Dependencies:** U3.

**Files:**
- `src/app/ocupacion/actions.ts` — `getSpeciesModel` returns **both** variants (or the available subset) for a species × stream, each with its AIC, effects, prediction/curves (geo) or habitatUse (habitat), `sufficientData`, and reasons. Compute preferred + ΔAIC.
- `src/app/ocupacion/[slug]/page.tsx` — source the ψ map + forest/elevation response curves + the forest/elevation coefficient table from the **geo** variant; source the habitat-use bars from the **habitat** variant; render a comparison header (preferred variant's occupancy estimate + both AICs + ΔAIC). When a variant is degenerate, render its section as "no identificable — datos insuficientes" with the Spanish reason instead of numbers. Preserve the existing "Modelo ajustado el …" fit-date subtitle.
- `src/app/ocupacion/[slug]/page.tsx` — handle legacy `variant = 'combined'` rows via the existing single-model rendering path (defensive; latest-run data won't contain them post-migration).

**Approach:** The page already renders a map, curves, habitat bars, and a coefficient table from one model — this unit re-sources each section from the correct variant and adds the comparison header. Keep the "Para científicos" table but split it by submodel/variant so a reader sees which model each coefficient came from.

**Patterns to follow:** existing section rendering + `isSeparated` display in `[slug]/page.tsx`; the fit-date subtitle already added.

**Test scenarios:**
- *(Component/action-level)* `getSpeciesModel` for a species with both variants returns geo (with prediction + curves) and habitat (with bars) and marks the lower-AIC one preferred with the correct ΔAIC.
- A species with only an identifiable geo variant (habitat degenerate) renders the map + curves and a "no identificable" habitat section — no crash, no missing-data throw.
- The header occupancy estimate matches the preferred variant's `estimatedOccupancy`.
- Legacy `combined`-only species (historical run) still renders via the fallback path.

**Verification:** `/ocupacion/Dasyprocta%20punctata?stream=camera` shows a geo map + forest/elevation curves, a habitat-use bar chart, and a "preferido: geo (ΔAIC …)" header; `/ocupacion/Leopardus%20pardalis?stream=camera` shows the insufficient state for the degenerate variant(s). No layout regressions (verify per UI conventions).

---

## Scope Boundaries

**In scope:** the two-variant split, the AIC-preferred comparison, the post-fit degeneracy guard, synthesis exclusion/dedup, the species-page rework, and the additive migration.

### Deferred to Follow-Up Work

- **Pre-fit identifiability gate** (design-matrix DoF: ψ params ≤ detected sites − 1; per-habitat-level detection presence). Considered this session; deferred per the "post-fit guard only" choice. Would save doomed fits but adds a second gate to reason about — revisit if double-fitting proves too slow.
- **Formal model selection beyond AIC** (AIC weights, model averaging, cross-validation). The ΔAIC comparison here is descriptive, matching the existing `meta-analysis.ts` "descriptive, not a formal random-effects model" posture.
- **A third `combined` variant** as an intentional model (rather than legacy tag). Not fit; the whole point is to stop fitting it.

### Non-Goals

- Changing the eligibility thresholds (`eligibility.ts`) or the detection model (`p ~ effort` stays).
- Any change to the raster/DEM covariate pipeline or the ODK habitat resolution (owned by the covariate-transparency plan, `docs/plans/2026-07-13-001-fix-occupancy-covariates-and-matrix-diagnostics-plan.md`).

---

## Alternatives Considered

- **Pre-fit design-matrix gate instead of a post-fit guard.** Cheaper (skips doomed fits) and was the user's initial instinct, but the user chose post-fit-only: it reasons over the *actual* fit rather than a heuristic, and reuses the existing `isSeparated` logic. Deferred, not rejected.
- **Keep one combined model but regularize it** (penalized/Bayesian occupancy to tame separation). `unmarked::occu` has no first-class penalization; would mean a different fitting engine — disproportionate to the goal.
- **Fit both, keep only the AIC-best.** Simpler (no schema change) but loses the always-mappable geo surface whenever habitat wins on AIC, and can't show map + habitat bars together. Rejected in favor of storing both (user choice).

---

## Risks & Dependencies

- **AIC comparability.** Valid here because both variants share the same `y` and the same `p ~ effort` detection model — they differ only in the ψ covariates, so AIC compares like-for-like. Document this in the header/tooltip so ΔAIC isn't over-read.
- **Doubled fit count.** ~2× `runOccupancyModel` invocations per eligible species (each ~0.5 s). Batch wall-time roughly doubles but stays minutes-scale; the progress bar (now fixed) reflects the higher total. Note in Docker logging.
- **Migration on production.** `push-schema.mjs` is idempotent and additive; run it via `docker compose exec -T portal node scripts/push-schema.mjs` after deploy, then re-run the occupancy batch so the latest run carries geo/habitat variants. Existing runs stay `combined` and are not displayed.
- **Dependency:** interacts with the covariate-transparency plan (habitat resolution, raster shipping). The habitat variant is only meaningful once every site resolves to a categorical habitat; if that plan hasn't landed, the habitat variant may collapse to `~1` for some species — handled gracefully by U3, but worth sequencing after (or alongside) the habitat-resolution fix.

---

## Sources & Research

- Production-clone fits 2026-07-13: paca (collinearity, non-significant) and ocelot (total separation presented as a fit) — the motivating cases.
- `src/lib/occupancy/separation.ts` (`isSeparated`), `eligibility.ts` (pre-fit readiness gate), `meta-analysis.ts` (`toForestPlot`/`inverseVarianceMean` — the synthesis), `config.ts` (`assembleRunConfig` covariate drop), `runner.ts` (single-fit contract, returns AIC/effects/prediction/curves/habitatUse), `build-run.ts` (fit loop + persistence).
- Synthesis filter points: `src/app/ocupacion/actions.ts:584-603` (`slopeRows` — unfiltered by `sufficientData`) and `:654-675` (`overallPlot` — filtered, would double-count).
- Schema: `src/db/schema.ts:1202-1250` (`occupancy_models` + unique index).
- Gotchas: `text({ enum })` is TS-only, SQLite CHECK lives in `push-schema.mjs` and needs table recreation (avoided here); better-sqlite3 transactions are synchronous.
