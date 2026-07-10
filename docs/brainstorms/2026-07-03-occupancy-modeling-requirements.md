# Occupancy Modeling & Predicted-Occurrence Maps — Requirements

**Date:** 2026-07-03
**Status:** Phase-1 spike run (2026-07-03) — timing settled, data-readiness is the real blocker; build in progress
**Scope class:** Deep — feature (extends the species-explorer surface; adds modeling + GIS + raster capabilities)
**Streams:** Camera trap + Audio (full pilot, both) with cross-species aggregation
**Plan file:** `~/.claude/plans/for-both-the-camera-wobbly-beaver.md` (approved 2026-07-03)

---

## Phase-1 spike results (2026-07-03) — the risk map flipped

Ran the timing benchmark + real data-readiness queries against the working dev DB.

**Timing is a non-risk.** R 4.5.3 + `unmarked` 1.5.1 installed and load fine. On a realistic FCAT design (30–48 sites × 6–9 five-day occasions, 3 site + 2 detection covariates):
- `occu` fit: **median 0.077 s/species** (max 0.13 s), 70/70 converged.
- Predict ψ+SE over a 5,000-cell AOI grid: **median 0.06 s**.
- **70 species × 2 streams ≈ 20 s of compute.** Full 70-species benchmark ran in 6.6 s wall-clock. Weekly batch is trivially feasible; data-prep + R startup (~3 s) dominate wall time.

**Data readiness is the real blocker** (current dev DB — real data, early stage):
- **Camera (verified only):** 13,173 verified/corrected dets, but ~13k are in just **2 deployments** (155, 156) with **2013-era filenames** (legacy). Only **8 deployments have any verified detection** (most 10–41). ⇒ effectively ~2 real sites. Not enough for a defensible model (need ≥15–20, ideally 30+).
- **Audio (conf ≥ 0.7):** 3,691 dets across only **3 deployments**; 3,682 from a single deployment (137). **Zero species at ≥5 sites.** Currently worse spatial spread than camera.
- **Site metadata:** only **9/48 deployments** have coordinates + date windows; 4 have `valid_start/valid_end`. Occupancy needs a coordinate + window for every site.
- **Per-image timestamps:** `exif_timestamp` populated for **20/23,304 images**. Capture dates must be parsed from filenames (`Uno - 20130708 - MFDC0007.JPG` → `YYYYMMDD`). Occasion-binning depends on this parser.

**Consequences for build order** (revised sequence below):
- The old #1 spike ("is R/timing viable?") is answered — de-prioritized.
- New #1 = **data-readiness gate + report** so species/streams below threshold get an explicit *"datos insuficientes"* state and the numbers are watchable as verification/fieldwork proceed.
- Filename-timestamp parsing and deployment coordinates/windows are hard prerequisites, pulled forward.
- Forest-cover buffer / KML AOI / GIS work is **off the critical path** until spatial spread exists (no point computing buffers for 2 sites).
- Consider a confidence-threshold "provisional" camera layer (clearly labeled) as an interim, since verified-only yields ~2 sites today.

---

## Problem & outcome

Today the portal shows *where a species was detected* (raw counts on a point map in "Explorar por especie"). It says nothing about **where a species probably occurs** after accounting for imperfect detection, nor how occurrence relates to habitat, forest cover, or elevation.

This feature adds **single-season single-species occupancy models** (`unmarked` in R), fit on a **weekly batch**, and a **layered presentation page**: public-friendly on top (predicted-occurrence map + plain-language habitat story), rigorous underneath (effect sizes, CIs, detection probability, diagnostics). It adds **cross-species rollups** (predicted-richness maps + effect-size meta-analysis across taxa/guilds), eBird-inspired. Success = a surface interpretable to donors/ministry/community **and** defensible to scientists, refreshing automatically as verified detections accumulate.

The user explicitly wants early confidence that models fit fast enough to batch weekly — so build order front-loads a one-species end-to-end spike.

---

## Decisions locked (from brainstorm dialogue)

| Decision | Choice |
|---|---|
| First milestone | Full pilot, both streams — internal build order starts with a 1-species modeling+timing spike (de-risks R/weekly-batch without cutting scope) |
| Audience | **One layered page**, progressive disclosure (public story on top, scientist depth underneath) |
| Occupancy "site" | **Physical location = site**; model the **most recent complete season** per location for the "current" map; older seasons archived for later trend work |
| Cross-species layer | **Built in the pilot** (richness maps + effect-size meta-analysis + guild/taxa groupings) |
| Page structure | First draft decided by assistant (see Presentation) |
| Camera detections | **Verified only**: `verificationStatus IN ('verified','corrected')` (reuse `VERIFIED_STATUSES`, `src/lib/portal-updates/aggregator.ts:43`) |
| Audio detections | **Confidence-threshold filtered**, default 0.7, configurable (reuse `applyConfidenceFilter`, `src/lib/audio-confidence.ts`) |
| Occasions | 5-day bins (configurable); ragged final bin kept, **n-days-in-bin as a categorical detection covariate** for effort |
| Engine | R `unmarked` (`occu`, MacKenzie single-season); standardize continuous covariates |

---

## Covariate plan (mostly already available)

**Site (ψ) covariates:**
- **Forest-cover proportion in a buffer** — *new GIS compute* from the 2022 Planet land-cover raster (`FCAT-Data/03_SIG/Maps/2022_12 - Land cover .../2022_08_4band_FCATtoCachi - balanced - 2022_04_18.tif`). Buffer radius configurable (default 500 m).
- **Elevation** — recover from the ODK geopoint's discarded 3rd coordinate (`src/lib/odk-types.ts:7,228`); Copernicus DEM fallback.
- **Habitat type** — ODK categorical, 7 classes (`src/app/biochoco/habitat/types.ts:32-40`).
- (Optional) canopy cover %, slope — already field-collected in ODK.

**Detection (p) covariates:**
- **Survey effort** = active days in the bin, categorical (handles ragged bins).
- **Understory density** — ODK categorical open/moderate/dense (`src/app/biochoco/habitat/actions.ts:69`).
- **Lunar illumination** — computed from bin date.
- **DOY** — a *detection* covariate (single-season ψ is static), circular/seasonal.

**Reproducibility:** ODK covariates are fetched live today; the pipeline **snapshots** per-site covariates per run (standardized values + mean/sd for back-transform).

**Rigor caveats (surface on page):** forest cover ↔ habitat type collinear; understory ↔ habitat confounded; BirdNET confidence is not a probability and varies ~10× across species (`src/lib/audio-confidence.ts:11-14`) — global threshold is a defensible first cut; `occuFP` / per-species thresholds are the documented audio upgrade path.

---

## Architecture summary

**Job + batch:** new `OCCUPANCY_MODEL` job type across `src/lib/job-types.ts`, `src/lib/system-events.ts` (JOB_LABELS + source; coverage-guard test `tests/unit/system-events.test.ts`), `src/lib/job-queue.ts` (allowlist + dispatch case). Processor modeled on `src/lib/birdnet-runner.ts`. New weekly cron `src/app/api/cron/occupancy-batch/route.ts` (`verifyCronSecret`) — first weekly `scripts/crontab` entry, scheduled in **container Eastern time** (`CRON_TZ` ignored).

**Language split:** Node/TS builds detection histories + covariate frames (reuses filter helpers + `src/lib/odk-deployment-window.ts`); **R** (`scripts/occupancy-runner.R`) fits `unmarked::occu` and predicts ψ+SE on the AOI grid, streaming NDJSON; **Python (ml-venv)** does the rare forest-cover buffer precompute (`rasterio`) + covariate-grid rasterization over the KML AOI. TS bridge `src/lib/occupancy-runner.ts` (birdnet-runner shape).

**R runtime:** add `r-base` + `unmarked` to `Dockerfile` + an install step like `scripts/ensure-ml-venv.sh`. Risk: image size / compile time. Fallback: R sidecar container.

**New tables (`src/db/schema.ts`):** `occupancy_runs`, `occupancy_models` (species×stream×season×run: n sites/detections, naive/estimated ψ+CI, mean p, AIC, convergence, c-hat, sufficientData, duration), `occupancy_covariate_effects`, `occupancy_site_covariates` (snapshot), `occupancy_predictions` (grid table for hover + colorized PNG artifact for Leaflet `ImageOverlay` — avoids a client GeoTIFF lib). Artifacts under `data/occupancy-models/<run>/`.

**Detection history:** site = physical location (name-pattern resolution, no FK — as `siteShareTokens`); most-recent complete season from ODK window (`loadOdkDateTimes()`), clipped to active days; 5-day bins; cell ∈ {1, 0, NA}; species-eligibility gate → explicit "datos insuficientes" state; **one model per species per stream**.

---

## Presentation (first-draft) — Spanish UI

New internal area **`/ocupacion`** (permission-gated), cross-linked from "Explorar por especie". Public/donor token-gated variant reuses outputs with only the simple blocks + `robots:noindex` (mirrors `src/app/public/biochoco/[token]/especies/[slug]/`).

- **Landing map:** Leaflet over the Planet AOI (reuse `src/components/species/deployment-map-inner.tsx`). Modes: single-species predicted-ψ surface (searchable picker) and cross-species richness (Σψ) with taxa/guild filters. Surface = colorized PNG `ImageOverlay`; hover reads the grid; site points overlaid.
- **Per-species `/ocupacion/[slug]`** (progressive disclosure): (1) hero map + plain headline, (2) collapsible concept primer, (3) habitat-use plot — predicted ψ by habitat type with CIs (the user's headline plot), (4) response curves ψ vs forest cover / elevation, (5) "Para científicos" collapsible — effect-size table, detection p, diagnostics (n sites/detections, naive vs estimated ψ, AIC, convergence, c-hat), (6) "Datos y métodos" footer — filter notes, bin width, sample sizes, last-fit date, per-stream availability.
- **Cross-species:** richness map (taxa/guild filters) + effect-size meta-analysis forest plots (forest-cover / elevation slopes grouped by taxa/guild).

---

## Build sequence (REVISED after spike — nothing cut; re-ordered around the real blocker)

0. ~~Spike: R + timing~~ **DONE 2026-07-03** — timing is a non-risk (see spike results above).
1. **Core occupancy library (pure TS, fully unit-tested):** filename-date parse, 5-day occasion binning with ragged-bin handling + n-days effort covariate, verified/threshold detection filtering, **eligibility/readiness gate**, covariate standardization + back-transform. No DB/R/Docker deps → testable now.
2. **R runner + TS bridge:** `scripts/occupancy-runner.R` (`occu` fit + grid predict, NDJSON streaming) + `src/lib/occupancy/runner.ts` (birdnet-runner shape). Test against a fixture.
3. **Schema + job wiring:** `occupancy_*` tables (+ push-schema CHECK), `OCCUPANCY_MODEL` job type, job-queue allowlist, system-events JOB_LABELS + coverage guard.
4. **Data-readiness report + `/ocupacion` page skeleton:** server action computing per-species/stream readiness; Spanish page surfacing readiness + *datos insuficientes*; permission-gated; sortable table. **Ships value today** (shows the field team exactly what's blocking modeling).
5. **Covariate pipeline:** elevation parse (ODK geopoint 3rd coord / Copernicus), habitat/understory ODK snapshot; **forest-cover buffer precompute (Python/rasterio over the Planet raster + KML AOI) — deferred until spatial spread exists.**
6. **Camera + audio vertical slice:** processor fits eligible species per stream; per-species page (habitat-use plot, response curves, diagnostics).
7. **Weekly batch:** cron + orchestration + system events + rich Docker logging.
8. **Cross-species layer:** richness map + effect-size meta-analysis.
9. **Public/donor variant:** token-gated simplified page, noindex.

_Benchmark artifact:_ `scratchpad/bench.R` (this session) — reproduces the timing numbers.

---

## Risks & open items

- **R-in-Docker weight** — biggest new-infra risk; sidecar fallback. The spike settles it.
- **Weekly timing at scale** — 50–70 species × 2 streams; spike timing extrapolates the batch budget. Mitigations: incremental refit, parallelism.
- **Spatial prediction is a habitat projection**, not spatially-explicit — label clearly; `spOccupancy`/`ubms` upgrade path.
- **Audio false positives** — threshold + caveat now; `occuFP` / per-species thresholds later.
- **NULL coordinates / missing ODK covariates** — excluded with explicit reason, never silent.
- **Assumptions to confirm in ce-plan:** buffer radius (500 m), eligibility thresholds, whether canopy cover joins as a covariate, exact "complete season" rule for multiple short redeployments at one location.

---

## Verification

- **Unit:** occasion-binning, detection-history builder (camera verified / audio threshold), forest-cover buffer sampling, standardization/back-transform, richness aggregation, eligibility gate, new-job-type coverage guard.
- **Integration:** full pipeline on a seed species → assert model rows + prediction artifact + page render.
- **E2E/manual:** run the batch on a real season; open `/ocupacion` + a species page; confirm overlay, habitat-use plot, response curves, diagnostics; confirm public variant hides depth + noindex.
- The Phase-1 spike doubles as first E2E test and weekly-timing benchmark.
