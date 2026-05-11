---
title: Acoustic indices for audio recordings
type: feat
date: 2026-05-11
brainstorm: docs/brainstorms/2026-05-11-audio-acoustic-indices-brainstorm.md
revisions:
  - 2026-05-11 — initial plan
  - 2026-05-11 — revised after multi-agent plan review (DHH / Kieran / Simplicity). Headline cuts: staleness machinery, in-process Map dedup, errorMessage / libraryVersion / jobId columns, per-deployment card, nightly cron integration, CSV export, Spanish copy file. Scope compressed from 5 phases to 2. Renamed `time_window` → `diel_period`. Single create-action with scope parameter.
---

# Acoustic indices for audio recordings

Compute the five Chocó-validated ecoacoustic indices (Soundscape Saturation, Acoustic Complexity Index, Frequency Entropy, Temporal Entropy, Events per Second) on every audio file. Stratify by four diel periods (dawn / midday / dusk / night, Ecuador local time). Show the results as boxplots grouped by ODK habitat type on a new page. That's it. NMDS, calibration, per-deployment card, nightly cron, CSV export, admin recompute UI, staleness detection — all deferred until a user asks.

The defensibility argument for v1 is purely **descriptive**: we expose the values and the *expected direction of effect* from Müller et al. 2023 / Kümmet et al. 2025 (same biome, <100 km away) so reviewers and funders can see whether our sites follow the published patterns.

## Problem Statement / Motivation

The current audio pipeline runs BirdNET to detect specific bird species. That signal is powerful for species-level claims but limited as a *whole-soundscape* monitoring tool:

1. **BirdNET identifies only ~25% of vocalizing species** in the Chocó (Müller 2023). Many amphibians, mammals, insects are missed entirely. Non-vocalizing taxa are out of reach.
2. **No habitat-level summary** — there's no single comparable number per site for habitat-quality dashboards or funder reports.

Two peer-reviewed studies from the same biome — Müller et al. 2023 (Nat Comms) and Kümmet et al. 2025 (Conserv Lett) — show that five acoustic indices predict bird community composition with adjusted R² = 0.59–0.76 across a recovery gradient, and also track non-vocalizing nocturnal insects. The five indices form a **regionally validated recipe**. Implementing it gives FCAT a comparable, defensible habitat-quality measure that complements BirdNET.

## Proposed Solution

One new Python runner (`scripts/acoustic-indices-runner.py`) computes five indices per audio file. One new SQLite table (`acoustic_indices`) stores results 1:1 with `audio_files`. One server action enqueues the job. One worker streams NDJSON progress through the existing `FloatingJobProgress` infrastructure. One new page (`/audio/indices`) shows five boxplot charts grouped by habitat type, with diel-period tabs.

Everything mirrors patterns the codebase already has — BirdNET runner shape, `audio_sync` worker lifecycle, `BoxPlotChart` from the iButton module, `loadSiteHabitatMap()` from ODK.

## Technical Approach

### Architecture

```
audio_files (existing)
   │
   │ 1:1 FK (cascade), ON CONFLICT DO UPDATE on re-run
   ▼
acoustic_indices (NEW)
   ├─ 5 index columns
   ├─ recorded_date, diel_period (denormalized from filename at write time)
   └─ config_hash, computed_at

processing_jobs (existing — new jobType: "acoustic_indices")

   Compute path:
      createAcousticIndicesJob({ deploymentId?, projectId?, force? })
        → after(() => processAcousticIndicesJob(jobId))
        → ensureAudioCached() per file
        → spawn scripts/acoustic-indices-runner.py
        → readline NDJSON stdout → per-file UPSERT
        → throttled progress → processingJobs.statusMessage
        → SSE → FloatingJobProgress

   Read path:
      getAcousticIndicesForProject(projectId)
        → SELECT all rows joined with deployments
        → loadSiteHabitatMap() from ODK
        → group by (habitat, diel_period), return points for BoxPlotChart
```

### DB Schema

```ts
// src/db/schema.ts — insert after audioIdentifications (~line 837)
export const acousticIndices = sqliteTable(
  "acoustic_indices",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    audioFileId: integer("audio_file_id")
      .notNull()
      .references(() => audioFiles.id, { onDelete: "cascade" }),

    // Five indices from Müller 2023 / Kümmet 2025 — full names everywhere
    soundscapeSaturation: real("soundscape_saturation"),
    acousticComplexityIndex: real("acoustic_complexity_index"),
    frequencyEntropy: real("frequency_entropy"),
    temporalEntropy: real("temporal_entropy"),
    eventsPerSecond: real("events_per_second"),

    // Denormalized from filename — local Ecuador time (UTC-5), per iButton convention
    recordedDate: text("recorded_date"),       // 'YYYY-MM-DD' or NULL if unparseable
    dielPeriod: text("diel_period").notNull(), // see DIEL_PERIODS const below

    configHash: text("config_hash").notNull(),
    computedAt: integer("computed_at", { mode: "timestamp" }).notNull(),
  },
  (table) => ({
    audioFileUnique: uniqueIndex("idx_ai_audio_file").on(table.audioFileId),
  }),
);
```

What was cut from the prior draft, per review consensus:
- `errorMessage` — log to stderr, skip the row. Failed files aren't in the table; that's the signal.
- `libraryVersion` — `configHash` already encodes this.
- `jobId` FK — pure provenance, never queried.
- `configHashIdx`, `windowIdx`, `jobIdx` — keep only the unique on `audio_file_id`. SQLite scans this table in milliseconds at FCAT scale.
- The `audio_` prefix — `acoustic_indices` is unambiguous on its own.

### Centralized diel-period enum (single source of truth)

```ts
// src/lib/acoustic-indices.ts (new, ~30 lines)

export const DIEL_PERIODS = ["dawn", "midday", "dusk", "night", "other"] as const;
export type DielPeriod = typeof DIEL_PERIODS[number];

export const DIEL_PERIOD_LABELS: Record<DielPeriod, string> = {
  dawn: "Madrugada (05–07)",
  midday: "Mediodía (11–13)",
  dusk: "Crepúsculo (17–19)",
  night: "Noche (22–04)",
  other: "Otra",
};

// Hour ranges (local Ecuador time, UTC-5) — passed to Python as config
export const DIEL_PERIOD_RANGES: Record<Exclude<DielPeriod, "other">, [number, number]> = {
  dawn: [5, 7],
  midday: [11, 13],
  dusk: [17, 19],
  night: [22, 4], // wraps midnight; handled in window-assignment helper
};

// Current algorithm config — bump CONFIG_VERSION when SS/EPS ports change.
// The hash is computed by Python at job start and persisted on every row.
export const CONFIG_VERSION = "1.0";
export const INDEX_CONFIG = {
  targetSampleRate: 44100,
  windowSeconds: 60,
  freqLowHz: 50,
  freqHighHz: 8000,
  ssThresholdDb: 9,           // Burivalova 2018
  epsMinEventSeconds: 0.06,   // Towsey 2018
};
```

Python receives `DIEL_PERIODS` + `DIEL_PERIOD_RANGES` + `INDEX_CONFIG` as part of the stdin JSON so there is one canonical source of truth and no drift between TS and Python literals.

### Python Runner: `scripts/acoustic-indices-runner.py`

Mirror `scripts/birdnet-runner.py` shape exactly. Single-file, stdlib + `scikit-maad` + `numpy` + `scipy` + `soundfile` + `librosa` (already installed).

```text
stdin (single JSON line):
{
  "files": [{"id": 123, "path": "...", "filename": "...wav"}, ...],
  "config": { ...INDEX_CONFIG... },
  "diel_periods": ["dawn","midday","dusk","night","other"],
  "diel_period_ranges": {"dawn":[5,7], "midday":[11,13], ...}
}

stdout (NDJSON):
{"type": "info", "message": "...", "config_hash": "sha256:abc..."}
{"type": "progress", "index": 5, "total": 200}
{"type": "result", "audio_file_id": 123,
 "soundscape_saturation": 0.41, "acoustic_complexity_index": 1620.3,
 "frequency_entropy": 0.84, "temporal_entropy": 0.92, "events_per_second": 4.7,
 "recorded_date": "2026-01-19", "diel_period": "dusk"}
{"type": "complete", "total_processed": 198, "total_skipped": 2}
```

Implementation outline:

1. **Load audio** — `librosa.load(path, sr=target_sample_rate, mono=True)`. Already installed.
2. **Post-load sanity check** — if `len(y) < target_sample_rate * 30`: emit `info` with skip reason, continue to next file. Filesystem header duration is unreliable for truncated WAVs (Kieran finding).
3. **scikit-maad** for ACI, Ht, Hf (mapped to the published definitions in both papers).
4. **Soundscape Saturation port** (Burivalova 2018, ~50 lines NumPy): Towsey amplitude spectrum → per-bin modal background → mark bin "occupied" if any time slice exceeds (background + 9 dB) → SS = occupied_bins / total_bins.
5. **Events per Second port** (Towsey 2018, ~50 lines NumPy): energy envelope → smooth → detect events crossing (background + threshold) lasting ≥ 0.06 s → EPS = events / duration_seconds.
6. **Diel-period assignment** from filename: parse hour with the same regex used by `src/lib/audio-filename.ts`. Apply `DIEL_PERIOD_RANGES` (passed in stdin). Unparseable filename → `diel_period: "other"`, `recorded_date: null`.
7. **Config hash** — SHA-256 of canonical JSON of the entire config blob + `CONFIG_VERSION` + scikit-maad version. Computed once at startup. Emitted in the initial `info` message and held by the TS wrapper.
8. **Failed files** — log to stderr, emit a structured `{"type": "skip", "audio_file_id": X, "reason": "..."}` (TS wrapper just counts these, doesn't insert anything).

Edge cases handled by skip rather than error:
- File missing from disk
- Corrupt WAV / FLAC header (librosa raises)
- File < 30 s after load (truncated)
- All-silent file → SS = 0, EPS = 0 (keep, not an error)

### TypeScript wrapper: `src/lib/acoustic-indices-runner.ts`

Mirror `src/lib/birdnet-runner.ts` line-for-line:
- `getMlPython()` resolver: `ACOUSTIC_INDICES_PYTHON_PATH || ML_PYTHON_PATH || data/ml-venv/bin/python3`
- `runAcousticIndicesAnalysis({ files, onProgress, onResult, abortSignal })` — readline NDJSON loop
- Throttled progress updates (every 5s) like BirdNET (`birdnet-runner.ts:158-176`)
- Crash diagnostics: copy `buildCrashError()` from `src/lib/ml-runner.ts:276-325` for OOM / SIGSEGV classification

### Upsert with null-safe COALESCE (Kieran finding)

```ts
await db
  .insert(acousticIndices)
  .values({ ... })
  .onConflictDoUpdate({
    target: acousticIndices.audioFileId,
    set: {
      soundscapeSaturation: sql`excluded.soundscape_saturation`,
      acousticComplexityIndex: sql`excluded.acoustic_complexity_index`,
      frequencyEntropy: sql`excluded.frequency_entropy`,
      temporalEntropy: sql`excluded.temporal_entropy`,
      eventsPerSecond: sql`excluded.events_per_second`,
      // COALESCE so a re-run with a bad filename parse doesn't clobber valid data:
      recordedDate: sql`COALESCE(excluded.recorded_date, ${acousticIndices.recordedDate})`,
      dielPeriod: sql`excluded.diel_period`,
      configHash: sql`excluded.config_hash`,
      computedAt: sql`excluded.computed_at`,
    },
  });
```

Sequential `await` per file — never `async db.transaction()` (known runtime trap per `docs/solutions/runtime-errors/async-transaction-better-sqlite3-CameraTrap-20260223.md`).

### Server actions: `src/app/audio/actions.ts`

Three additions, all following the canonical pattern at `actions.ts:291-353`:

```ts
// 1) ONE create action — scope determined by params
export async function createAcousticIndicesJob(input: {
  deploymentId?: number;
  cameraTrapProjectId?: string;
  force?: boolean;  // bypass single-flight when caller knows what they're doing
}): Promise<ActionResult<{ jobId: number }>>
  // - requirePermission("grabaciones", "editor") [admin if cameraTrapProjectId is set]
  // - requireDeploymentAccess(user, deploymentId) when scoped to one deployment
  // - DB single-flight: refuse if a pending/processing acoustic_indices job
  //   exists for this scope, UNLESS force === true
  // - insert processing_job row, jobType = JOB_TYPES.ACOUSTIC_INDICES
  // - after(() => processAcousticIndicesJob(jobId).catch(...))

// 2) ONE read action — cross-site comparison
export async function getAcousticIndicesForProject(
  cameraTrapProjectId: string,
): Promise<ActionResult<{
  groups: Array<{
    habitatKey: string;          // 'primary_forest', 'cacao_nacional', etc.
    habitatLabel: string;        // Spanish display label
    color: string;               // from HABITAT_COLORS
    dielPeriod: DielPeriod;
    points: Array<{
      deploymentId: number;
      siteName: string;
      soundscapeSaturation: number;
      acousticComplexityIndex: number;
      frequencyEntropy: number;
      temporalEntropy: number;
      eventsPerSecond: number;
      nFiles: number;
    }>;
  }>;
  totalDeployments: number;
}>>
  // - requirePermission("grabaciones", "viewer")
  // - one SQL query: SELECT * FROM acoustic_indices JOIN audio_files JOIN deployments
  //   WHERE deployments.cameraTrapProjectId = ?
  // - loadSiteHabitatMap() from ODK (cache result)
  // - group in TS, compute per-deployment medians
  // - graceful degrade if ODK unreachable: habitatKey = "unknown"

// 3) Cancel: route through the EXISTING cancelProcessingJob router at
//    actions.ts:589-608 — add a branch for ACOUSTIC_INDICES that sends SIGTERM
//    to processingJobs.pid (same as BirdNET pattern, lines 564-568) and sets
//    status to "cancelled". No new top-level action.
```

What was cut from the prior six-action plan:
- `enqueueAcousticIndicesJob` → folded into `createAcousticIndicesJob` via `cameraTrapProjectId` param
- `forceRecomputeProjectIndices` → folded via `force: true` param
- `fetchAcousticIndicesByDeployment` → not needed in v1 (no per-deployment card)
- `cancelAcousticIndicesJob` → routed through existing `cancelProcessingJob`

Names: queries prefixed `get`, commands as imperatives. Consistent with BirdNET (`createBirdNETJob`, `cancelBirdNETJob`).

### Job orchestration plumbing

- **`src/lib/job-types.ts`** — add `ACOUSTIC_INDICES: "acoustic_indices"`
- **`src/components/floating-job-progress.tsx:168-174`** — add branch:
  ```ts
  } else if (job.jobType === JOB_TYPES.ACOUSTIC_INDICES) {
    unitLabel = "archivos";
    // title: "Calculando índices acústicos..."
  }
  ```
- **`src/app/api/active-jobs/route.ts`** — add display-name + `canCancel: true` mapping
- **`src/app/audio/actions.ts:589-608`** (cancel router) — add `ACOUSTIC_INDICES` branch
- **Client trigger** dispatches `window.dispatchEvent(new Event("job-started"))` per `audio-deployments-shell.tsx:372` pattern

**Dedup**: DB single-flight only. The in-process `Map` from the prior draft was paranoia (per DHH + Simplicity) — the DB row is authoritative across processes, restarts, and deploys. If the BirdNET runner needs an in-process layer for a different reason, that's its problem.

### Python venv requirements

Append to `scripts/ensure-ml-venv.sh` after line 148:
```sh
uv pip install --python "$ML_PYTHON" scikit-maad scipy
```
After rebuild: verify with `docker compose exec portal data/ml-venv/bin/python3 -c "import maad; print(maad.__version__)"` (per `docs/solutions/build-errors/pytorchwildlife-docker-install-failures.md` — `uv pip install` "Audited" output is NOT proof of an importable package).

### UI: `/audio/indices` page

Single new route. `src/app/audio/indices/page.tsx`. Server-rendered. Project-scoped (selector at top, URL search param `?project=...`).

Layout:

```
Comparación de paisajes sonoros entre sitios
───────────────────────────────────────────────────
Proyecto: [selector]   Ventana: ( Madrugada | Mediodía | Crepúsculo | Noche )

[ Saturación del paisaje sonoro ]
  Proporción del espectro de frecuencias ocupada por sonido sobre el ruido de fondo.
  Indica qué tan 'lleno' está el paisaje sonoro acústicamente.
  ⬆ Se espera que aumente hacia bosque maduro (Müller et al. 2023).

  [BoxPlotChart: groups = habitat types, points = deployments, jittered, n shown per group]

[ Índice de complejidad acústica (ACI) ]
  ...
  ⬇ Se espera que disminuya hacia bosque maduro.
  [BoxPlotChart]

[ Entropía de frecuencia ]
  ⬆ Se espera que aumente hacia bosque maduro.
  [BoxPlotChart]

[ Entropía temporal ]
  Señal débil en bosques tropicales — interprete con cautela.
  [BoxPlotChart]

[ Eventos por segundo ]
  ⬇ Se espera que disminuya hacia bosque maduro.
  [BoxPlotChart]
```

Notes:
- Reuse `BoxPlotChart` from `src/app/biochoco/ibutton/box-plot-chart.tsx` as-is.
- Habitat colors from `HABITAT_COLORS` (`src/app/biochoco/habitat/types.ts:33-65`).
- Sample size `n` rendered next to each habitat group label (e.g. "Primary forest (n=8)"). One number, no separate threshold/checkmark. If `n < 4`, render the group at opacity 0.4 with a tooltip; that's it.
- All Spanish strings inline in this page file. No dedicated copy file in v1.
- Deployment-page trigger button: a simple "Calcular Índices Acústicos" button at the top of the deployment page next to the existing BirdNET trigger. No summary card. Clicking enqueues `createAcousticIndicesJob({ deploymentId })`, dispatches `job-started`, FloatingJobProgress takes over.

## Implementation Phases

### Phase 1 — Foundation (DB + Python runner)

Goal: produce correct index values for a single audio file on disk, end-to-end, manually.

- `src/db/schema.ts` — add `acousticIndices` table (5 index columns + recorded_date, diel_period, config_hash, computed_at, unique on audio_file_id)
- `node scripts/push-schema.mjs`
- `src/lib/acoustic-indices.ts` — `DIEL_PERIODS`, `DIEL_PERIOD_LABELS`, `DIEL_PERIOD_RANGES`, `CONFIG_VERSION`, `INDEX_CONFIG`
- `scripts/ensure-ml-venv.sh` — append `scikit-maad scipy`
- `docker compose build`; verify `import maad` inside container
- `scripts/acoustic-indices-runner.py` — full runner with the 3 maad calls + the 2 NumPy ports + diel-assignment + config hashing + per-file skip-on-error
- Python unit tests:
  - **Headline fixture (per Kieran)**: 60 s mono 44.1 kHz WAV with three synthetic tonal bursts at 2 / 4 / 8 kHz, 200 ms each, separated by 1 s of silence. Assertions: `eps ≈ 0.05` (±20%), `ss ≈ 3/n_bins` (±10%), `aci` within ±5% of scikit-maad's own reference on the same array.
  - All-silent → SS = 0, EPS = 0, no crash
  - White-noise burst → high SS
  - Corrupt header → skip with structured reason
  - File < 30 s → skip with structured reason
- `src/lib/acoustic-indices-runner.ts` — TS wrapper (spawn, readline, throttle, crash diagnostics)

Success: `docker compose exec portal data/ml-venv/bin/python3 scripts/acoustic-indices-runner.py < test-config.json` produces correct NDJSON for the fixture set.

### Phase 2 — Job pipeline + UI

Goal: trigger compute from a button click on the deployment page; see five boxplots on `/audio/indices`.

- `src/lib/job-types.ts` — add `ACOUSTIC_INDICES`
- `src/components/floating-job-progress.tsx` — branch
- `src/app/api/active-jobs/route.ts` — display name + `canCancel`
- `src/app/audio/actions.ts`:
  - `createAcousticIndicesJob({ deploymentId?, cameraTrapProjectId?, force? })` with DB single-flight
  - `processAcousticIndicesJob(jobId)` fire-and-forget worker, mirrors `processBirdNETJob` at `actions.ts:355-534`. Sequential file processing. Per-result `onConflictDoUpdate` with COALESCE on `recordedDate`.
  - `getAcousticIndicesForProject(projectId)` — SQL + `loadSiteHabitatMap()` join + TS grouping
  - Cancel-router branch
- Deployment-page trigger button (no card)
- `src/app/audio/indices/page.tsx` — five `BoxPlotChart` cards + diel-period tabs (URL-controlled)
- Navigation: link in audio module main nav, labeled "Índices acústicos"
- Playwright E2E: trigger → wait → assert page renders boxplots
- Vitest unit tests for `getAcousticIndicesForProject`: empty state, low-coverage opacity, ODK-unreachable graceful degrade

Success criteria covered by Acceptance Criteria below.

## Acceptance Criteria

### Functional Requirements

- [ ] `acoustic_indices` table exists; `node scripts/push-schema.mjs` is idempotent
- [ ] `scripts/acoustic-indices-runner.py` produces correct values for the synthetic-bursts fixture within tolerances above
- [ ] `scikit-maad` and `scipy` installed in `data/ml-venv/`; `import maad` succeeds inside the running container
- [ ] "Calcular Índices Acústicos" button on the deployment page enqueues a job; `FloatingJobProgress` shows live progress in Spanish with `X de Y` counts and an ETA
- [ ] Job can be cancelled mid-run via the existing cancel control; status flips to `"cancelled"`
- [ ] Second enqueue for the same deployment while one is pending/processing is rejected (unless `force: true`)
- [ ] On completion, exactly one `acoustic_indices` row exists per audio file in the deployment (1:1)
- [ ] Re-running with a temporarily unparseable filename does NOT clobber a previously valid `recorded_date` (COALESCE upsert)
- [ ] `/audio/indices` page renders five boxplot charts grouped by ODK habitat type with diel-period tabs
- [ ] Habitat colors match `HABITAT_COLORS` in `src/app/biochoco/habitat/types.ts`
- [ ] Sample-size `n` rendered next to each habitat group label
- [ ] Groups with `n < 4` rendered at reduced opacity with a tooltip
- [ ] ODK unreachable at read time: habitats fall through to `"unknown"` group; page still renders
- [ ] Read-only views accessible to `viewer` role; compute requires `editor` (deployment scope) or `admin` (project scope)

### Non-Functional Requirements

- [ ] Performance: indices computation completes in < 5 s per file on the deployed Docker container (revised upward per Kieran — initial estimate was unbenchmarked). Measure on one real deployment during Phase 1 and update if the budget is wrong.
- [ ] Memory: Python process holds < 1 GB RSS during compute; sequential file processing.
- [ ] DB: bulk inserts use sequential `await`, no async transactions, no SQLITE_BUSY errors under normal load.
- [ ] Security: all server actions gated by `requirePermission` per CLAUDE.md.
- [ ] Spanish UI throughout, inlined in components for v1.

### Quality Gates

- [ ] Headline synthetic-bursts Python test passes
- [ ] All other Python unit tests pass (silent, white noise, corrupt header, too-short, missing file)
- [ ] Vitest tests for `getAcousticIndicesForProject` pass: empty state, low-coverage opacity, ODK-unreachable
- [ ] Playwright E2E test passes: trigger → wait → assert boxplots render
- [ ] `npm run lint` clean
- [ ] `npm run test:run` green
- [ ] `docker compose build` succeeds; `import maad` verified inside container

## Risks

- **R1 — SS / EPS port correctness.** Our NumPy ports of Burivalova 2018 and Towsey 2018 need to match the reference. *Mitigation*: the synthetic-bursts fixture is the single highest-value correctness gate. If it passes within tolerances, ship.
- **R2 — Sequential cron load.** Not in scope for v1 (cron integration deferred). If we add it in v2, *enqueue-and-go*, do not block — the runtime estimate of "sub-second per file" from the prior draft was unbenchmarked; real numbers will determine the cron contract.
- **R3 — `librosa.load` masking truncated files.** The post-load `len(y) < target_sr * 30` check catches this.
- **R4 — Mixed config versions in a single project.** Accepted tradeoff for v1: we use `ON CONFLICT DO UPDATE`, so the latest row wins per file. No render-time gate; just re-run if you change the algorithm.
- **R5 — ODK unreachable at read time.** The page degrades to an `"unknown"` habitat group rather than 500-ing.

## One-way doors (accepted tradeoffs)

- **1:1 with `ON CONFLICT DO UPDATE`** forecloses on time-series comparison ("show me how this index changed when we fixed the SS bug"). Accepted: storing versioned rows triples storage and complicates every read query. If the question matters later, migrate.
- **Denormalizing `recordedDate` / `dielPeriod`** onto `acoustic_indices` instead of `audio_files`. Accepted: avoids a larger migration. When `audio_files.recordedAt` lands (future iteration), these columns become redundant but harmless.
- **No staleness gating in v1.** If someone changes `CONFIG_VERSION` and queries the page, they may see a mix of old and new rows. Accepted: the v1 user is a small internal team; "delete and rerun" is documented.

## Deferred to v2 (explicitly, with triggers)

- **Per-deployment summary card** → ship when a user asks for site-level drill-down beyond what the jittered points on the boxplot page already show
- **Nightly cron integration** → ship when a user is annoyed by clicking "Calcular" repeatedly
- **CSV export** → ship when an ecologist asks for R-side data
- **Admin recompute UI / staleness banner** → ship if/when we change the algorithm and need to communicate it
- **NMDS multivariate ordination** → ship when the cross-site page no longer tells the whole story
- **BirdNET-based calibration** (5 indices → BirdNET NMDS axis-1) → ship when the descriptive comparison isn't quantitative enough for a funder
- **Hill-number coverage standardization** → ship when reviewers ask
- **Frequency banding** (biophony 2–8 kHz vs insects 8–22 kHz) → ship when one habitat type's pattern is clearly being masked
- **Adopt Müller 2023 published coefficients to score sites on a 0–1 recovery scale** → ship when we want one number per site
- **Backfill `audio_files.recordedAt`** → ship when BirdNET or annotations also need it

## Resource Requirements

- One engineer, **~2–3 working days** (revised from 5–8 after review cuts):
  - Phase 1 (DB + Python runner + venv + headline fixture): ~1 day
  - Phase 2 (orchestration + page + tests): ~1.5 days
- One ecologist available for ~1 hour: confirm Spanish copy and the expected-direction arrows are right for FCAT's habitat categories
- No new infrastructure

## References

### Internal

- **Brainstorm**: `docs/brainstorms/2026-05-11-audio-acoustic-indices-brainstorm.md`
- **BirdNET runner (TS / Python)**: `src/lib/birdnet-runner.ts`, `scripts/birdnet-runner.py` — template to mirror
- **BirdNET job action**: `src/app/audio/actions.ts:291-353` — single-flight + `after()` + worker
- **Audio cache**: `src/lib/audio-cache.ts` — `ensureAudioCached()`
- **Filename → timestamp**: `src/lib/audio-filename.ts:1-12`
- **Floating progress**: `src/components/floating-job-progress.tsx:168-174` (job-type branch)
- **SSE progress**: `src/app/api/progress/route.ts`
- **Boxplot component**: `src/app/biochoco/ibutton/box-plot-chart.tsx`
- **Habitat join pattern**: `src/app/biochoco/ibutton/actions.ts:36-54` (`loadSiteHabitatMap`)
- **Habitat colors**: `src/app/biochoco/habitat/types.ts:33-65`
- **Crash diagnostics**: `src/lib/ml-runner.ts:276-325`
- **ML venv setup**: `scripts/ensure-ml-venv.sh:148`
- **Job constants**: `src/lib/job-types.ts`
- **Permission helper**: `src/lib/auth.ts:107-133`
- **ActionResult type**: `src/lib/types.ts:19-29`

### Institutional Learnings

- `docs/solutions/runtime-errors/spectrogram-process-explosion-AudioCache-20260226.md` — DB single-flight is sufficient
- `docs/solutions/runtime-errors/async-transaction-better-sqlite3-CameraTrap-20260223.md` — never `async db.transaction`
- `docs/solutions/build-errors/pytorchwildlife-docker-install-failures.md` — verify imports inside container

### External

- **Müller, J. et al. (2023).** *Soundscapes and deep learning enable tracking biodiversity recovery in tropical forests.* Nat Commun 14, 6191. https://doi.org/10.1038/s41467-023-41693-w
- **Kümmet, S. et al. (2025).** *Acoustic Indices Predict Recovery of Tropical Bird Communities for Taxonomic and Functional Composition.* Conserv Lett 18, e13131. https://doi.org/10.1111/conl.13131
- **Pieretti, N. et al. (2011).** ACI canonical definition. Ecol Indic 11, 868–873.
- **Burivalova, Z. et al. (2018).** Soundscape Saturation algorithm. Conserv Biol 32, 205–215.
- **Towsey, M. (2018).** Events per Second algorithm. Zenodo.
- **scikit-maad** — https://scikit-maad.github.io/
