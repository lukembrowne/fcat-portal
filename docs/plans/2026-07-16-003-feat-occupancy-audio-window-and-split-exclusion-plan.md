---
title: "feat: Occupancy audio survey-window rule + split per-stream exclusion"
date: 2026-07-16
type: feat
depth: standard
status: ready
origin: docs/brainstorms/2026-07-03-occupancy-modeling-requirements.md (feature origin; this is a follow-on refinement not covered there)
---

# feat: Occupancy audio survey-window rule + split per-stream exclusion

## Summary

Two independent occupancy-modeling refinements the user validated against real BioChoco data:

1. **Audio survey-window rule.** The audio detection window currently spans first-audio-file → last-audio-file. Recorders that captured stray files *before* the sensor was placed (NAC-006 opens 2025-12-12, CCN-003 opens 2025-11-17) balloon the window to 60–86 days / 12–18 occasions, which widens the whole site×occasion matrix and NA-pads every other row. Change the audio window to **ODK install date → last-file timestamp**: ODK install is the authoritative "sensor is now deployed" moment (clamps stray pre-deployment files), while the last file marks real recorder shutoff (batteries dying before the ODK retrieve date). Camera windowing is unchanged.

2. **Split the shared `excluded` flag.** `biochoco_deployments.excluded` is a single boolean written by *both* the audio and camera-trap QA panels ("Excluir de exportaciones") and read by *both* occupancy streams (`WHERE excluded = 0`). So excluding CCN-010 in the audio module (its recorder failed — 34 recordings, camera fine) would also drop it from the **camera** occupancy analysis. Retire the shared flag; replace it with `excluded_audio` + `excluded_camera` so each stream is gated independently. Existing `excluded = 1` rows migrate to *both* flags set, preserving current "dropped everywhere" behavior.

Both decisions were confirmed with the user: **switch the audio window default outright** (no in-app comparison surface — the before/after is visible by re-running models and reading the existing `sitio × ocasión` matrix, where NAC-006/CCN-003 will shrink), and **full split** of the exclusion flag.

---

## Problem Frame

**Windowing.** `buildSites` in `src/lib/occupancy/fetch.ts` resolves the audio window as `derived.min (first file) ?? ODK date_start` for the start and `derived.max (last file) ?? ODK date_end` for the end. The end is already last-file-first (correct — catches early battery death). The **start** is the defect: file-min-first lets a single stray pre-install recording set the survey start weeks early. The `sitio × ocasión` matrix width is `maxOccasions` = the widest window across the pool (`src/app/ocupacion/detection-sample-table.tsx`), so one ballooned site (⚠) degrades every row.

**Exclusion.** The `excluded` flag conflates three distinct intents that a single boolean can't express:
- "this deployment is bad everywhere" (the original QA meaning),
- "the audio recorder failed but the camera is fine" (CCN-010),
- "the camera failed but audio is fine" (the symmetric case).

Because occupancy reads one flag for both streams, and both QA panels write it, there is no way to express per-stream exclusion today.

---

## Requirements

- **R1.** Audio occupancy survey window = `ODK date_start` (install) for the start, falling back to first-file only when ODK install is absent; end unchanged (`last file ?? ODK date_end`). Camera window logic untouched.
- **R2.** Audio files dated before the ODK install window are surfaced as a date-window anomaly (same "surface, never hide" principle the camera stream already follows), not silently dropped.
- **R3.** Replace `biochoco_deployments.excluded` with `excluded_audio` + `excluded_camera`. Every current reader/writer of `excluded` is migrated to the stream-appropriate column; no reader is left pointing at a dropped column.
- **R4.** Existing `excluded = 1` deployments migrate to `excluded_audio = 1 AND excluded_camera = 1` (preserve current behavior; user then re-includes per stream, e.g. CCN-010 → `excluded_audio` only).
- **R5.** Occupancy camera stream filters `excluded_camera = 0`; audio stream filters `excluded_audio = 0`.
- **R6.** Audio QA panel writes/reads `excluded_audio` with an audio-scoped label; camera-trap QA panel writes/reads `excluded_camera`. Both bulk-update actions updated.

---

## Key Technical Decisions

- **KTD1 — Audio start precedence flips to ODK-first.** `start = parseYmd(d.date_start) ?? derived?.min`. Rationale: ODK install is auto-recorded and authoritative for "sensor is now live"; a stray earlier file is noise. **Accepted edge case:** when a recorder starts *late* (first file after ODK install), the window now opens at ODK install and the leading occasions become legitimate absence occasions (site monitored, recorder silent/not-yet-detecting). This is the user's explicit intent and is statistically the correct absence treatment, not a regression.
- **KTD2 — End bound stays last-file-first, untrimmed.** Do **not** clamp the end to `min(last file, ODK date_end)`. The user's stated failure mode is batteries dying *before* retrieval (last file < ODK end), and last-file already handles it. A recorder whose files run slightly past the ODK retrieve date (clock drift) keeps those occasions rather than discarding real data. (See Open Questions if this proves wrong on real data.)
- **KTD3 — Full split, retire the shared column.** Add `excluded_audio` + `excluded_camera` (both `INTEGER NOT NULL DEFAULT 0`), backfill from `excluded`, then drop `excluded`. Removing `excluded` from `src/db/schema.ts` turns every stale `deployments.excluded` reference into a TypeScript compile error — a forcing function that guarantees no reader is missed.
- **KTD4 — Audio anomaly surfacing extends the existing camera path.** `buildSites` already emits `DateWindowAnomaly` when authoritative bounds trim file coverage, but only for camera (audio never set `authStart`/`authEnd`). With the audio start now sourced from ODK, set `authStart` for audio so pre-install files fire the same clamp warning — this is exactly the NAC-006/CCN-003 signal, now auditable.

---

## Scope Boundaries

**In scope:** audio window rule (R1, R2), the exclusion split across all readers/writers (R3–R6), migration, and test coverage.

### Deferred to Follow-Up Work
- **Audio CSV export gating.** `src/app/api/audio/export/route.ts` does **not** currently filter on `excluded` at all — so the audio "Excluir de exportaciones" label is already a partial misnomer (it only ever affected occupancy + camera exports). Wiring `excluded_audio` into the audio export route is a real improvement but is orthogonal to this change; capture separately.
- **In-app window comparison surface.** The user declined a before/after diagnostic. If auditing across runs proves awkward, a matrix toggle showing both windows is a future add.

### Out of scope
- Camera survey-window logic (`valid_* ?? ODK ?? file-derived`) — unchanged.
- Occupancy model fitting, covariates, rendering.

---

## High-Level Technical Design

Audio survey-window resolution, before vs after (start bound only):

```
                    ODK install      first file        last file       ODK retrieve
                    (date_start)     (derived.min)     (derived.max)    (date_end)
  NAC-006 timeline:      |                                  |
   stray pre-deploy → x  |   x  x                           |
                     ────┴──────────────────────────────────┴────────────────
  BEFORE (now):  start = first file  ── window opens at the stray file  → 60d, ⚠12 occ
  AFTER  (R1):   start = ODK install ── stray files clamped to anomaly  → real span

  end (unchanged): last file, else ODK retrieve   ← battery-death case already handled
```

Exclusion flag data flow after the split:

```
  QA write                    column                 occupancy read
  ────────                    ──────                 ──────────────
  camera-trap/[id] QA  ──→  excluded_camera  ──→  camera stream: WHERE excluded_camera = 0
  audio/[id] QA        ──→  excluded_audio   ──→  audio  stream: WHERE excluded_audio  = 0

  (retired) excluded  ──migrate──→  both flags = old value
  camera exports / biochoco resultados / training exports  ──→  excluded_camera
```

---

## Implementation Units

### U1. Audio survey-window rule: ODK install start, last-file end

**Goal:** Flip the audio start-bound precedence to ODK-install-first and surface pre-install files as anomalies. Independent of the exclusion work — lands on its own.

**Requirements:** R1, R2.

**Dependencies:** none.

**Files:**
- `src/lib/occupancy/fetch.ts` — `buildSites` audio branch (currently lines ~162–170) and the anomaly block (~189–215).
- `tests/unit/occupancy-window-clamp.test.ts` — extend.

**Approach:**
- Audio branch: `start = parseYmd(d.date_start) ?? derived?.min ?? null;` (was `derived?.min ?? parseYmd(d.date_start)`). Leave `end = derived?.max ?? parseYmd(d.date_end) ?? null` unchanged.
- Set `authStart = parseYmd(d.date_start)` (and `authEnd = parseYmd(d.date_end)` for symmetry) in the audio branch so the existing `if (authStart && authEnd && derived)` anomaly block fires when audio files fall outside the ODK window — emitting the same `occupancy_date_window_clamp` warn + `DateWindowAnomaly`. Guard for the ODK-dates-absent case (audio with no ODK window falls back to file-derived, no anomaly, as today).
- Confirm the audio detection loop (fetch.ts ~337+) and `detection-history.ts` treat detections before the new `windowStart` as out-of-window NA (they already do — window-based occasion assignment). No detection-loop change expected; verify.

**Patterns to follow:** the camera branch's `authStart/authEnd` + anomaly emission already in `buildSites`; mirror it for audio.

**Test scenarios:**
- Audio deployment with a stray file dated 3 weeks before ODK `date_start` → window starts at ODK `date_start`, not the stray file; occasion count reflects the trimmed span. Covers R1.
- Same deployment → one `DateWindowAnomaly` emitted with `fileMin` < `odkStart`. Covers R2.
- Audio recorder starts *after* ODK install (first file > `date_start`) → window opens at ODK install; leading occasions present as absences (no detections), not dropped. (KTD1 edge.)
- Audio deployment with **no** ODK `date_start` → falls back to first-file start (current behavior preserved); no anomaly.
- Battery-death case: last file well before ODK `date_end` → window ends at last file (end unchanged). 
- Camera deployment in the same pool → window logic byte-for-byte unchanged (regression guard).

**Verification:** re-run occupancy models; the `sitio × ocasión` matrix on `/ocupacion` shows NAC-006 and CCN-003 with dramatically shorter windows (⚠ gone) and the matrix width no longer NA-padded by them.

---

### U2. Schema + migration: split `excluded` into `excluded_audio` + `excluded_camera`

**Goal:** Add the two per-stream columns, backfill from `excluded`, drop `excluded`. Pure data-layer change; downstream units (U3–U5) migrate the readers/writers.

**Requirements:** R3, R4.

**Dependencies:** none (but U3–U5 depend on this).

**Files:**
- `src/db/schema.ts` — remove `excluded`, add `excludedAudio` + `excludedCamera` (`integer(..., { mode: "boolean" }).notNull().default(false)`), keep `validStart`/`validEnd`/`qaNotes`.
- `scripts/push-schema.mjs` — replace the `ADD COLUMN excluded` line (~890) with two `ADD COLUMN excluded_audio` / `excluded_camera` idempotent ALTERs; add a dated comment. (Leave prod's existing `excluded` column in place for the migration script to drop — do **not** attempt a DROP in the idempotent push-schema, which re-runs every deploy.)
- `tests/helpers/test-db.ts` — the `CREATE TABLE biochoco_deployments` (~line 150): replace `excluded` with the two new columns.
- `scripts/migrate-split-exclusion.mjs` — **new** one-time raw better-sqlite3 migration: `ADD COLUMN` both (idempotent try/catch), `UPDATE biochoco_deployments SET excluded_audio = excluded, excluded_camera = excluded`, then `ALTER TABLE biochoco_deployments DROP COLUMN excluded`.

**Approach:**
- Boolean columns → no seconds/timestamp concern. Follow the additive `ADD COLUMN` idiom already in push-schema.
- SQLite `DROP COLUMN` requires SQLite ≥ 3.35 (better-sqlite3 bundles far newer — safe). The migration must run with the container's node against `data/portal.db` **inside the container** (host runs corrupt WAL — see project gotcha [[gotcha_host_scripts_corrupt_sqlite_under_docker]]): `docker compose exec portal node scripts/migrate-split-exclusion.mjs`.
- Run order in prod: deploy code (push-schema adds the two columns) → run migration (backfill + drop `excluded`). New/test DBs never create `excluded`.

**Patterns to follow:** existing QA-metadata ALTER block in `push-schema.mjs`; the idempotent try/catch ALTER pattern; raw-script conventions from `scripts/`.

**Test scenarios:**
- `test-db.ts` schema builds with both new columns and no `excluded`; existing occupancy/audio/camera unit tests compile and pass.
- Migration script (dry-run against a copy or an in-memory fixture): a row with `excluded = 1` → both new flags `1`; `excluded = 0` → both `0`; column `excluded` absent afterward.
- Test expectation: the migration script itself gets a focused unit test if the repo has a migration-test pattern; otherwise validate via the test-db schema + a manual copy-DB dry run noted in Verification.

**Verification:** `npm run test:run` green after schema edit; `docker compose exec portal node scripts/migrate-split-exclusion.mjs` on a **copy** of prod DB shows correct backfill and `excluded` dropped; `PRAGMA table_info(biochoco_deployments)` confirms the final shape.

---

### U3. Occupancy fetch: per-stream exclusion filter

**Goal:** Gate each occupancy stream on its own exclusion column.

**Requirements:** R5.

**Dependencies:** U2.

**Files:**
- `src/lib/occupancy/fetch.ts` — the shared deployment pool query in `fetchOccupancyInputs` (~251–258, `WHERE excluded = 0`).
- `src/app/api/ocupacion/habitat-audit/route.ts` (~55) — the occupancy habitat audit query.
- `tests/unit/occupancy-*.test.ts` — add/extend a fetch-pool exclusion test.

**Approach:**
- `fetchOccupancyInputs(stream, ...)` already knows the stream. Select the exclusion column by stream: camera → `excluded_camera = 0`, audio → `excluded_audio = 0`. Either parameterize the shared query with the column name or move the `WHERE` clause into the per-stream branch.
- `habitat-audit` audits the covariate/habitat pool that feeds occupancy; it is camera-covariate-oriented → gate on `excluded_camera = 0`. Note this in a comment (habitat is a shared covariate but the audit's frame is the camera pool).

**Patterns to follow:** the existing pool query's BioChoco `ct_project_id` scoping + `status IN ('verified','verified_empty')` guard — keep both, only swap the exclusion predicate.

**Test scenarios:**
- Deployment with `excluded_audio = 1, excluded_camera = 0` → present in the camera pool, absent from the audio pool. Covers R5 (the CCN-010 case).
- Symmetric: `excluded_camera = 1, excluded_audio = 0` → present in audio, absent in camera.
- Both flags `0` → present in both streams.
- Both flags `1` → absent from both (migrated-legacy behavior).

**Verification:** unit test asserts pool membership per stream for each flag combination; re-running models with CCN-010 set `excluded_audio = 1` keeps it in the camera map and drops it from audio.

---

### U4. Camera-trap exclusion surfaces → `excluded_camera`

**Goal:** Point every camera-trap reader/writer of the old flag at `excluded_camera`.

**Requirements:** R3, R6.

**Dependencies:** U2.

**Files:**
- `src/app/camera-trap/[id]/qa-section.tsx` — checkbox state + submit (label stays "Excluir de exportaciones" or clarify to "Excluir de análisis de cámara"; user's call — keep existing wording unless it now reads ambiguously).
- `src/app/camera-trap/[id]/page.tsx` (~196) — pass `excludedCamera` to `QaSection`.
- `src/app/camera-trap/actions.ts` — QA update (~2093, `updates.excluded`) and bulk update (~2030) → `excludedCamera`; the deployment read selects (~1884, ~2000, ~1578) → `excludedCamera`.
- `src/app/camera-trap/deployments-table.tsx` (~474 badge, ~1058 row opacity) → `excludedCamera`.
- `src/app/api/camera-trap/export/route.ts` (~130) → `excluded_camera = false`.
- `src/app/camera-trap/training-exports/actions.ts` (~309, ~326) → `excludedCamera`.
- `src/app/biochoco/resultados/actions.ts` (~134, ~140, ~319, ~696), `[siteId]/page.tsx` (~89), `habitat-actions.ts` (~132) → `excludedCamera` (BioChoco results = camera detections).
- Corresponding `tests/` for camera export / biochoco results if present.

**Approach:** mechanical rename to the camera column. The `or(eq(excluded,false), isNull(excluded))` NULL-tolerant idiom in biochoco resultados → `or(eq(excludedCamera,false), isNull(excludedCamera))` (new column is `NOT NULL DEFAULT 0`, so `isNull` is defensive-only, but keep the pattern for consistency).

**Patterns to follow:** the current `excluded` usages themselves — same query shapes, new column.

**Test scenarios:**
- Camera QA panel toggles `excluded_camera` and persists it (round-trip via the update action).
- Camera export / biochoco habitat query omits an `excluded_camera = 1` deployment; includes an `excluded_camera = 0` one.
- Bulk camera update sets `excluded_camera` across multiple ids.
- Regression: a deployment excluded for **audio only** still appears in camera exports and biochoco resultados.

**Verification:** camera-trap deployment table shows the excluded badge/opacity driven by `excluded_camera`; `npm run test:run` green.

---

### U5. Audio exclusion surfaces → `excluded_audio`

**Goal:** Point every audio reader/writer at `excluded_audio` and relabel the control to its audio-scoped meaning.

**Requirements:** R3, R6.

**Dependencies:** U2.

**Files:**
- `src/app/audio/[id]/audio-qa-section.tsx` — checkbox + submit; relabel "Excluir de exportaciones" → **"Excluir del análisis de audio"** (the flag now gates the audio occupancy stream, not exports — see Deferred). Update both the read-only (~37) and editable (~79) labels.
- `src/app/audio/[id]/page.tsx` (~66) + `recordings-shell.tsx` (~39, ~219) — pass `excludedAudio`.
- `src/app/audio/actions.ts` — QA update (~2052) and bulk (~2332) writes → `excludedAudio`; deployment read selects (~81, ~153, ~2021, ~2308) → `excludedAudio`.
- `src/app/audio/audio-deployments-shell.tsx` (~189 badge, ~674 row opacity) → `excludedAudio`.
- Corresponding `tests/` for audio deployment actions if present.

**Approach:** mechanical rename to the audio column + the one user-facing label change. Keep field naming consistent (`excludedAudio` in TS, `excluded_audio` in SQL).

**Patterns to follow:** the camera-trap QA section pattern (U4) — the two panels are near-mirror images.

**Test scenarios:**
- Audio QA panel toggles `excluded_audio` and persists it.
- Bulk audio update sets `excluded_audio` across ids.
- Regression: a deployment excluded for **camera only** still appears in the audio deployments list (not dimmed by the audio badge).
- The audio badge/opacity in `audio-deployments-shell` reflects `excluded_audio`, not the camera flag.

**Verification:** in the audio module, excluding CCN-010 (`excluded_audio = 1`) dims it in the audio list and drops it from the audio occupancy stream, while the camera-trap module still shows and counts it; `npm run test:run` green.

---

## Risks & Dependencies

- **Missed `excluded` reader → silent stream regression.** Mitigation: removing `excluded` from `src/db/schema.ts` (U2) makes every stale `deployments.excluded` a TS compile error; `npm run build` + `npm run test:run` must both be clean before the migration runs. The reader inventory in U3–U5 was grep-derived from the whole `src/` tree.
- **`DROP COLUMN` on prod.** Low risk (bundled SQLite supports it), but run only after backfill and against a **copy** first; the hourly backup + `data/portal.db.pre-restore` path is the safety net. Must run inside the container ([[gotcha_host_scripts_corrupt_sqlite_under_docker]]).
- **Ordering.** U2 must be deployed (columns exist) before U3–U5 code paths read the new columns; the migration (backfill + drop) runs after deploy. U1 is fully independent and can ship first.
- **Sequencing dependency:** U3, U4, U5 all depend on U2. U1 depends on nothing.

---

## Sources & Research

- Current audio window + camera anomaly logic: `src/lib/occupancy/fetch.ts` `buildSites` (audio branch ~162–170, anomaly block ~189–215).
- Shared exclusion flag confirmed single-column: `src/db/schema.ts:167`; written by `src/app/audio/[id]/audio-qa-section.tsx` + `src/app/camera-trap/[id]/qa-section.tsx`; read by occupancy `fetch.ts:255` (both streams).
- Full `excluded` reader/writer inventory: grep across `src/` (camera export, biochoco resultados, training exports, habitat-audit, both QA panels + bulk actions, both deployment tables).
- Audio export route does **not** filter `excluded` today: `src/app/api/audio/export/route.ts` (no match) — informs the Deferred note.
- Matrix width driven by widest window: `src/app/ocupacion/detection-sample-table.tsx` (⚠ long-window annotation).
- Feature history + occupancy architecture: project memory `project_occupancy_modeling_feature.md`; prior fix `docs/plans/2026-07-10-001-fix-occupancy-site-restriction-and-camera-detections-plan.md`.
