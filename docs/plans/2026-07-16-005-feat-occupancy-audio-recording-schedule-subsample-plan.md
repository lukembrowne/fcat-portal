---
title: "feat: Occupancy audio recording-schedule subsampling for comparable survey effort"
date: 2026-07-16
type: feat
depth: standard
status: ready
origin: docs/brainstorms/2026-07-03-occupancy-modeling-requirements.md (feature origin; this is a follow-on refinement not covered there)
---

# feat: Occupancy audio recording-schedule subsampling for comparable survey effort

## Summary

BioChoco audio recorders ran on two different duty cycles. The **old** schedule captured a 1-minute recording **every 5 minutes** (1 min on, 4 min off → ~12 files/hour). At some point the field team reconfigured recorders to a **10-minute** cadence (~6 files/hour). Because recorders are reconfigured in the field when physically visited — not on a single date — both schedules coexist across the same calendar months in the current data (verified: 5-min deployments and 10-min deployments both present Nov 2025–Mar 2026, and at least one deployment, id 110, switches mid-deployment). A global "May" date cutoff would misclassify deployments; cadence must be **inferred per-deployment from file timestamps**.

For the occupancy analysis this is a **survey-effort comparability** problem: a denser recording schedule means more listening time per occasion, which inflates **detection probability** (`p`) for the 5-min deployments and — because `psi` and `p` are jointly estimated in `unmarked::occu` — can bias occupancy for quiet or rare species.

**Chosen fix (confirmed with the user): subset to a common 10-minute grid.** At the occupancy fetch layer, count a species detection toward the site×occasion matrix **only when it comes from a "kept" recording**, where the kept set is exactly **one recording per 10-minute wall-clock bucket per deployment** (earliest file in each bucket). This equalizes listening effort to ~6 recordings/hour everywhere: 10-min deployments are essentially unchanged (capped at one recording per bucket), 5-min deployments are halved, mixed-cadence deployments normalize automatically. No BirdNET re-run, no file deletion — it is a detection-membership filter scoped to the occupancy analysis. Cadence is never assumed from a date; it falls out of the wall-clock bucketing itself.

The recording-effort-covariate alternative (keep all data, model the difference via `p ~ recordings`) was considered and set aside in favor of subsetting, which is the more defensible framing for the collaborator report ("we standardized survey effort across recorders"). See Alternatives.

---

## Problem Frame

**How audio effort reaches the model today.** `fetchOccupancyInputs` (audio branch, `src/lib/occupancy/fetch.ts`) pulls every qualifying detection via the join `audio_identifications ai → audio_detections ad → audio_files af` (`ad.id = ai.audio_detection_id`, `af.id = ad.audio_file_id`), filtered to `ai.confidence ≥ threshold OR ai.verification_status IN ('verified','corrected')`. The `audio_file_id` the subsample filter keys on lives on **`audio_detections`**, not on `audio_identifications`. Each detection resolves to a **UTC calendar day** from the filename, and the events feed `buildDetectionFrame` (`src/lib/occupancy/detection-history.ts`). That builder collapses a species' detections into a **binary detected/not-detected per 5-day occasion bin** (`DEFAULT_BIN_WIDTH_DAYS`). Raw recording count never enters directly — but a 5-min deployment gets ~2× the recordings per bin, so its probability of registering a `1` in any bin is genuinely higher than a 10-min deployment's. That is the bias.

The existing `effort` covariate does **not** correct this: it measures *calendar days spanned by the bin* (`layout.nDays`, from `computeOccasions`), which is window geometry — independent of how many recordings a day actually contained. So there is no effort signal in the model that distinguishes a 5-min day from a 10-min day.

**Filenames carry the cadence.** Audio filenames are `<serial>_YYYYMMDD_HHMMSS.<ext>` (e.g. `2MM21840_20260218_105500.wav`), parsed by `parseRecordingTimestamp` in `src/lib/audio-filename.ts`. Consecutive same-day files are 300s apart on the old schedule and 600s apart on the new one — so cadence is fully recoverable from the timestamps already in the DB.

**Scale.** ~2.49M rows in `audio_detections` across 70 deployments with audio (the fetch iterates the `audio_identifications` rows joined onto them); roughly half the deployments are on the 5-min schedule. Subsampling drops detections on ~half the files of the dense-schedule deployments.

---

## Requirements

- **R1.** Occupancy audio detections are counted only from a canonical "kept" recording set = the **first (earliest) file in each 10-minute wall-clock bucket** per deployment (bucket = `floor((hour*60+minute)/10)` within a calendar day). A detection on a non-kept file does not contribute to the site×occasion matrix.
- **R2.** The kept-set rule is applied uniformly with **no per-deployment cadence classification and no date cutoff**: a 10-min deployment is essentially unchanged (≤1 per bucket), a 5-min deployment keeps ~half, and a deployment that switches cadence mid-window (e.g. id 110) is normalized throughout. Cadence is a *consequence* of the bucketing, never an input to it. The rule applies to **all** qualifying detections, including human-`verified`/`corrected` ones (a verified presence on a non-earliest file is subsampled like any other — acceptable because the bucket's kept file almost always carries the same species; see the degenerate-case guard in R4).
- **R3.** Subsampling affects the **audio stream only**. The camera stream, survey-window resolution, occasion layout, and the day-based `effort` covariate are all unchanged.
- **R4.** The number of files/detections removed by subsampling is **surfaced, never hidden** — a stream-level summary count plus per-deployment native cadence + kept/dropped + `unparsed` counts, consistent with how `detectionsDroppedNoDate` and `dateWindowAnomalies` are already surfaced on `/ocupacion`. The surface must include a **degenerate-case flag**: a deployment whose native cadence implies subsampling (`nativeCadenceSeconds ≈ 300`) but whose `filesDropped ≈ 0` and/or `unparsed` fraction is high means normalization silently did **not** apply (filename-format drift → kept-by-default → the effort imbalance is re-created for that deployment with no error). This is the failure mode the "keep-by-default" safety valve introduces, so it must be visible.
- **R5.** The target bucket width is configurable via an env knob (default 10 minutes) so the behavior can be reverted or retuned without a redeploy (set to a small value → keep all files).
- **R6.** The fitted models (`build-run.ts`) automatically consume the subsampled detections through the shared fetch — no separate wiring in the model processor.

---

## Key Technical Decisions

- **KTD1 — Subsample by wall-clock 10-min bucket, keep earliest.** The kept set is `first-by-time within each (deployment_id, calendar_day, floor(minuteOfDay/10)) bucket`, where the calendar day uses the **same UTC basis** as the detection→day resolution (KTD4), so the two day boundaries provably coincide at the midnight seam. Rationale: this is **self-normalizing** — the true invariant is that it **caps every deployment at ≤1 recording per 10-minute block** regardless of its native cadence or clock phase, so it needs no cadence detection and handles the mid-deployment switch (id 110) and irregular gaps automatically. Wall-clock alignment (not per-recorder phase) is deliberate: deterministic and phase-agnostic. **Caveat (not an absolute guarantee):** a nominally-10-min recorder whose gaps run slightly under 600s or drift across a fixed bucket boundary can occasionally put two files in one bucket (one dropped) while the neighbour empties — so "10-min deployments keep everything" is an approximation, not a theorem. The `unparsed`/dropped-count summary (U1) makes the actual 10-min drop rate observable; a non-trivial 10-min drop rate is a signal the fixed boundaries are mis-phased for those recorders (validate during U1/U2 verification).
- **KTD2 — Filter at the occupancy fetch layer, not at BirdNET or on disk.** Subsampling is an *analysis* decision, so it lives in `fetchOccupancyInputs`. BirdNET has already run on every file; we simply skip detections whose source `audio_files.id` is not in the kept set. Nothing is re-processed, no files are deleted, and the raw data (and the audio module UI) are untouched. This keeps the change reversible and cheap. **Recompute-each-fetch, accepted:** the kept set is derived on every fetch rather than materialized as a flag on `audio_files`. It is deterministic given a fixed file set, but a late Drive sync that adds an *earlier* file into an existing bucket would change which file is "earliest" and therefore the kept set — so two model runs across a sync are not guaranteed byte-identical. Acceptable for a weekly batch over a stable historical corpus; if run-to-run reproducibility or the deferred cadence-audit UI later needs it, materializing an auditable kept flag is the upgrade path.
- **KTD3 — Effort and window are untouched.** With subsetting chosen (not the effort-covariate path), `layout.nDays` and the survey window stay as-is. Two facts make this provable: (1) `nDays` is bin geometry from `computeOccasions` (never file-derived), so it cannot change; and (2) the survey window is derived by `deriveWindows` over the **full** `audio_files` set *before* the kept-set filter is applied — so even the file-derived window bounds (`derived.min`/`derived.max`) are computed from all files, and dropping a last-of-day file from the kept set cannot move a boundary. Only detection *membership* shrinks. This makes the change strictly additive to plan 003's window work and orthogonal to it.
- **KTD4 — Cadence is inferred, never dated.** The "changed in May" story is not encoded anywhere; the wall-clock bucket rule makes a date cutoff unnecessary and, per the data, wrong (both schedules coexist monthly). The per-deployment native cadence is *reported* (for transparency, R4) by measuring the modal same-day inter-file gap, but it is **not** used to decide what to keep.

---

## High-Level Technical Design

Canonical kept-set rule (self-normalizing — same rule for every cadence):

```
  10-minute wall-clock buckets →  [10:50–10:59] [11:00–11:09] [11:10–11:19] ...

  5-min deployment (old):  10:50  10:55 | 11:00  11:05 | 11:10  11:15 | ...
    kept (first per bucket): 10:50 ✓ 10:55✗| 11:00 ✓ 11:05✗| 11:10 ✓ 11:15✗
    → effective 10-min cadence (halved)

  10-min deployment (new): 10:50 | 11:00 | 11:10 | ...   (already ≤1 per bucket)
    kept: 10:50 ✓ | 11:00 ✓ | 11:10 ✓
    → unchanged

  mixed deployment (id 110): 5-min stretch then 10-min stretch
    → each stretch normalized by the same bucket rule, no special-casing
```

Data flow — where the filter sits:

```
  audio_files (id, deployment_id, filename)
        │
        ▼
  selectCanonicalAudioFiles()  ── kept Set<audio_files.id> + subsample summary   [U1]
        │
        ▼
  fetchOccupancyInputs("audio")                                                   [U2]
     detection loop: skip rows whose audio_file_id ∉ kept set
        │                                    │
        ▼                                    ▼
  buildDetectionFrame (unchanged)     OccupancyStreamInputs.audioSubsample (summary)
        │                                    │
        ▼                                    ▼
  models (build-run.ts, auto) [U2/R6]  /ocupacion transparency surface           [U3]
```

---

## Scope Boundaries

**In scope:** the canonical kept-set computation (R1–R2, R5), wiring it into the audio occupancy fetch so both the readiness report and the fitted models use subsampled detections (R2, R3, R6), the transparency surface (R4), and test coverage.

### Deferred to Follow-Up Work
- **Recording-effort covariate.** Replacing the bin-geometry `effort` with a real recordings-per-occasion covariate is a strictly better long-term treatment of *within-schedule* effort variation (battery gaps, partial days) and would compose with subsetting. Deferred by the user's choice of pure subsetting; capture separately if the report reviewers want it.
- **Cadence audit UI in the audio module.** Surfacing native cadence per deployment inside `/audio` (not just `/ocupacion`) could help the field team confirm reconfigurations. Out of this analysis-scoped change.

### Out of scope
- Camera stream, survey-window resolution, occasion binning, exclusion flags (the latter two are plan 003's territory).
- BirdNET reprocessing, audio file deletion/compression, or any change to raw `audio_files` / `audio_detections`.
- Occupancy model fitting internals, covariates, and map rendering.

---

## Implementation Units

### U1. Canonical audio subsampling module

**Goal:** A pure, unit-tested function that, given the audio-file rows, returns the kept `audio_files.id` set (first file per 10-minute wall-clock bucket per deployment) plus a subsample summary. No DB access, no occupancy coupling — testable in isolation.

**Requirements:** R1, R2, R5.

**Dependencies:** none.

**Files:**
- `src/lib/occupancy/audio-subsample.ts` — **new**. Exports `selectCanonicalAudioFiles(files, opts?)` returning `{ keptIds: Set<number>; summary: AudioSubsampleSummary }`, and the `AudioSubsampleSummary` type (totals + per-deployment `{ deploymentId, nativeCadenceSeconds, filesTotal, filesKept, filesDropped, filesUnparsed }`). `filesUnparsed` is what makes the R4 degenerate-case flag expressible.
- `tests/unit/occupancy-audio-subsample.test.ts` — **new**.

**Approach:**
- Input rows: `{ id: number; deployment_id: number; filename: string | null }`.
- Parse each filename with `parseRecordingTimestamp` (`src/lib/audio-filename.ts`) → `{ date, time }`. Skip rows that don't parse (no timestamp → cannot bucket; count them as `unparsed` in the summary and **keep** them by default so a filename-format change never silently drops data — decision noted inline).
- Bucket key = `${deployment_id}|${date}|${floor(minuteOfDay / bucketMinutes)}` where `minuteOfDay = hour*60 + minute`. Keep the row with the earliest `time` in each bucket (deterministic tiebreak on `id`). The `date` used for the bucket key must be the **same UTC calendar day** the detection loop resolves (via `parseCaptureDayFromFilename` / `resolveCaptureDay`), so a near-midnight file buckets under the same day it is later assigned to — for Ecuador's whole-hour UTC-5 offset the minute-of-hour phase is timezone-invariant, but the day-grouping is not, so pin it to UTC.
- `bucketMinutes` from `opts.bucketMinutes ?? Number(process.env.OCCUPANCY_AUDIO_SUBSAMPLE_BUCKET_MINUTES) || 10`, floored at 1.
- Native cadence per deployment (summary only): the modal same-day gap between consecutive files, in seconds — reported, not used for filtering (KTD4).

**Patterns to follow:** the pure-over-fetched-rows style of `src/lib/occupancy/readiness.ts` and `detection-history.ts` (compute is pure; the DB fetch lives in the caller). Env-knob-with-default idiom from the occupancy pool config in CLAUDE.md.

**Test scenarios:**
- 5-min deployment (files at :00,:05,:10,:15,:20,:25) → kept = :00,:10,:20; dropped = :05,:15,:25. Covers R1.
- 10-min deployment (:00,:10,:20) → all kept, zero dropped. Covers R2.
- Phase-offset 5-min recorder (:03,:08,:13,:18) → kept :03,:13 (first per bucket), effective 10-min. Covers R1.
- Mixed deployment: a 5-min morning stretch and a 10-min afternoon stretch on the same day → morning halved, afternoon untouched, no special-casing. Covers R2 (id-110 case).
- Multi-day: buckets reset per calendar day (a file at 23:55 and one at 00:05 next day are different buckets). 
- Unparseable filename → kept by default and counted in `filesUnparsed` (never silently dropped).
- Degenerate case: an all-unparseable 5-min deployment → `filesDropped = 0`, `filesUnparsed = filesTotal`, `nativeCadenceSeconds` null/unknown → this is the R4 flag condition (dense-cadence-implied but zero drops). Assert the summary exposes enough to detect it. Covers R4's degenerate guard.
- Phase-drift 10-min recorder (gaps ~590s straddling a bucket boundary, e.g. :09,:19,:28,:38) → occasionally two files share a bucket → `filesDropped > 0` on a "10-min" deployment (documents KTD1's caveat, not a bug).
- `bucketMinutes` override = 1 → every file is its own bucket → keep all (revert lever). Covers R5.
- Summary correctness: `filesTotal = filesKept + filesDropped + filesUnparsed` per deployment and overall; `nativeCadenceSeconds` reports 300 for the 5-min fixture, 600 for the 10-min fixture.

**Verification:** `npm run test:run` green for the new suite; a quick script over a copy of `data/portal.db` (inside the container per [[gotcha_host_scripts_corrupt_sqlite_under_docker]]) reports ~50% kept on 5-min deployments and ~100% on 10-min ones.

---

### U2. Wire subsampling into the occupancy audio fetch

**Goal:** Apply the kept set inside `fetchOccupancyInputs` so the audio site×occasion matrix — and therefore both the readiness report and the fitted models — counts only kept-file detections. Expose the subsample summary on the stream inputs.

**Requirements:** R2, R3, R6.

**Dependencies:** U1.

**Files:**
- `src/lib/occupancy/fetch.ts` — audio branch of `fetchOccupancyInputs` (~344–386): add `id` to the `audio_files` query (~345), compute the kept set via `selectCanonicalAudioFiles`, add `af.id AS audio_file_id` to the detection query (~353–362), and skip detections whose `audio_file_id` is not in the kept set in the detection loop (~367–377). Add `audioSubsample?: AudioSubsampleSummary` to the `OccupancyStreamInputs` interface (~56–77); camera stream returns it undefined.
- `tests/unit/occupancy-build-run.test.ts` and/or a focused `fetch` test — extend to assert per-stream subsample behavior.

**Approach:**
- The audio-file rows are already fetched for window derivation (~345); reuse them for `selectCanonicalAudioFiles` (add `id` to the SELECT). One pass, no extra query.
- The `audio_file_id` comes from `audio_detections` (`ad.audio_file_id`), surfaced as `af.id AS audio_file_id` via the existing `ai → ad → af` join — not from `audio_identifications`. In the detection loop, the current filter chain (species exclusion → pool membership → capture-day resolve) gains one more guard: `if (!keptIds.has(r.audio_file_id)) continue;` — placed so a dropped-file detection is simply not counted (it is *not* a "no-date drop"; keep `detectionsDroppedNoDate` semantics clean). Note the guard applies to `verified`/`corrected` detections too (per R2); that is intended.
- Window/occasion/effort code paths are untouched (KTD3). The camera branch is untouched (R3).
- Thread `audioSubsample` into the return object; `build-run.ts` and `readiness` get it for free through the shared fetch (R6) — no change needed in the model processor loop itself beyond optionally logging the summary.

**Patterns to follow:** the existing per-detection filter guards in the audio loop (`isExcludedOccupancySpecies`, `poolIds.has`, `parseCaptureDayFromFilename`); the summary-field-on-`OccupancyStreamInputs` pattern already used for `detectionsDroppedNoDate` and `dateWindowAnomalies`.

**Test scenarios:**
- Audio deployment on a 5-min schedule where a species is detected **only** on dropped (non-kept) files in a bin → that bin is 0 for the species (detection removed). Covers R1/R2 end-to-end.
- Same species also detected on a kept file in the bin → bin stays 1 (kept detection survives).
- 10-min deployment → detection counts identical to pre-change (regression guard). Covers R2.
- Camera stream → detections, window, effort byte-for-byte unchanged (regression guard). Covers R3.
- `OccupancyStreamInputs.audioSubsample` is populated for the audio stream and undefined for camera; totals reconcile with U1's summary.
- Effort/occasion invariant: subsampling does not change `maxOccasions`, `perSite.occasions`, or any `effort` cell for a fixture with detections on both kept and dropped files. Covers KTD3.

**Verification (before/after gate):** re-run the audio occupancy models and record the delta. Expected direction: eligible-species counts and naive occupancy for 5-min deployments move toward the 10-min deployments' detection rate (lower per-occasion detection), 10-min deployments unchanged. **A near-zero delta is an acceptable, informative outcome** — it confirms the binary-per-bin collapse already absorbs the cadence difference and points at the deferred effort-covariate as the real lever (see Risks). `npm run test:run` and `npm run build` green.

---

### U3. Surface subsampling transparency on `/ocupacion`

**Goal:** Show the field/analysis team what subsampling removed — a stream-level dropped-files count and per-deployment native cadence + kept/dropped — mirroring the existing anomaly surfacing, so the correction is auditable, not silent.

**Requirements:** R4.

**Dependencies:** U2.

**Files:**
- `src/app/ocupacion/actions.ts` — the audio-stream server action that calls `fetchOccupancyInputs`: pass `audioSubsample` through to the page payload alongside the existing `dateWindowAnomalies` / `detectionsDroppedNoDate`.
- `src/app/ocupacion/page.tsx` — render a Spanish summary line (e.g. *"Submuestreo de audio: N grabaciones de M omitidas para igualar el esfuerzo a una cadencia de 10 min"*) and, in the existing per-deployment detail/readiness surface, a cadence + kept/dropped column. Follow the existing `dateWindowAnomalies` rendering.
- `src/app/ocupacion/readiness-table.tsx` — if per-deployment cadence belongs in this table, add a sortable column (tables are sortable by default — use shared `SortIcon`, per project convention).
- `tests/unit/ocupacion-subsample-format.test.ts` — **new**. Unit test for the summary/label formatting + degenerate-flag helper.

**Approach:**
- Purely presentational over the `audioSubsample` summary produced in U2; no new computation. Audio-only — the section is hidden/omitted for the camera stream.
- **Scope the per-deployment rows to the modeled site pool** (`poolIds` from `fetchOccupancyInputs`), not all `audio_files` deployments — the summary from U2 spans every deployment with audio (including excluded/unverified/other-project ones the window query pulls), so intersect with the pool before rendering or the reader sees cadence rows for deployments that never enter the analysis. The stream-level total may state both ("N in the analysis; M audio deployments total") but the table is pool-scoped.
- Surface the R4 **degenerate flag** — a pool deployment with `nativeCadenceSeconds ≈ 300` yet `filesDropped ≈ 0` or a high `filesUnparsed` fraction — as a warning row (Spanish), mirroring the `dateWindowAnomalies` warn styling, so a silent non-normalization is visible.
- Keep copy in Spanish (UI convention). Cadence displayed as a human label ("5 min" / "10 min" / "mixta") derived from `nativeCadenceSeconds`.

**Patterns to follow:** the existing `dateWindowAnomalies` warning surface in `src/app/ocupacion/page.tsx` and its threading through `src/app/ocupacion/actions.ts`; the SSR sortable-table pattern (`SortIcon`, `?sortBy=…&sortDir=…`) per CLAUDE.md.

**Test scenarios:**
- The summary/label formatting helper (seconds → "5 min"/"10 min"/"mixta"; kept/dropped totals) — inputs and expected labels.
- Degenerate-flag helper: a deployment with `nativeCadenceSeconds ≈ 300` + `filesDropped = 0` (or high `filesUnparsed`) → returns the warn flag; a clean 10-min deployment → no flag.
- A stream with zero dropped files (all 10-min) renders "sin submuestreo" / no warning banner rather than "0 omitidas" noise.
- Pool-scoping: a deployment with audio but excluded from the pool (`excluded_audio = 1` / unverified) does not appear as a per-deployment cadence row.
- Cadence column sorts correctly and preserves other query params (if added to `readiness-table.tsx`).

**Verification:** load `/ocupacion` (audio stream) on `http://localhost:3003`; the subsample summary reports a non-zero dropped count with roughly half of the 5-min deployments' files removed and 10-min deployments showing zero; no layout regression versus the existing anomaly surface.

---

## Alternatives Considered

- **Recording-effort detection covariate (keep all data).** Change `effort` from bin-geometry days to recordings-per-occasion and let `p ~ effort` absorb the schedule difference. Statistically the most efficient (discards nothing, standard treatment of unequal effort), and the `effort` plumbing already threads to the R runner. **Set aside** because the user wants the more defensible "we standardized survey effort" framing for the collaborator report, and because a subset filter is simpler to reason about and reverse. Recorded in Deferred as the natural next increment if reviewers want residual within-schedule effort modeled.
- **Global "May" date cutoff.** Rejected on data: both cadences coexist in the same calendar months and at least one deployment switches mid-window, so a date rule misclassifies. The wall-clock bucket rule (KTD1) makes a date unnecessary.
- **Per-deployment cadence classification then drop-every-other-file.** Rejected: brittle for mixed-cadence deployments and clock jitter, and requires a classifier the bucket rule makes redundant. Cadence is reported for transparency but never drives filtering.

---

## Risks & Dependencies

- **The success criterion is a defensible design, not a measured estimate shift — verify, don't assume.** Because the pipeline collapses to binary detected/not-detected per 5-day bin *before* the model sees counts, halving recordings in a bin still holding hundreds rarely flips a common species' bin from 1→0; the effect concentrates on rare/quiet species and may be near-zero for most. So the decision's payoff is a *defensible equal-effort narrative* for the report, not guaranteed movement in `psi`. Make this an explicit **verification gate at U2**: re-fit before/after and read the delta. If the 5-min deployments' occupancy is essentially unchanged, that is not a failure — it confirms the binary-per-bin collapse already absorbs the cadence difference, and it is the signal that the deferred **effort-covariate** is the real lever if measurable correction is wanted. (Keep the chosen scope — subsetting — regardless; this is an accepted-outcome check, not a scope cut.)
- **Other (non-300/600s) inter-file gaps not fully characterized.** The 10-min deployments show a large count of same-day gaps that are neither 300s nor 600s, whose composition (night-off periods, hourly blocks, jitter) was not fully resolved at plan time. The bucket rule caps at ≤1 per bucket regardless, but phase-drifted sub-600s gaps can cause real drops on nominally-10-min deployments (KTD1 caveat), so the actual per-deployment drop rate should be measured against real data during U1/U2 verification. Execution-time data check, not a planning blocker.
- **Filename-format drift silently reintroduces the bias.** The kept-set rule depends on `parseRecordingTimestamp` succeeding; unparseable filenames are kept-by-default (no silent *drops*). But the failure mode of that safety valve is a silent *no-op*: if a whole 5-min deployment (or cadence class) uses a filename variant the parser can't read, it is never subsampled and keeps ~12/hr while its peers keep ~6/hr — the exact imbalance this plan removes, with no error. The R4 degenerate-case flag (`nativeCadenceSeconds ≈ 300` + `filesDropped ≈ 0` / high `filesUnparsed`) exists precisely to make this visible; U1's `filesUnparsed` field makes it expressible.
- **Ordering:** U1 → U2 → U3 strictly. U1 is a standalone pure module; U2 depends on it; U3 renders U2's summary. Independent of plan 003 (audio window + exclusion split) — no shared files beyond `fetch.ts`, and the changes touch different branches/fields.

---

## Sources & Research

- Audio detection → capture-day → binary-per-bin flow: `src/lib/occupancy/fetch.ts` (audio branch ~344–386), `src/lib/occupancy/detection-history.ts` (`buildDetectionFrame`), `src/lib/occupancy/occasions.ts` (`nDays` is bin geometry, not file-derived — confirms KTD3).
- Filename timestamp parser: `src/lib/audio-filename.ts` (`parseRecordingTimestamp`, `<serial>_YYYYMMDD_HHMMSS`).
- Cadence evidence (this session, local `data/portal.db`): per-deployment same-day inter-file gaps show two clean populations — 5-min deployments (94, 96, 98, 100, 102, 103, 106, 111, 112, 115, 116, 118, 121–124: thousands of 300s gaps) and 10-min deployments (95, 97, 99, 101, 104, 105, 107, 109, 113, 114, 117, 119: ~950 gaps of 600s), plus a mid-deployment switch (110). Both populations span Nov 2025–Mar 2026 — no clean date cutoff exists.
- Scale: ~2.49M rows in `audio_detections`; 70 deployments with audio.
- Existing "surface, never hide" precedents to mirror for U3/R4: `detectionsDroppedNoDate` and `dateWindowAnomalies` in `src/lib/occupancy/fetch.ts` + `src/app/ocupacion/page.tsx` / `actions.ts`.
- Consumers of the shared fetch (confirm R6 auto-flow): `src/lib/occupancy/build-run.ts`, `src/lib/occupancy/cohort.ts`, `src/app/ocupacion/actions.ts`, `src/app/api/ocupacion/habitat-audit/route.ts`.
- Related, orthogonal plan: `docs/plans/2026-07-16-003-feat-occupancy-audio-window-and-split-exclusion-plan.md` (audio survey window + per-stream exclusion). Occupancy feature history: project memory `project_occupancy_modeling_feature.md`.
