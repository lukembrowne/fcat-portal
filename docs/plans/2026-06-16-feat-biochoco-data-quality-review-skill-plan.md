---
title: "feat: BioChoco monthly data-quality review skill"
type: feat
date: 2026-06-16
status: implemented (v1 — integration path pending first in-container run)
related_research:
  - docs/plans/2026-05-18-feat-cronograma-in-row-editor-plan.md
  - docs/plans/2026-05-11-feat-biochoco-unified-results-dashboard-plan.md
  - docs/solutions/integration-issues/odk-form-field-restructuring-deploy-date.md
  - docs/solutions/integration-issues/odk-retrieve-date-field-restructured-20260224.md
  - docs/solutions/integration-issues/google-drive-recursive-file-counting-20260224.md
---

# feat: BioChoco monthly data-quality review skill 🔎

## Overview

Build a **Claude Code skill** (`biochoco-data-review`) that a developer runs once a month to produce a **critical, narrative review of the data status of every BioChoco deployment** and writes it to `docs/reviews/YYYY-MM-biochoco-review.md` (report body in **Spanish**, for sharing with the field/station team).

The skill is a two-layer design:

1. **A deterministic snapshot + checks script** (`scripts/biochoco-review-snapshot.ts`) that reuses the portal's existing modules (Sheets schedule, ODK lifecycle, Drive re-count, DB tables, iButton coverage, window QC) to gather one merged dataset, **force a live Drive re-count first**, run the rule-based checks, and emit a single JSON evidence file. No new SQL/Drive/ODK logic is invented — it composes what already powers `/biochoco/data` and `/api/cron/nightly-refresh`.
2. **The skill prompt** (`.claude/skills/biochoco-data-review/SKILL.md`) that runs the script, then applies *judgment* the rigid rules can't: cross-referencing `fieldNotes` to separate benign from real findings, prioritizing, interpreting month-over-month trends, and authoring the Spanish report with concrete recommended actions.

> **Division of labor:** the script produces *facts and flags* (so nothing is hallucinated or mis-counted); the skill produces *criticism, prioritization, and narrative* (the reason a human-run skill beats a static cron email — which is why the "Claude Code skill" delivery was chosen over an in-app page or scheduled email).

## Problem Statement / Motivation

BioChoco runs a stratified, schedule-driven (cronograma) sampling program across many camera-trap / audio / iButton deployments fanned out over multiple Google Shared Drives. Today there is **no single place that answers "is our data actually complete and on-schedule?"** The `/biochoco/data` page shows per-deployment upload counts, but:

- It doesn't reconcile counts against the **cronograma schedule** ("this site should have been retrieved 5 weeks ago and wasn't").
- It doesn't flag **retrieved-but-empty** or **partial** deployments as *problems* — you have to eyeball the table.
- It surfaces no **missing-metadata** issues (null coordinates, missing site names).
- There's no **monthly cadence** or month-over-month trend — issues silently persist.

The result is data loss caught late: a sensor never retrieved, a retrieval whose SD card was never uploaded, a camera whose clock was wrong so all timestamps fall outside the deployment window. The cost of a missed deployment is an irreplaceable gap in a longitudinal biodiversity dataset.

This skill gives the team a repeatable monthly "critical review" pass that catches these early and produces a shareable Spanish report.

## Goals

- One command produces a complete, **trustworthy** (script-computed, not LLM-counted) Spanish data-quality report for all active BioChoco deployments.
- Reconcile **schedule (cronograma) ⨯ ODK lifecycle ⨯ Drive uploads ⨯ DB tables** in one view.
- Implement the **8 confirmed checks** (below), with severity tiers and per-deployment evidence.
- **Force a live Drive re-count** before analysis so upload status reflects ground truth, not stale cache.
- Provide **month-over-month comparison** (what's new, what's resolved, what's persisted).
- Be re-runnable monthly with zero code changes; cheap to maintain.

## Non-Goals

- ❌ No in-app page or dashboard (explicitly deferred — "Claude Code skill" was chosen).
- ❌ No scheduled cron / automated email (the skill is dev-invoked on demand).
- ❌ No *mutations* — the skill is read-only except for (a) the live Drive re-count writing refreshed counts back to the DB (same write the existing "Actualizar Conteo" button already does) and (b) writing the markdown report. It does not edit the schedule, ODK, or deployment rows.
- ❌ No schema changes (uses existing columns and tables).

## Architecture

### Data flow

```
/biochoco-data-review  (Claude runs the skill)
   │
   ├─ 1. Run snapshot script (in Docker container, ~minutes due to live re-count)
   │     docker compose exec -T portal npx tsx scripts/biochoco-review-snapshot.ts \
   │        --out data/reviews/snapshot-2026-06.json
   │        │
   │        ├─ force live Drive re-count for ALL deployments  (reuse refresh worker)
   │        ├─ loadSchedule()           → plannedDeploy/Retrieve, habitat, season, siteId
   │        ├─ ODK lifecycle + dates    → deployed?/retrieved? + actual dates (fallback chains)
   │        ├─ DB read: deployments, biochoco_images (window), audio_files,
   │        │            ibutton_uploads/coverage, biochoco_processing_jobs
   │        ├─ run the 8 rule-based checks → findings[]
   │        └─ emit JSON { generatedAt, totals, deployments[], findings[], driveErrors[] }
   │
   ├─ 2. Claude loads JSON, reads previous report (docs/reviews/<prev>.md),
   │     cross-references fieldNotes, prioritizes, interprets trends
   │
   └─ 3. Claude writes docs/reviews/2026-06-biochoco-review.md  (Spanish)
         + optional one-line console summary back to the user
```

### Why a script + skill (not pure-prompt, not pure-script)

- **Pure prompt** (Claude runs ad-hoc SQL/Drive calls): fragile, slow, easy to mis-count or miss the ODK field-restructuring fallback chains. Rejected.
- **Pure script** (script writes the markdown itself): loses the critical/narrative value (cross-referencing field notes, "this is benign because X", prioritization, trend interpretation) — which is the entire reason the user chose the skill route. Rejected.
- **Script (facts) + skill (judgment)**: deterministic evidence + LLM reasoning. Chosen.

## The snapshot + checks script — `scripts/biochoco-review-snapshot.ts`

**Run as:** `docker compose exec -T portal npx tsx scripts/biochoco-review-snapshot.ts [--out <path>] [--no-recount]`
(Note per `gotcha_host_scripts_corrupt_sqlite_under_docker` and `gotcha_ml_venv_host_vs_container`: must run **inside the container**, never bare host. `--no-recount` is an escape hatch for a fast dry run during development; the monthly run always re-counts.)

### Reused modules (do NOT reimplement)

| Concern | Reuse | Source (from research) |
|---|---|---|
| Live Drive re-count (all deployments) | the per-deployment refresh used by `/biochoco/data` "Actualizar Conteo" and `/api/cron/nightly-refresh` | `refreshSingleUploadCount()` (biochoco data actions); nightly-refresh worker; `countFilesRecursive()` in `src/lib/drive-client.ts` |
| Schedule (cronograma) | `loadSchedule()` | `src/lib/sheets-client.ts`; types `src/lib/schedule-types.ts` |
| ODK lifecycle + actual dates | the deployed/retrieved + date extraction used by the data page | `src/app/biochoco/data/actions.ts` (`getDeploymentStatus` logic, `overview/types.ts:44-52`); ODK constants `src/lib/odk-constants.ts` |
| iButton coverage | `computeCoverage()` | `src/app/biochoco/ibutton/coverage.ts:34-86` |
| Files-outside-window QC | existing WindowQcResult helper | per data-page upload cells (image `exifTimestamp`, audio `modifiedAt`) |
| Habitat lookup | `habitat-lookup` (cached) | `src/lib/habitat-lookup.ts` |

> **Gotcha to honor (from docs/solutions):** ODK forms were restructured Feb 2026. Deploy date = `deployment_info.deploy_date ?? site_selection.fecha_instalacion ?? sub.fecha_instalacion`; retrieve date = `retrieval_info.retrieval_date ?? site_selection.fecha_recuperacion ?? sub.fecha_recuperacion`. Use the existing extraction code, don't rewrite the field paths. Also: Drive calls need `supportsAllDrives: true` + `includeItemsFromAllDrives: true` or they silently return empty.

### Output JSON schema (`data/reviews/snapshot-YYYY-MM.json`)

```jsonc
{
  "generatedAt": "2026-06-16T14:00:00-05:00",
  "totals": {
    "deployments": 0, "scheduled": 0, "deployed": 0, "retrieved": 0,
    "withFindings": 0, "driveRecountFailures": 0
  },
  "deployments": [
    {
      "deploymentId": "SEC-009_V1", "siteId": "SEC-009", "siteName": "...",
      "habitat": "primary_forest", "season": "wet_transition",
      "lifecycle": "retrieved",            // scheduled | deployed | retrieved
      "plannedDeployDate": "2026-04-12", "plannedRetrieveDate": "2026-05-12",
      "actualDeployDate": "2026-04-12", "actualRetrieveDate": null,
      "latitude": null, "longitude": -78.9,
      "expectedTypes": ["camera","audio","ibutton"],   // see design decision below
      "counts": { "camera": 0, "audio": 1240, "ibutton": 1 },
      "countsCheckedAt": "2026-06-16T14:00:00-05:00",
      "recountError": null,
      "ibuttonCoveragePct": 87.4,
      "filesOutsideWindow": { "camera": 0, "audio": 3, "ibutton": 0 },
      "processing": { "status": "processed", "failedImages": 0, "detections": 0, "verifiedEmpty": false },
      "fieldNotes": "Cámara con problema de batería"
    }
  ],
  "findings": [
    { "check": "overdue_retrieval", "severity": "error", "deploymentId": "SEC-009_V1",
      "summary": "Recuperación vencida hace 35 días", "evidence": { "daysOverdue": 35, "plannedRetrieveDate": "2026-05-12" } }
  ],
  "driveErrors": [ { "deploymentId": "...", "error": "..." } ]
}
```

## The 8 checks (confirmed scope)

Severity tiers: **error** (likely data loss / overdue action), **warn** (needs review / possibly benign), **info** (FYI). Days thresholds are starting defaults — tune during review.

| # | Check (ES name) | Rule | Source | Severity |
|---|---|---|---|---|
| 1 | **Recuperación vencida** (overdue retrieval) | `plannedRetrieveDate < today` AND no `retrieve_sensors` submission (lifecycle ≠ retrieved) | Sheets + ODK | `error` if >14d overdue, else `warn` |
| 2 | **Instalación vencida** (overdue installation) | `plannedDeployDate < today` AND no `instalar_sensores` submission (lifecycle == scheduled) | Sheets + ODK | `error` if >14d, else `warn` |
| 3 | **Recuperada sin datos** (retrieved, no data) | lifecycle == retrieved AND `camera+audio+ibutton` all 0/null after live re-count | ODK + Drive re-count | `error` |
| 4 | **Datos parciales** (partial upload) | lifecycle == retrieved AND `expectedTypes` ⊋ `uploadedTypes` (≥1 expected type present, ≥1 missing) | ODK/folders + Drive | `warn` |
| 5 | **Sin coordenadas / coordenadas implausibles** | `latitude` OR `longitude` NULL **or** outside the BioChoco study-area bounding box (catches GPS typos) | DB (cached from ODK site entity) | `warn` (`error` if deployed/retrieved) |
| 6 | **Conteo no verificable** (re-count failed) | live Drive re-count threw for this deployment → upload status unknown | Drive re-count error | `warn` |
| 7 | **Archivos fuera de ventana** (files outside window) | image/audio/iButton timestamps outside `[actualDeployDate, actualRetrieveDate]` | DB timestamps + ODK window QC | `warn` |
| 8 | **Salud de procesamiento iButton/ML** | iButton coverage <95% **or** failed processing job / `failedImages>0` **or** `processed` w/ 0 detections & not `verified_empty` (awaiting confirmation) | DB | `warn` |

### Design decision — "expected data types" (for check #4, partial uploads)

Not every site has all three sensors, so "partial" needs an *expected* baseline. Resolution order (most → least authoritative):

1. **ODK `instalar_sensores`** — which sensors the field team recorded as installed (preferred; it's ground truth of what was placed).
2. **Drive subfolder presence** — `uploadCameraFolderId` / `uploadAudioFolderId` / `uploadIbuttonFolderId` non-null implies that type is expected.
3. **Fallback: all three** — if neither signal is available, assume all three and emit the finding at `info` (so it's visible but not alarming until confirmed).

The script records `expectedTypesSource` per deployment so the report can say *why* a type was considered missing. **This is the one place to confirm the ODK field name with Luke during implementation** (which `instalar_sensores` field encodes installed-sensor selection).

## The skill — `.claude/skills/biochoco-data-review/SKILL.md`

### Frontmatter

```yaml
name: biochoco-data-review
description: >
  Run a monthly critical data-quality review of all BioChoco deployments
  (camera-trap, audio, iButton). Reconciles the cronograma schedule, ODK
  lifecycle, live Google Drive upload counts, and DB tables; flags overdue
  retrievals/installations, retrieved-but-empty and partial uploads, missing
  coordinates, files outside the deployment window, and processing-health
  issues. Writes a Spanish report to docs/reviews/. Use when asked for the
  monthly BioChoco data review / "revisión de datos BioChoco".
```

### Skill workflow (instructions the prompt encodes)

1. **Pre-flight**: confirm the dev container is up (`docker compose ps`); warn the user the live re-count takes several minutes.
2. **Gather**: run the snapshot script with `--out data/reviews/snapshot-<YYYY-MM>.json`. Surface any `driveErrors` to the user.
3. **Load**: read the JSON. Read the most recent previous report in `docs/reviews/` for month-over-month diffing.
4. **Reason (the critical layer)**: for every finding, check the deployment's `fieldNotes` — many findings are *explained* (e.g. "cámara con problema de batería" explains 0 camera files). Down-rank explained findings to `info` with a note; keep unexplained ones at full severity. Prioritize `error`s, then high day-counts.
5. **Compare**: classify each finding as **nuevo** (new this month), **persistente** (also in last report), or note **resueltos** (in last report, gone now).
6. **Write** `docs/reviews/<YYYY-MM>-biochoco-review.md` (template below), in Spanish.
7. **Summarize**: print a one-line console summary (counts by severity) and the report path.

### Report template (Spanish)

```markdown
# Revisión de datos BioChocó — junio 2026
_Generado: 2026-06-16 · N instalaciones revistas · recuento de Drive en vivo_

## Resumen ejecutivo
- 🔴 Errores: N   🟡 Advertencias: N   🔵 Informativos: N
- Lo más urgente: <1–3 frases priorizando las acciones del mes>

## Comparación con el mes anterior
- Nuevos hallazgos: N · Persistentes: N · Resueltos: N
- <tendencia: mejora/empeora; cifras de uploadCountSnapshots si aplica>

## 1. Recuperación vencida
| Instalación | Hábitat | Plan recup. | Días vencido | Notas de campo |
| ... |
> Acción recomendada: ...

## 2. Instalación vencida
## 3. Recuperadas sin datos
## 4. Datos parciales
## 5. Coordenadas faltantes o implausibles
## 6. Conteos no verificables (errores de Drive)
## 7. Archivos fuera de la ventana de despliegue
## 8. Salud de procesamiento (iButton / ML)

## Hallazgos explicados por notas de campo
<findings down-ranked because fieldNotes explain them>

## Apéndice — metodología y fuentes
- Fuentes: cronograma (Sheets), ODK (instalar/retrieve_sensors), recuento Drive en vivo, BD.
- Umbrales usados; supuestos de "tipos esperados".
- Snapshot: data/reviews/snapshot-2026-06.json
```

## Edge cases (must handle)

- **Null dates from ODK restructuring** → use fallback chains; if still null, the deployment can't be schedule-checked → list under a "datos insuficientes" note, not as a false negative.
- **Schedule row with no DB deployment (and vice versa)** → linkage by `schedule.deploymentId == biochoco_deployments.name`. Mismatches are surfaced as a data-integrity note (orphans/duplicates) rather than silently dropped (see deferred check D1).
- **Excluded deployments** (`excluded = true`) → exclude from findings by default but report the count, so QA-excluded rows don't generate noise.
- **`uploadCountsCheckedAt` immediately after re-count** → check #6 fires only on *re-count failure*, not staleness (we just re-counted).
- **Drive re-count partial failure** → continue with cached values for failed ones, mark `recountError`, emit check #6; never abort the whole run.
- **Timezone**: iButton/file timestamps are local Ecuador (UTC-5), stored as strings — compare as strings/local, do not assume UTC (per `iButton timestamps are local Ecuador time` memory).
- **better-sqlite3**: any script writes must be synchronous transactions or sequential awaits — never `db.transaction(async …)`.
- **First run** (no previous report) → skip the comparison section gracefully.

## Additional checks considered — answering "what else should we check?" (deferred)

Strong candidates intentionally **out of the confirmed 8** (cheap to add later; listed so the full thinking is on record):

- **D1 — Integridad de enlace**: schedule rows with no DB deployment, DB deployments with no schedule row, duplicate `name`s. (High value, cheap — recommend promoting to core in v2.)
- **D2 — Drive vs BD desalineados**: `uploadCameraCount` (Drive) ≠ processed rows in `biochoco_images` → uploaded but never scanned/processed.
- **D3 — Shared Drive sin asignar**: `sharedDriveId` null while routing is enabled.
- **D4 — Anomalía de fechas**: `actualDeployDate > actualRetrieveDate`, or actual far from planned (>N days drift).
- **D5 — Fotos setup/retiro faltantes**: no image tagged `setupTag = deployment`/`retrieval` → can't verify camera operation.
- **D6 — Datos llegando tarde**: `uploadNewestDate` long after `actualRetrieveDate` (backfilled or mis-dated).

## Reuse map (concrete anchors from research)

- Drive re-count: `refreshSingleUploadCount()` (biochoco data actions); `/api/cron/nightly-refresh/route.ts`; `countFilesRecursive()` `src/lib/drive-client.ts`; snapshots table `uploadCountSnapshots` `src/db/schema.ts:1157`.
- Schedule: `loadSchedule()` `src/lib/sheets-client.ts:108`; `ScheduleRow` `src/lib/schedule-types.ts:7-34`.
- ODK lifecycle/status + dates: `src/app/biochoco/data/actions.ts:79-89`; `src/app/biochoco/overview/types.ts:44-52`; constants `src/lib/odk-constants.ts:20-21` (`instalar_sensores`, `retrieve_sensors`).
- iButton coverage: `src/app/biochoco/ibutton/coverage.ts:34-86`.
- Deployment columns (counts, coords, folders, fieldNotes, excluded): `src/db/schema.ts:128-211`.
- Data page UI (model for what evidence to show): `src/app/biochoco/data/page.tsx` (UploadStatusTable).

## Acceptance Criteria

- [x] `scripts/biochoco-review-snapshot.ts` written — forces a live Drive re-count then writes a valid JSON snapshot (counts re-count failures, `--no-recount`/`--today`/`--out` flags). _Integration run pending in-container._
- [x] The check engine computes all **8** confirmed checks with per-deployment evidence and correct severity tiers (verified by 24 unit tests).
- [x] Date extraction uses the ODK fallback chains (`loadOdkLifecycle` in `biochoco-review-core.ts`, mirroring `loadOdkDateTimes`).
- [x] `.claude/skills/biochoco-data-review/SKILL.md` runs the script, reads the prior report, and writes a Spanish report to `docs/reviews/<YYYY-MM>-biochoco-review.md`.
- [x] SKILL prescribes: executive summary with severity counts, month-over-month comparison, one section per check with tables, and a "explained by field notes" section.
- [x] SKILL instructs findings explained by `fieldNotes` to be down-ranked (not dropped) and labeled.
- [x] Excluded deployments are omitted from findings but counted in totals (verified by unit test + script totals).
- [x] Drive re-count failures degrade gracefully (`recountAllUploads` collects per-deployment errors → `recount_failed` finding), never aborting the run.
- [x] Re-running the same month overwrites cleanly and is idempotent (deterministic `--out` path per month; pure JSON write).
- [x] Running on a fresh month with no prior report works (SKILL skips the comparison section gracefully).
- [x] No schema changes; the only DB writes are the existing refreshed-count updates (same `UPDATE` as `refreshSingleUploadCount`).

> **Verified locally:** `npx vitest run tests/unit/biochoco-review-checks.test.ts` (24 passing), `npx tsc --noEmit` (no errors in new files), `npx eslint` (clean). **Pending:** first in-container run of the snapshot script against real DB/Drive (validates the gather queries, `images.exifTimestamp` format assumption for window QC, and re-count timing).

## Dependencies & Risks

- **Live re-count cost/rate limits**: re-counting every deployment hits the Drive API hard (recursive, paginated, per-deployment). Risk of rate-limit 403s. Mitigation: reuse the existing rate-gated client; honor `gotcha_drive_write_rate_gate` / `gotcha_gaxios_v7_retry_reason`; tolerate per-deployment failures (check #6). Consider a `--since` / project filter if runtime is too long.
- **ODK field drift**: another form restructuring would reintroduce null dates. Mitigation: reuse existing extraction; the "datos insuficientes" bucket makes drift visible instead of silently wrong.
- **"Expected types" accuracy** (check #4): depends on the ODK install-sensors field. Mitigation: documented resolution order + `expectedTypesSource` + `info` fallback. One field name to confirm with Luke.
- **Container must be running** with Drive/Sheets/ODK creds (same as nightly-refresh). Skill pre-flight checks this.
- **Report trust**: counts come from the script, never from the LLM, to avoid hallucinated numbers.

## File Manifest

**New (as built)**
- `src/lib/biochoco-review-checks.ts` — pure check engine (8 checks, types). + `tests/unit/biochoco-review-checks.test.ts` (24 tests).
- `src/lib/biochoco-review-core.ts` — auth-agnostic gather + live re-count + `buildReviewSnapshot` + `ecuadorToday`. Composes existing modules; **no production files modified**.
- `src/app/api/cron/biochoco-review/route.ts` — **production execution path**: server-side route (cron-secret auth, localhost-only) that runs `buildReviewSnapshot` and returns JSON. Defaults to nightly-fresh cached counts; `?recount=true` forces a live re-count. Records a `cron_biochoco_review` system event.
- `scripts/run-biochoco-review.mjs` — plain-node in-container trigger that POSTs to the route and prints the JSON (CRON_SECRET never leaves the container). Avoids the prod tsx-pruning gotcha.
- `scripts/biochoco-review-snapshot.ts` — local/dev tsx runner (writes JSON file). Secondary path.
- `.claude/skills/biochoco-data-review/SKILL.md` — the skill (note: `.claude/` is gitignored → local-only unless tracked deliberately).
- `docs/reviews/` (README + reports). Snapshot JSON lives under `data/reviews/` (already gitignored via `/data/`).

**Production execution (decided post-plan)**
Data lives in prod, where the standalone image prunes `tsx` and the slow re-count doesn't fit an HTTP call — but the nightly-refresh cron already keeps counts ~24h fresh. So the prod path is the API route + node trigger, not the tsx script. The skill runs:
`ssh digitalocean "cd /root/opt/fcat-portal && docker compose exec -T portal node scripts/run-biochoco-review.mjs"` → captures JSON → writes the Spanish report. **Requires deploying the route (`./deploy.sh`).**

**Modified**
- None. (The core deliberately mirrors the ODK fallback chains from `loadOdkDateTimes`/`fetchSchedule` rather than refactoring those server files, keeping the working tree low-risk.)

## Testing

- **Unit (Vitest)**: pure check functions — feed synthetic deployment records, assert findings + severities (overdue boundaries at 0/14/15 days; retrieved-empty; partial with each `expectedTypesSource`; null-coordinate; bbox-outlier; window-outlier; coverage <95%). These run without Drive/ODK.
- **Snapshot smoke**: run `--no-recount` in-container against real DB; assert JSON shape and non-empty totals.
- **Skill dry-run**: invoke the skill against a committed fixture JSON to verify report rendering and the comparison logic, without hitting Drive.

## Open Questions

1. **Importability**: can a `scripts/*.ts` cleanly import `src/app/biochoco/data/actions.ts` (a `"use server"` file)? If not, extract the needed date/window/expected-types/re-count helpers into a plain `src/lib/biochoco-review-core.ts` (auth-agnostic, like `audio-compression-core.ts`) that both the server action and the script import. **Recommended approach regardless** — keeps the script decoupled from Next server-action wiring.
2. **ODK install-sensors field name** for `expectedTypes` (check #4) — confirm exact path.
3. **Commit snapshots?** Reports (`*.md`) yes; raw JSON snapshots probably gitignored (can be large). Confirm.
4. **Study-area bounding box** for the coordinate-plausibility sub-rule of check #5 — get the lat/lng bounds for the BioChoco region.
5. **Should the skill record a `system_events` entry** (source `biochoco-...`, eventType e.g. `data_quality_review`, severity by worst finding) so the run shows in `/admin/activity`? Cheap, consistent with project instrumentation policy — recommend **yes** as a v1.1 nicety.
