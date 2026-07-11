---
title: "fix: Restrict occupancy to verified deployments + recover camera detections"
type: fix
date: 2026-07-10
status: ready
origin: docs/brainstorms/2026-07-03-occupancy-modeling-requirements.md
depth: standard
---

# fix: Restrict occupancy to verified deployments + recover camera detections

## Summary

Three corrections to the deployed `/ocupacion` module, all centered on the shared
data-fetch layer (`src/lib/occupancy/fetch.ts` + `src/lib/occupancy/capture-date.ts`):

1. **Recover camera-trap detections (root cause confirmed on prod).** The camera stream
   shows *0 species* not because verified data is missing — there are **17,286
   verified/corrected identifications across 220 deployments** — but because current
   camera filenames carry **no date** (`084348_0101.jpg`, `163439_0420.jpg`) and
   `exif_timestamp` is populated for only **50 of 133,149** images. `resolveCaptureDay`
   returns `null` for essentially every camera detection, and the fetch loop drops it
   (`fetch.ts:143-144`). The fix: add the per-image `file_modified` timestamp as a
   capture-date source — verified on prod to track true capture day (dep 121: 2,121
   images spread over 30 distinct days matching its 30-day deployment window).
2. **Restrict the site pool for BOTH streams** to camera-trap deployments that are
   verified and not excluded (`status IN ('verified','verified_empty')` AND
   `excluded = 0`). Prod has exactly **52** such deployments (51 `verified` + 1
   `verified_empty`), all with coordinates — down from the current 306/312.
3. **Clarify the "Ocasiones" column** — every species shows the same value (7) because
   occasions are a property of the shared sampling design, not the species. **Not a data
   bug** (7 ≈ the intended 6–9 five-day-occasion design); a UI-clarity fix.

**Expected result after the fix:** camera goes from 0 → ~46 species detected within the
52-site verified pool (4,741 in-pool verified/corrected detections), with ~5+ species
clearing the ≥15-site modeling threshold (Dasyprocta punctata 37 sites, Dasypus
fenestratus 27, Proechimys semispinosus 19, Didelphis marsupialis 17, Cuniculus paca 16).
Audio counts drop sharply from 312 sites / 303 species as it is restricted to the same
verified pool.

All data-layer changes live in functions consumed by both the readiness report
(`src/app/ocupacion/actions.ts`) and the modeling processor
(`src/lib/occupancy/build-run.ts`), so a single correct change propagates to the page, the
weekly batch, and the per-species model-input sample.

---

## Problem Frame

The occupancy module was deployed to production (commit `fe93ae9`). On the live
`/ocupacion` page:

- **Camera trap:** 306 sites, 306 with coordinates, **0 species detected, 0 ready to
  model**. 16 installations dropped for want of a valid survey window.
- **Audio:** 312 sites, 303 species detected, 188 ready to model. Every species row shows
  exactly **7 occasions**.

The user's intent: occupancy should only draw on sites where the camera-trap deployment
has been **verified and not excluded** — verification confirms all imagery for that
installation. Audio should use the **same** site pool for consistency. And the camera
stream should surface its (abundant) verified detections.

---

## Root-Cause Analysis (confirmed against production 2026-07-10)

### Issue A — Camera detections dropped: no resolvable capture date (CONFIRMED)

Camera capture-day resolution assumes filenames embed `YYYYMMDD`
(`src/lib/occupancy/capture-date.ts:4-9`), true only for legacy 2013/2014 data. Current
camera filenames are time-of-day + sequence with **no date** (`084348_0101.jpg`), and
`exif_timestamp` is essentially empty (50/133,149). So:

- `resolveCaptureDay` (`capture-date.ts:75-83`) returns `null` for nearly every camera
  image.
- In the camera detection loop, `if (!day || !r.species) continue`
  (`fetch.ts:143-144`) drops **every** detection → 0 species.
- The deployments still appear as "sites" because `buildSites` falls back to the ODK
  `date_start`/`date_end` window when the image-derived window is empty
  (`fetch.ts:75-76`), so the pool count stays high while detections vanish.

**Confirmed capture-date source:** `biochoco_images.file_modified` (Unix seconds) tracks
true capture day for current data. Verified on prod across multiple deployments — e.g.
dep 121 (ODK 2026-03-24..2026-04-24): 2,121 images over **30 distinct** `file_modified`
days; dep 102 (ODK 2026-02-16..2026-03-17): 30 distinct days; dep 101: 22 distinct days.
A bulk-upload timestamp would collapse to 1–2 days — 30 distinct days aligned to the
deployment window means it is capture time, not upload time. Legacy 2014 deployments have
`file_modified` NULL, but they are `processed`/excluded from the verified pool anyway.

### Issue B — Site pool not restricted to verified deployments (CONFIRMED)

`fetchOccupancyInputs` selects `FROM biochoco_deployments WHERE excluded = 0` with no
`status` predicate (`fetch.ts:117-121`). Prod status distribution (non-excluded): 268
`processed`, 90 `scanned`, 1 `unscanned`, **51 `verified`**, **1 `verified_empty`**. The
pool must be gated to the 52 verified deployments. Note the bulk of verified/corrected
identifications sit in `processed` deployments (individual detections corrected, the
deployment not yet marked verified) — those are intentionally excluded by this
restriction, per the user's "verified = imagery confirmed" definition.

### Issue C — "7 occasions" for every species (NOT a bug)

`maxOccasions` is `Math.max` over the site pool of each site's occasion count
(`detection-history.ts:84-86`) — the *width* of the site×occasion matrix, shared by all
species, not a per-species quantity. 7 occasions ≈ 35 days ≈ the intended "6–9 five-day
occasions" design (`origin` line 15). Identical across rows is expected. Fix is
presentational only.

---

## Key Technical Decisions

**KTD-1 — Add `file_modified` to the camera capture-date resolution chain.** Extend
`resolveCaptureDay` to accept a `fileModified` (Unix seconds) input and try it after
filename and exif: `filename YYYYMMDD → exif → file_modified`. Legacy dated filenames keep
their current behavior; current data gains a working capture day. This is THE fix for the
0-species issue. Audio is unaffected (audio filenames embed dates — that is why audio
already works).

**KTD-2 — Gate the site pool on deployment status in one place.** Add
`status IN ('verified','verified_empty')` to the deployment query in
`fetchOccupancyInputs`, both streams. Centralizing keeps the readiness page, weekly batch,
and model-input sample identical.

**KTD-3 — Include `verified_empty` deployments as absence sites.** A verified-empty
installation is a completed survey with zero detections; including it supplies true
absences that reduce naive-occupancy bias. (User-confirmed.)

**KTD-4 — Keep camera detections at `verified`/`corrected`.** The per-identification
filter is the correct scientific definition and the data exists in quantity; the 0-species
issue was the capture date, not the filter. (User-confirmed — do NOT switch to "all
non-rejected".)

**KTD-5 — Restrict audio to the same verified pool.** Audio uses the identical deployment
predicate. Accepted consequence: audio at a non-camera-verified deployment (including
audio-only sites) is dropped; audio counts fall well below 312/303. (User-confirmed.)

**KTD-6 — Make dropped detections observable.** Report how many detection events were
discarded and why (no capture date, out-of-window, unknown-site), surfaced per stream in
the readiness report. This converts a silent "0 species" into an explained number and is
the durable guard against a recurrence — the exact failure mode that hid Issue A.

**KTD-7 — Widen the survey window to the union of ODK and image-derived spans.** Lower
priority. When both ODK dates and a `file_modified`-derived span exist, use
`start = min`, `end = max` so a rare ODK/data mismatch (observed: dep 131 ODK single-day
2026-03-11 vs `file_modified` 2025 — likely an ODK data-entry error) does not silently
drop detections. Occasion binning already tolerates ragged/wide windows
(`occasions.ts:39-50`).

---

## Implementation Units

### U1. Add `file_modified` as a camera capture-date source

**Goal:** Resolve a capture day for current camera detections so they stop being dropped.
(KTD-1.) This is the highest-impact unit — it alone moves camera from 0 → ~46 species.

**Requirements:** advances the origin doc's "occasion-binning depends on the capture-date
parser" note (`origin` line 24), which assumed filenames but must now handle dateless
current data.

**Dependencies:** none.

**Files:**
- `src/lib/occupancy/capture-date.ts` — add `parseCaptureDayFromFileModified(seconds)`
  (Unix seconds → UTC day, bounded to the same 2000–2100 sanity range) and extend
  `resolveCaptureDay` to accept `fileModified` and try it after filename/exif.
- `src/lib/occupancy/fetch.ts` — camera branch: add `img.file_modified` to both the
  window-deriving image query (line 124-126, feeding `deriveWindows`) and the detection
  query (line 130-139); pass it into `resolveCaptureDay` (lines 54, 143). `deriveWindows`
  signature/rows extended to carry `fileModified`.
- `tests/unit/occupancy/capture-date.test.ts` — cover the new source + precedence.

**Approach:** Precedence filename → exif → file_modified preserves legacy dated-filename
behavior. `file_modified` is seconds (validated: dep 121 min `1777038230` = 2026-04-24);
convert with `new Date(seconds * 1000)` reduced to a UTC day. Add a short comment
documenting the empirical validation (30 distinct days aligned to the ODK window) and the
caveat that it is a Drive/file modification time used as a capture-day proxy.

**Patterns to follow:** existing `parseCaptureDayFromExif` + `toUtcDay` bounds
(`capture-date.ts:21-35, 60-68`).

**Test scenarios:**
- Filename with `YYYYMMDD` still wins over a differing `file_modified` (legacy precedence).
- Dateless filename + null exif + valid `file_modified` → resolves to the `file_modified`
  UTC day.
- All three null → returns `null` (still an explicit drop, now counted by U3).
- `file_modified` out of 2000–2100 range → rejected (guards against 0/garbage epochs).
- Seconds→day conversion is UTC and ignores sub-day time (e.g. 23:59 and 00:01 same day).

**Verification:** `fetchOccupancyInputs('camera')` returns non-empty `detections`;
against prod-shaped fixtures the camera species count is ~46 in the verified pool.

---

### U2. Gate the occupancy site pool on verified, non-excluded deployments

**Goal:** Restrict both streams' pool to `status IN ('verified','verified_empty')` AND
`excluded = 0`. (KTD-2, KTD-3, KTD-5.)

**Dependencies:** none (independent of U1; combine with U1 for the full camera fix).

**Files:**
- `src/lib/occupancy/fetch.ts` — extend the shared deployment query
  (`WHERE excluded = 0` → add `AND status IN ('verified','verified_empty')`), line 117-121.
- `tests/unit/occupancy/fetch.test.ts` — status-gate + audio-parity cases.

**Approach:** Single predicate change on the shared deployment query; both stream branches
inherit it. Confirm the processor (`build-run.ts:117`) and model-input sample
(`actions.ts:711`) inherit for free. Comment that `verified_empty` is intentional (absence
sites).

**Test scenarios:**
- Fixtures across all six statuses (non-excluded, coords + images) → pool contains only
  `verified` and `verified_empty`.
- `verified` but `excluded = 1` → excluded from pool.
- `verified_empty` with a window → present, contributes an all-absence row (0 detections,
  still `surveyed`).
- `processed` deployment with corrected detections → absent from pool, contributes nothing.
- Audio pool equals camera pool for the same status/excluded fixtures.

**Verification:** On prod, both cards' "Sitios muestreados" show ~52; the pool matches the
51 `verified` + 1 `verified_empty` count.

---

### U3. Surface dropped-detection counts in the readiness report

**Goal:** Report per stream how many detections were discarded (no capture date,
out-of-window, unknown-site) so a zero can never again be silent. (KTD-6.)

**Dependencies:** U1 (the no-capture-date counter is only meaningful once file_modified is
wired), U2 (final pool).

**Files:**
- `src/lib/occupancy/fetch.ts` — count detections dropped for `!day` (no capture date) per
  stream; add to the returned `OccupancyStreamInputs`.
- `src/lib/occupancy/detection-history.ts` — count and expose out-of-window vs.
  unknown-site discards on `DetectionFrame` (additive, non-breaking fields).
- `src/lib/occupancy/readiness.ts` — thread aggregate drop counts into `ReadinessReport`.
- `src/app/ocupacion/actions.ts` — pass counts through `OccupancyReadinessResult`.
- `src/app/ocupacion/page.tsx` — render a Spanish note when detections were dropped
  ("N detecciones sin fecha de captura / fuera de la ventana").
- `tests/unit/occupancy/detection-history.test.ts` — counter cases.

**Approach:** Pure counting; no behavior change beyond visibility. The "no capture date"
counter is the direct symptom of Issue A and its most useful early warning.

**Test scenarios:**
- Detection with unresolvable date increments the no-capture-date counter and is excluded.
- Detection outside the (widened) window increments out-of-window and is excluded.
- Detection for a deployment absent from the pool increments unknown-site and is excluded.
- Report exposes the aggregate counts; page renders the note only when > 0.

**Verification:** With U1 applied, the no-capture-date count is near 0 for current data and
non-zero (with an explicit number) for legacy `file_modified`-NULL rows if any remain in
pool.

---

### U4. Widen the survey window to union(ODK, image-derived)

**Goal:** Prevent a rare ODK/data mismatch from silently excluding real captures.
(KTD-7.) Lower priority — affects edge deployments (e.g. dep 131).

**Dependencies:** U1 (image-derived span now comes from `file_modified`).

**Files:**
- `src/lib/occupancy/fetch.ts` — `buildSites` (line 73-89): when both ODK dates and a
  derived span exist, `start = min(ODKstart, derivedMin)`, `end = max(ODKend, derivedMax)`.
- `tests/unit/occupancy/fetch.test.ts` — window-union cases.

**Approach:** Keep ODK-only and derived-only fallbacks unchanged; only union when both
present. A photo implies the camera was active that day, so its day belongs in the window.

**Test scenarios:**
- ODK window narrower than the capture span → widened to the capture span; previously
  out-of-window detections now counted.
- ODK single-day but capture span multi-day (dep 131 shape) → window spans the captures.
- ODK-only (no derived) and derived-only (no ODK) fixtures behave exactly as before.

**Verification:** No verified-pool deployment loses in-window detections to a window
mismatch; drop counts from U3 attributable to windows drop to ~0.

---

### U5. Clarify the "Ocasiones" column and site-pool captions

**Goal:** Make the shared-occasions meaning legible and align captions with the new
verified-only pool. (Issue C + copy accuracy.)

**Dependencies:** U2.

**Files:**
- `src/app/ocupacion/readiness-table.tsx` — the `maxOccasions` column (line 41, 165):
  retitle/tooltip to convey it is the shared occasion-matrix width (e.g.
  "Ocasiones (máx. del diseño)"), keeping the existing `SortIcon` sort.
- `src/app/ocupacion/page.tsx` — update the card subtitle (line 180) and methods note
  (line 199) to state the pool is restricted to **verified, non-excluded deployments** for
  both streams.

**Approach:** Spanish UI strings, hardcoded (project convention). No logic change.

**Test scenarios:** none behavioral. `Test expectation: none -- copy/label-only; a page
render smoke test suffices if one exists.`

**Verification:** Occasions column reads as a design-level quantity; captions accurately
describe the verified-only pool for both streams; no layout regression.

---

### U6. Regression tests and processor parity check

**Goal:** Lock the behavior and confirm the weekly modeling batch inherits it.

**Dependencies:** U1, U2, U3, U4.

**Files:**
- `tests/unit/occupancy/capture-date.test.ts`, `fetch.test.ts`,
  `detection-history.test.ts` — from the units above.
- Update any existing occupancy test that seeds non-verified deployments and expects them
  in the pool, or camera detections resolving from filenames only.

**Approach:** Pure-function tests over seeded rows (no DB/R/Docker), matching the module's
"testable now" design (`origin` line 108). Assert `build-run.ts` and `getModelInputSample`
need no change because they call `fetchOccupancyInputs`.

**Test scenarios:**
- Full-status fixture → camera and audio pools identical and verified-only.
- Camera fixture with dateless filenames + `file_modified` → detections resolve and
  species surface (mirrors the prod recovery).
- Snapshot of `nSites`/`nSpecies` for a small mixed fixture asserting verified-only counts.

**Verification:** `npm run test:run` green; suite reflects verified-only pools and camera
detection recovery.

---

## Scope Boundaries

**In scope:** camera capture-date recovery via `file_modified`, deployment-status gating of
the site pool (both streams), drop observability, window-union robustness, occasions-column
clarity, caption accuracy, unit tests.

**Deferred to Follow-Up Work:**
- Filtering non-species camera labels ("Unknown", "Aves", "Rodentia", "Canis lupus
  familiaris"/"Gallus gallus domesticus" domestic animals) from occupancy — cosmetic, does
  not block modeling.
- Backfilling `exif_timestamp` or a dedicated `captured_at` column — `file_modified` is
  sufficient now; a first-class capture-time field is a larger data-pipeline change.
- A "provisional" confidence-threshold camera layer (origin line 31) — unnecessary now that
  verified detections surface.

**Out of scope:** occasion bin width, eligibility thresholds, the modeling/R pipeline,
covariate logic, the map surface.

---

## Diagnostics Recorded (prod, 2026-07-10)

- Verified/corrected identifications: **17,286** across **220** deployments; overall
  identification statuses: 28,733 unverified, 15,909 corrected, 1,377 verified, 4 rejected.
- Deployment statuses (non-excluded): 268 processed, 90 scanned, 1 unscanned, **51
  verified**, **1 verified_empty**; the 52-deployment verified pool all has coordinates.
- Camera filenames carry no date (`084348_0101.jpg`); `exif_timestamp` on 50/133,149
  images; `file_modified` present on ~89% of in-pool verified detections and spans the
  deployment window with daily granularity.
- In the verified pool: **4,741** verified/corrected detections, **46** species; top by
  site breadth: Dasyprocta punctata 37, Dasypus fenestratus 27, Proechimys semispinosus
  19, Didelphis marsupialis 17, Cuniculus paca 16, Dicotyles tajacu 14.

---

## Risks & Dependencies

- **`file_modified` semantics.** It is a file/Drive modification time used as a capture-day
  proxy. Empirically validated (30 distinct days aligned to the ODK window across dep 121 /
  102 / 101), but a future re-upload or re-compression that rewrites mtimes could shift
  dates. Mitigation: U3's drop counters + U4's union window make anomalies visible; a
  first-class capture-time field is the deferred durable fix.
- **Audio pool shrinks sharply** (intended, KTD-5). Communicate so the drop from 312/303 is
  not read as a regression.
- **Legacy `file_modified`-NULL deployments** in the pool (if any verified ones exist)
  still drop their detections; U3 surfaces the count rather than hiding it.
