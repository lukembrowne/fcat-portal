---
title: iButton — Deployment Window & Coverage Metric
type: feat
date: 2026-04-08
brainstorm: docs/brainstorms/2026-04-08-ibutton-deployment-window-coverage-brainstorm.md
---

# iButton — Deployment Window & Coverage Metric

## Overview

Surface the **ODK-recorded deployment window** (install datetime → retrieval
datetime) and a **coverage metric** on both the Temperatura deployments table
and the per-deployment detail page. The coverage metric compares the number
of readings stored in the portal DB against the number expected given the
iButton sample rate and the ODK window. Deployments below 95% coverage show
a warning badge. The chart on the detail page gets vertical reference lines
marking the ODK install and retrieve times.

This is purely observational — no clock-skew correction, no changes to ingest
truncation, no new DB columns. The existing ingest-time window filter
(`src/app/biochoco/ibutton/actions.ts:248-269`) stays in place.

## Problem Statement / Motivation

Field technicians record install and retrieve datetimes via ODK forms.
iButton sensors have independent internal clocks that can drift or be set
incorrectly. After ingest truncation, the portal shows only in-window
readings — but there's currently no way to tell:

1. Whether the deployment actually produced readings across the full window
   (sensor died mid-way? clock skewed so half the readings were dropped?)
2. What the declared ODK window even was (only `date_range_start/end` of the
   stored readings is visible, not the ODK intent)
3. Whether there are large gaps inside a deployment

All three questions matter for QA and for deciding whether a deployment's
data is trustworthy for downstream habitat-level aggregations.

## Proposed Solution

Augment existing server actions with four derived values per deployment:

| Field | Source |
|---|---|
| `odkDeployAt` | `loadOdkDateTimes()` map, keyed by `deployment.name` |
| `odkRetrieveAt` | `loadOdkDateTimes()` map, keyed by `deployment.name` |
| `expectedReadings` | `floor(windowSeconds / intervalSeconds) + 1` |
| `coveragePct` | `round(rowsImported / expectedReadings * 100)` capped at 100 |
| `maxGapSeconds` | Per-deployment max LAG between consecutive reading timestamps |

Then render these in two places:

1. **Deployments table** (`deployments-table.tsx`): new `Cobertura` column with
   percentage + warning icon when `< 95%`. Tooltip shows ODK window, expected
   vs actual counts, and largest gap in a human-readable form.
2. **Deployment detail page** (`[id]/page.tsx`): new "Ventana de despliegue"
   card inside `StatsPanel` showing ODK install, ODK retrieve, duration,
   expected count, actual count, coverage %, and largest gap. Chart gets two
   `ReferenceLine` verticals at the ODK install/retrieve timestamps.

No DB migration. No changes to ingest. All fields computed on read.

## Technical Considerations

### Sample rate parsing

`ibuttonUploads.sampleRate` is a raw string from the iButton XLSX header
(`src/app/biochoco/ibutton/parser.ts:119`). Observed formats in the wild
include `"30 min"`, `"00:30:00"`, `"1 hr"`. Add a helper:

```ts
// src/app/biochoco/ibutton/sample-rate.ts
export function parseSampleRateSeconds(raw: string | null): number | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  // "HH:MM:SS"
  const hms = s.match(/^(\d+):(\d+):(\d+)$/);
  if (hms) return +hms[1] * 3600 + +hms[2] * 60 + +hms[3];
  // "N min", "N minute(s)"
  const min = s.match(/^(\d+)\s*(min|minute|minutes)$/);
  if (min) return +min[1] * 60;
  // "N hr", "N hour(s)"
  const hr = s.match(/^(\d+)\s*(hr|hour|hours)$/);
  if (hr) return +hr[1] * 3600;
  // "N sec", "N second(s)"
  const sec = s.match(/^(\d+)\s*(s|sec|second|seconds)$/);
  if (sec) return +sec[1];
  return null;
}
```

**Fallback when unparseable:** derive from stored data — `(dateRangeEnd -
dateRangeStart) / (rowsImported - 1)`. Keep this fallback in the action, not
in the parser.

### Coverage computation

```ts
// src/app/biochoco/ibutton/coverage.ts
import { parseSampleRateSeconds } from "./sample-rate";

export interface CoverageInputs {
  odkDeployAt: string | null;        // "YYYY-MM-DD HH:mm:ss"
  odkRetrieveAt: string | null;
  sampleRate: string | null;          // raw from iButton header
  rowsImported: number;
  dateRangeStart: string | null;      // first stored reading
  dateRangeEnd: string | null;        // last stored reading
}

export interface CoverageResult {
  odkDeployAt: string | null;
  odkRetrieveAt: string | null;
  intervalSeconds: number | null;
  expectedReadings: number | null;
  coveragePct: number | null;         // null when window unknown
  hasLowCoverage: boolean;
}

export function computeCoverage(inputs: CoverageInputs): CoverageResult;
```

- Parse timestamps with `Date.parse(s.replace(" ", "T") + "Z")` — they are
  naive Ecuador local time (UTC-5) but for duration arithmetic the offset
  cancels, so treating as UTC is safe.
- If interval can't be determined from header AND `rowsImported < 2`,
  return `coveragePct: null`.
- `hasLowCoverage = coveragePct !== null && coveragePct < 95`.

### Max gap (SQL)

Use a correlated subquery with `LAG()` to compute per-deployment max gap in
a single query. Drizzle doesn't have native `LAG` sugar, so use `sql` tag:

```ts
// inside fetchProcessedDeployments — new column in the select list
maxGapSeconds: sql<number | null>`(
  SELECT MAX(gap_seconds) FROM (
    SELECT (strftime('%s', timestamp) -
            strftime('%s', LAG(timestamp) OVER (ORDER BY timestamp))) AS gap_seconds
    FROM ibutton_readings
    WHERE deployment_id = ${deployments.id}
  )
)`,
```

This runs per deployment as a subquery. Cost: a single index scan on
`idx_ibutton_readings_dep` per row, ~24 scans × ~1400 rows each = trivial on
SQLite with WAL.

### ODK times in detail action

`fetchDeploymentReadings()` currently doesn't call `loadOdkDateTimes()`. Add
the call and look up both values by `dep.name`.

### Missing ODK time-of-day

The existing helper pads missing times to `00:00:00` / `23:59:59`. That makes
coverage math over-optimistic. **Mitigation:** track whether the time was
padded and surface `"hora aproximada"` in the UI. Simplest implementation:
extend `loadOdkDateTimes()` return type from `Map<string, string>` to
`Map<string, { dt: string; timeKnown: boolean }>`. All existing callers
(`processAllIbutton`, `reprocessDeployment`) switch to `.dt` — no logic
change for them.

## Acceptance Criteria

### Functional

- [x] `DeploymentSummary` includes `odkDeployAt`, `odkRetrieveAt`,
      `odkTimeKnown`, `expectedReadings`, `coveragePct`, `maxGapSeconds`,
      `hasLowCoverage`.
- [x] `DeploymentDetail` (the `upload` block) includes the same fields.
- [x] Temperatura deployments table (`deployments-table.tsx`) shows a
      `Cobertura` column with percentage. Sub-95% rows show an amber warning
      icon next to the percentage, with a hover tooltip showing:
      `ODK: {deploy} → {retrieve}`, `{actual} / {expected} lecturas`,
      `Brecha máxima: {humanGap}`.
- [x] The column is sortable; deployments with `coveragePct === null` sort
      last regardless of direction.
- [x] Deployment detail page (`[id]/page.tsx`) shows a new
      "Ventana de despliegue" card inside `stats-panel.tsx` with ODK
      install, ODK retrieve, window duration, expected, actual,
      coverage %, and max gap (human-formatted, e.g., `2h 15m`).
- [x] Temperature line chart (`temperature-line-chart.tsx`) draws two
      vertical `ReferenceLine` markers at `odkDeployAt` and `odkRetrieveAt`
      (when present) labeled "Instalación" and "Retiro".
- [x] When `odkTimeKnown === false`, UI labels the timestamp with
      "(hora aproximada)" so users don't trust a padded window.
- [x] When coverage cannot be computed (missing ODK window or unparseable
      sample rate with insufficient readings), show `—` in the table and
      "No disponible" in the detail card. No warning badge.
- [x] Ingest behavior in `processAllIbutton` and `reprocessDeployment` is
      unchanged (same readings written, same truncation semantics).

### Non-Functional

- [x] No DB migration. No new columns on `ibutton_uploads` or `deployments`.
- [x] `fetchProcessedDeployments` latency stays under 500ms for ~30
      deployments on prod-sized data (verify via `time` on a local copy).
- [x] Spanish UI strings throughout (`Cobertura`, `Ventana de despliegue`,
      `Instalación`, `Retiro`, `Brecha máxima`, `Hora aproximada`).

### Quality Gates

- [x] Unit tests for `parseSampleRateSeconds` covering the 4 formats +
      nulls + garbage.
- [x] Unit tests for `computeCoverage` covering: happy path, missing ODK
      times, unparseable sample rate with fallback, unparseable with too
      few readings (null), coverage cap at 100%, `hasLowCoverage` threshold.
- [x] `npm run test:run` passes.
- [x] `npm run lint` passes.
- [x] `npm run build` passes.
- [x] Manual smoke test: visit `/biochoco/ibutton`, confirm column renders;
      click into one deployment, confirm card + chart markers render;
      intentionally create a low-coverage scenario (e.g., delete rows with
      a direct SQL statement on a throwaway DB) and verify the badge.

## Implementation Phases

### Phase 1 — Pure logic + tests

Files:

- `src/app/biochoco/ibutton/sample-rate.ts` (new)
- `src/app/biochoco/ibutton/coverage.ts` (new)
- `tests/unit/ibutton-sample-rate.test.ts` (new)
- `tests/unit/ibutton-coverage.test.ts` (new)

```ts
// tests/unit/ibutton-sample-rate.test.ts
describe("parseSampleRateSeconds", () => {
  it("parses HH:MM:SS", () => expect(parseSampleRateSeconds("00:30:00")).toBe(1800));
  it("parses '30 min'", () => expect(parseSampleRateSeconds("30 min")).toBe(1800));
  it("parses '1 hr'", () => expect(parseSampleRateSeconds("1 hr")).toBe(3600));
  it("returns null for garbage", () => expect(parseSampleRateSeconds("abc")).toBeNull());
  it("returns null for null", () => expect(parseSampleRateSeconds(null)).toBeNull());
});
```

```ts
// tests/unit/ibutton-coverage.test.ts
describe("computeCoverage", () => {
  it("computes 100% for a clean 30-min window", () => {
    const r = computeCoverage({
      odkDeployAt: "2026-03-01 09:00:00",
      odkRetrieveAt: "2026-03-01 19:00:00",
      sampleRate: "30 min",
      rowsImported: 21, // 10h / 30min + 1
      dateRangeStart: "2026-03-01 09:00:00",
      dateRangeEnd: "2026-03-01 19:00:00",
    });
    expect(r.coveragePct).toBe(100);
    expect(r.hasLowCoverage).toBe(false);
  });
  it("flags low coverage", () => { /* 50% scenario */ });
  it("falls back to derived interval when sampleRate unparseable", () => { /* ... */ });
  it("returns null when window unknown", () => { /* missing odk times */ });
});
```

### Phase 2 — Wire into server actions

Files:

- `src/app/biochoco/ibutton/actions.ts`
- `src/app/biochoco/ibutton/types.ts`

Changes:

1. Modify `loadOdkDateTimes()` return type to include `timeKnown: boolean`.
   Update existing call sites at lines 215, 249-251, 387-389 to use `.dt`.
2. Add `odkDeployAt`, `odkRetrieveAt`, `odkTimeKnown`, `expectedReadings`,
   `coveragePct`, `maxGapSeconds`, `hasLowCoverage` to `DeploymentSummary`
   and `DeploymentDetail.upload`.
3. In `fetchProcessedDeployments()` (line 649):
   - Call `loadOdkDateTimes()` once.
   - Add the `maxGapSeconds` subquery to the `select`.
   - In the map at line 679, call `computeCoverage(...)` per row and merge
     the result into the returned object.
4. In `fetchDeploymentReadings()` (line 481):
   - Call `loadOdkDateTimes()`.
   - Compute `maxGapSeconds` from the already-loaded `readings` array
     (no separate query — they're in memory).
   - Merge coverage result into the returned `upload` object.

### Phase 3 — UI: deployments table

File: `src/app/biochoco/ibutton/deployments-table.tsx`

1. Add `"coveragePct"` to the `SortKey` union (line 24).
2. Add sort case in `sorted` memo (line 49) with null-last semantics.
3. Add `<TableHead>` for `Cobertura` after the Temp triple column (~line 164).
4. Add `<TableCell>` rendering percentage + amber `<AlertTriangle>` when
   `hasLowCoverage`. Wrap in `<Tooltip>` showing window + counts + max gap
   (use `@/components/ui/tooltip` if already used in the project; else
   `title={...}` attribute is acceptable for MVP).
5. Add a small helper `formatDuration(seconds: number): string` inline or
   in `coverage.ts` for the `2h 15m` / `45m` / `3d 2h` formatting.

### Phase 4 — UI: detail page + chart

Files:

- `src/app/biochoco/ibutton/[id]/stats-panel.tsx`
- `src/app/biochoco/ibutton/[id]/temperature-line-chart.tsx`
- `src/app/biochoco/ibutton/[id]/deployment-detail-shell.tsx`

Changes:

1. `stats-panel.tsx`: add a third `<Card>` (or nest into existing grid) titled
   "Ventana de despliegue" with rows: Instalación ODK, Retiro ODK, Duración,
   Lecturas esperadas, Lecturas reales, Cobertura, Brecha máxima. Show
   "(hora aproximada)" suffix when `odkTimeKnown === false`. Use
   `text-amber-600` for coverage when `hasLowCoverage`.
2. `temperature-line-chart.tsx`: accept optional
   `odkDeployAt?: string; odkRetrieveAt?: string;` props. For each that's
   present, render:
   ```tsx
   <ReferenceLine
     x={odkDeployAt}
     stroke="#059669"
     strokeDasharray="4 2"
     label={{ value: "Instalación", position: "insideTopLeft", fontSize: 10 }}
   />
   ```
   and the retrieve equivalent in red. Use distinct colors from the mean
   line (currently `#9ca3af`).
3. `deployment-detail-shell.tsx`: thread `upload.odkDeployAt` /
   `upload.odkRetrieveAt` from `data.upload` into `<TemperatureLineChart>`
   (line 79). Pass them conditionally so TypeScript narrows correctly.

### Phase 5 — Smoke test + lint + commit

- [x] `npm run lint`
- [x] `npm run test:run`
- [x] `npm run build`
- [x] Manual visit `/biochoco/ibutton` and one detail page
- [x] `git add -p` to stage only this feature's changes (CLAUDE.md rule)

## Success Metrics

- FCAT staff can identify low-coverage deployments at a glance without
  opening each one.
- The detail page clearly shows whether a sensor ran for the full declared
  window or died partway.
- Zero regression in existing table sort/search behavior.

## Dependencies & Risks

- **Risk: sample rate parser misses a format variant.** Mitigated by the
  derived-interval fallback. Worst case: coverage shows `—`, no crash.
- **Risk: ODK fetch latency on table render.** `loadSiteHabitatMap()`
  already fetches from ODK per render, so this doubles the ODK load from
  2 calls to 3-4 (deploy + retrieve forms). Acceptable. If it becomes a
  problem, batch via `Promise.all` (already done).
- **Risk: Drizzle + SQLite `LAG()` subquery fails on older SQLite.** Check
  SQLite version in prod (`SELECT sqlite_version();`). `LAG` requires
  3.25+ (2018). `better-sqlite3` ships current SQLite, so safe.
- **Risk: `date_range_start/end` naive local time interpretation.** Already
  documented in MEMORY.md — iButton timestamps are Ecuador local, no TZ
  conversion. Duration math cancels the offset. Verified in existing code.

## Open Questions

- Should deployments with no ODK window (coverage === null) be visually
  distinct from low-coverage deployments? **Proposed:** yes — `—` with
  tooltip "Sin datos ODK" vs. amber "65%" badge.
- Do we need a server-level threshold config for the 95% cutoff, or is a
  hardcoded constant fine? **Proposed:** hardcoded `LOW_COVERAGE_THRESHOLD
  = 95` in `coverage.ts`. YAGNI on config.
- Should low-coverage deployments be excluded from the habitat-level
  `TemperatureDistributions` box plots? **Out of scope** — brainstorm
  explicitly said no changes to overview/resultados. Revisit later.

## References

### Internal

- Brainstorm: `docs/brainstorms/2026-04-08-ibutton-deployment-window-coverage-brainstorm.md`
- Existing ODK datetime loader: `src/app/biochoco/ibutton/actions.ts:40-102`
- Existing ingest truncation: `src/app/biochoco/ibutton/actions.ts:248-269`
- Deployments list action: `src/app/biochoco/ibutton/actions.ts:649-705`
- Deployment detail action: `src/app/biochoco/ibutton/actions.ts:481-578`
- Deployments table component: `src/app/biochoco/ibutton/deployments-table.tsx`
- Line chart: `src/app/biochoco/ibutton/[id]/temperature-line-chart.tsx`
- Stats panel: `src/app/biochoco/ibutton/[id]/stats-panel.tsx`
- Shared types: `src/app/biochoco/ibutton/types.ts`
- Parser (sample rate extraction): `src/app/biochoco/ibutton/parser.ts:119`
- Schema: `src/db/schema.ts:693-737`

### Conventions (CLAUDE.md)

- Spanish UI strings throughout
- `ActionResult<T>` for all action return types
- `requirePermission(projectId, minRole)` on every server action
- No `globalThis` DB pattern
- Invalidate caches on mutations (not applicable here — read-only feature)

### Memory

- iButton timestamps are Ecuador local (UTC-5), string-ordered
- `better-sqlite3` transactions must be synchronous (not used here)
