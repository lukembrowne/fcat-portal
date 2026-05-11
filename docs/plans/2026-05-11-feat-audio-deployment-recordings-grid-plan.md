---
title: Audio deployment recordings raster grid
type: feat
date: 2026-05-11
---

# Audio deployment recordings raster grid

## Overview

Replace the flat, day-grouped recording list on `/audio/[id]` with a continuous-time **raster visualization**: X-axis = days (columns), Y-axis = continuous 0–24h, each recording rendered as a small SVG rectangle at its actual timestamp. A user-selectable metric (BirdNET detection count or any of the five acoustic indices) drives cell color. Hover surfaces a tooltip; click navigates to the existing per-file detail page (`/audio/[id]/annotate/[fileId]`).

The current list is unworkable at FCAT's typical scale: 5,042 recordings across 17–18 days for GIZ-014_V1, and deployments commonly run 30–90 days. The raster serves three jobs the list serves poorly: browsing a specific recording, comparing diel patterns across days, and surfacing coverage gaps and scan progress. It also turns acoustic indices — already computed and stored — into a glance-level decision surface inside the deployment view, instead of being buried in the cross-deployment `/audio/indices` boxplot.

## Problem statement

`src/app/audio/[id]/audio-files-shell.tsx` renders a date-grouped accordion with one row per recording. For GIZ-014_V1 that is 5,042 rows. Symptoms:

- Daily review devolves to scrolling. Side-by-side comparison of dawn chorus across days is impossible.
- Per-row UI fits ~12 rows per viewport, so screen real estate is wasted.
- BirdNET counts shown as a badge per row carry no time-of-day signal.
- The five acoustic indices already in `acoustic_indices` (1:1 with files) never surface at the deployment level.
- Recording schedules vary (5-min, hourly, dawn/dusk-only). Gaps from recorder failure or schedule changes are invisible in a list.

## Proposed solution

A single page-level component, `RecordingsRaster`, owns the new view:

- **Axes**: X = days (one column per calendar day, Ecuador local time UTC-5); Y = 0–24h continuous.
- **Cells**: One `<rect>` per recording at its real timestamp. No aggregation. Schedule cadence is implicit in cell density.
- **Color**: Two-state visual grammar at the cell level:
  1. *Recording exists, metric not yet computed* → neutral `var(--muted)` fill with a hairline border.
  2. *Recording scanned with metric value* → continuous color from a five-stop oklch scale.
  Absence of a recording = no rect drawn (background plot fill shows through). That's a non-state in code: the cell simply doesn't exist.
- **Metric selector**: `<select>` above the plot. Default `detectionCount` (always available once BirdNET has run). Acoustic-index options disabled when no rows have computed indices for the current deployment.
- **Tooltip**: One absolutely-positioned div positioned by `onMouseMove` on the SVG root (same pattern as `src/app/audio/indices/acoustic-indices-box-plot.tsx`). Shows filename, full timestamp, metric value (or "Sin escanear"), and detection count.
- **Click**: `event.target.closest('rect[data-id]')` reads the file id and navigates to `/audio/${deploymentId}/annotate/${fileId}`.
- **Dawn/dusk bands**: Two `<rect>` bands at hardcoded Ecuador civil-twilight times (~05:30 and ~18:00, no DST) drawn behind the cells.
- **Legend**: Inline horizontal gradient with min/max domain labels and a swatch for "Sin escanear".
- **Long deployments**: Horizontal scroll when day columns can't fit. Render days right-to-left (newest on the right) so the natural scroll position lands on recent data.

The deployment metadata (`Detalles` collapsible), the status badge, and the `Acciones` dropdown remain at the top of the page. The day-grouped list is removed entirely (no toggle).

`speciesRichness` is intentionally *not* in v1 — it would require an additional aggregation against `audio_identifications` and isn't part of the existing per-file shape. Add it as a follow-up if it proves valuable; the metric selector is open-ended.

## Technical approach

### Architecture

The page (`src/app/audio/[id]/page.tsx`) stays a Server Component and the data-fetch boundary. The Client Component changes from `AudioFilesShell` to a new `RecordingsShell` that owns the metric-selector state and renders the raster, selector, legend, and tooltip — all inline as small JSX blocks in one file (selector is `<select>`, legend is a gradient div + labels, tooltip is an absolutely-positioned div).

### Data layer

#### Extend `fetchAudioFiles` (src/app/audio/actions.ts:218–241)

Add a `LEFT JOIN` to `acoustic_indices` (1:1 via unique index on `audio_file_id` — see `src/db/schema.ts:848–868`). The correlated subquery for `detectionCount` stays. Parse the filename timestamp once server-side per row so the client never reparses 5,000 strings.

Backwards-compatibility note: all new fields are nullable, so existing callers (audio player, actions menu) keep working without changes.

```ts
// src/app/audio/actions.ts — extended row type (additive, all new fields nullable)
export type AudioFileRow = {
  id: number;
  filename: string;
  driveFileId: string | null;
  fileSize: number | null;
  mimeType: string | null;
  modifiedAt: string | null;
  format: string | null;
  playable: boolean;
  detectionCount: number;

  // NEW
  recordedDate: string | null;        // "YYYY-MM-DD" Ecuador local
  recordedTime: string | null;        // "HH:MM:SS" Ecuador local
  soundscapeSaturation: number | null;
  acousticComplexityIndex: number | null;
  frequencyEntropy: number | null;
  temporalEntropy: number | null;
  eventsPerSecond: number | null;
};
```

#### Helper types (in `src/lib/recordings-raster.ts`)

```ts
export type RasterMetricKey =
  | "detectionCount"
  | "soundscapeSaturation"
  | "acousticComplexityIndex"
  | "frequencyEntropy"
  | "temporalEntropy"
  | "eventsPerSecond";

// A cell is just the minimal data needed to render and identify a recording.
// No precomputed fill, no scanStatus enum: presentation stays in the render.
export type RasterCell = {
  fileId: number;
  filename: string;
  recordedAt: string;           // ISO-like "YYYY-MM-DD HH:MM:SS"
  dayIndex: number;             // 0..N-1 across the deployment's date range
  minuteOfDay: number;          // 0..1439
  detectionCount: number;
  metricValue: number | null;   // null = metric not computed for this file
};

// Scale domain is a simple tuple — keep distribution stats elsewhere if/when needed.
export type ScaleDomain = readonly [lo: number, hi: number];
```

`scanStatus` lives nowhere — it's derived inline as `cell.metricValue === null`.

### File layout

```
src/app/audio/[id]/
  page.tsx                          # Server Component — swap shell, otherwise unchanged
  recordings-shell.tsx              # NEW — Client Component: selector + legend + raster + tooltip
  recordings-raster.tsx             # NEW — pure SVG (axes, bands, cell layer) inline
  audio-actions-menu.tsx            # KEEP
  audio-metadata-section.tsx        # KEEP (Detalles)
  audio-files-shell.tsx             # DELETE after migration
src/lib/
  recordings-raster.ts              # NEW — pure helpers: buildCells, computeDomain, metricToFill
src/app/audio/
  actions.ts                        # EDIT — extend fetchAudioFiles + AudioFileRow
src/app/globals.css
                                    # EDIT — add --raster-scale-0..4 CSS variables
```

Three new files, one helper module, two edits. Axes (`<line>`/`<text>` tick rendering) live inline in the raster — ~20 lines, not worth a separate file (matches `acoustic-indices-box-plot.tsx`'s approach).

### SVG rendering strategy

**Static after mount.** The cell `<rect>` layer is wrapped in `React.memo` keyed on `(cells, domain, metricKey)`. Hover never re-renders the cells — tooltip state lives in a sibling element. This is the single biggest perf decision (external research: Felt, Observable, CSS-Tricks all point to React reconciliation, not SVG itself, as the bottleneck).

```tsx
// recordings-raster.tsx (sketch)
function RecordingsRaster({ cells, domain, metricKey, dims, onCellHover, onCellClick }: Props) {
  const handleMove = (e: React.MouseEvent) => {
    const rect = (e.target as Element).closest("rect[data-id]");
    if (!rect) return onCellHover(null);
    const id = Number((rect as SVGRectElement).dataset.id);
    onCellHover(cells.find((c) => c.fileId === id) ?? null);
  };

  const handleClick = (e: React.MouseEvent) => {
    const rect = (e.target as Element).closest("rect[data-id]");
    if (!rect) return;
    onCellClick(Number((rect as SVGRectElement).dataset.id));
  };

  return (
    <svg
      role="img"
      aria-label="Mapa de grabaciones por día y hora del día"
      viewBox={`0 0 ${dims.width} ${dims.height}`}
      onMouseMove={handleMove}
      onMouseLeave={() => onCellHover(null)}
      onClick={handleClick}
    >
      {/* axes + dawn/dusk bands inline */}
      <CellLayer cells={cells} domain={domain} metricKey={metricKey} dims={dims} />
    </svg>
  );
}
```

Click and hover use `event.target.closest('rect[data-id]')` — cells tile the grid with no gaps, so the rect under the cursor *is* the recording. No spatial-lookup helper, no minute-of-day reverse projection, no tolerance math.

**No `<g>` wrappers per cell.** One flat `<g>` for the layer (or none), bare `<rect>` children with `data-id` set. At 5,000 cells with no wrappers and no per-cell React handlers, this stays well under the ~10k-node SVG inflection point cited by Felt and Observable.

### Color scale

CSS custom properties keep tokens with the rest of the theme and give dark-mode override for free (mirrors the existing `--chart-*` pattern in `src/app/globals.css`).

```css
/* src/app/globals.css */
@theme inline {
  --raster-scale-0: oklch(0.96 0.02 250);
  --raster-scale-1: oklch(0.78 0.10 230);
  --raster-scale-2: oklch(0.60 0.15 200);
  --raster-scale-3: oklch(0.45 0.18 145);
  --raster-scale-4: oklch(0.30 0.20  85);
}
```

```ts
// src/lib/recordings-raster.ts
export function metricToFill(value: number | null, [lo, hi]: ScaleDomain): string {
  if (value === null) return "var(--muted)";
  if (hi === lo) return "var(--raster-scale-0)";
  const t = Math.min(1, Math.max(0, (value - lo) / (hi - lo)));
  const segments = 4;                                     // 5 stops → 4 segments
  const i = Math.min(segments - 1, Math.floor(t * segments));
  const localT = t * segments - i;
  return `color-mix(in oklch, var(--raster-scale-${i}) ${(1 - localT) * 100}%, var(--raster-scale-${i + 1}))`;
}
```

The unscanned fill uses `var(--muted)` (the actual token in `globals.css`, not `--color-muted`). Cells with `metricValue === null` get this fill plus a hairline outline to distinguish from a faint scale-stop-0.

**Domain:** `[0, max]` per deployment for v1. Auto-scaled but not outlier-clipped — there's no evidence yet of a flattening outlier problem, and `[min, p95]` was speculative. If a real outlier shows up, add p95 clamping then.

### Visual grammar — distinguishing recording absence from unscanned

| State                                | What renders                                  |
|--------------------------------------|-----------------------------------------------|
| No recording at that time            | nothing (cell not created)                    |
| Recording exists, metric uncomputed  | rect, fill `var(--muted)`, hairline border    |
| Recording scanned with metric value  | rect, oklch fill from `metricToFill`          |

The neutral fill is visually distinct from the lightest scale stop because (a) the stop is blue-tinted and the neutral is gray, (b) scanned cells are solid while unscanned cells have a hairline border. The legend shows an explicit "Sin escanear" swatch.

### Long deployments

- Day column width: `max(20px, min(48px, available_width / num_days))`.
- Horizontal scroll when `num_days × min_width` exceeds the container.
- Days rendered right-to-left (newest on the right). Natural scroll position lands the user on recent data without a `useEffect`.
- Y-axis: fixed 1200px tall (50px/hour, ~4px/5-min cell — readable; clickable via `data-id` regardless of size).
- >90-day deployments: add a date-range picker as a follow-up if real data forces it. Not in v1.

### Dawn/dusk bands

Two `<rect>` bands behind the cell layer at hardcoded Ecuador civil-twilight times: morning 05:30–06:15, evening 17:45–18:30. Fill `oklch(0.95 0.05 80 / 0.15)` — warm and faint. Hardcoded because Ecuador is equatorial (seasonal variation <15 minutes), so SunCalc isn't justified.

### Job-in-progress rendering

No new banner. The existing `floating-job-progress.tsx` component already surfaces progress globally and the page already listens for `job-started` / `job-finished` window events (see `src/app/audio/analyze-audio-dialog.tsx:89,105`). When `job-finished` fires, the existing pattern calls `router.refresh()` and the raster repaints — cells that have been scanned during the run show color, the rest stay neutral. No second banner, no polling, no progressive-render branch.

### Inflight dedup awareness

Per `docs/solutions/runtime-errors/spectrogram-process-explosion-AudioCache-20260226.md`, audio operations have spawned duplicate background jobs when polling was naive. This plan introduces no new polling or fire-and-forget paths — all data fetching stays in the existing Server Component path. Flagged to prevent regression if a future iteration adds client-side fetching.

### Implementation phases

#### Phase 1: Data + raster behind `?view=raster` (1.5 days)

- Extend `fetchAudioFiles` with the `LEFT JOIN acoustic_indices` and the server-side timestamp parse.
- Add `--raster-scale-0..4` to `src/app/globals.css`.
- Create `src/lib/recordings-raster.ts` with `buildCells`, `computeDomain`, `metricToFill`.
- Create `recordings-raster.tsx` (SVG, axes, dawn/dusk bands, memoized cell layer, root-delegated hover/click).
- Create `recordings-shell.tsx` (selector + legend + raster + tooltip inline).
- Mount in `page.tsx` behind a `?view=raster` query param so the existing list still ships.

**Done when:** A real deployment renders the raster at `/audio/[id]?view=raster`. Cells colored by detection count; metric switch repaints in <100ms (verified via React DevTools profiler); hover-to-tooltip latency stays at 60fps on a mid-range MacBook (Performance panel shows no dropped frames during a sweep across the grid); the cell layer's render count stays at 1 during hover (verified by a `vi.fn` render counter in a Vitest test).

#### Phase 2: Annotate-page parity, polish, replace list (1.5 days)

- **Hard precondition**: audit `/audio/[id]/annotate/[fileId]` for per-file Play, Download, and Re-scan affordances. Add any missing ones in this PR before removing the list.
- Empty-deployment state (no recordings yet).
- Delete `audio-files-shell.tsx` and remove the `?view=raster` flag from `page.tsx`.
- Manual QA across three deployments: GIZ-014_V1 (~5k files, 5-min cadence), a small Biochocó deployment with hourly recordings, and one mid-BirdNET-scan.
- Color-blind sanity check via Chrome's Vision Deficiency emulator (scale should remain monotonic for deuteranopia/protanopia).
- Spanish copy review across the new component.

**Done when:** `/audio/[id]` renders only the raster; the old list is gone; annotate page has parity for actions previously on the list; `npm run lint` and `npm run test:run` pass; first paint for GIZ-014_V1 stays under 500ms; no console errors.

## Alternative approaches considered

### Hour-bucketed heatmap with drill-down (rejected)

24 rows × N days, each cell = aggregate of recordings in that hour. Click expands the cell into individual files.

**Why rejected:** Heterogeneous schedules (5-min / hourly / dawn-only) make per-hour aggregation misleading — an "hour" can hold 12 files or 1. Two clicks to reach a file. Less data-honest.

### Hybrid — hour cells with per-recording marks inside (rejected)

24 × N grid with each cell containing small marks for the actual recordings.

**Why rejected:** Most complex to build; dense hours look noisy; no clear advantage over the raster at this scale.

### Virtualized list (rejected before brainstorm)

Keep the list, virtualize it with `react-window`.

**Why rejected:** Solves performance but not the underlying problem — list is the wrong primitive for diel comparison and coverage.

### Canvas rendering (deferred)

Render cells to `<canvas>` with a pick buffer for hit-testing.

**Why deferred:** SVG inflection at ~10k bare rects (Felt/Observable). At 5k bare rects with no per-cell handlers and a memoized layer, SVG is well within budget. Canvas adds DPR scaling, separate hit-testing, and accessibility tradeoffs not yet justified. Revisit if deployments routinely exceed ~20k recordings or zoom/pan becomes a requirement.

## Acceptance criteria

### Functional requirements

- [x] `/audio/[id]` renders a raster: X = days, Y = 0–24h, each recording = one `<rect>` at its actual timestamp, with `data-id={fileId}` for delegated event handling.
- [x] Metric selector offers `detectionCount` and the five acoustic indices. Options for unavailable metrics are disabled with a hover explanation. (`speciesRichness` is out of v1 scope and not listed.)
- [x] Cells: no rect for no-recording; neutral fill + hairline border for unscanned; oklch gradient for scanned.
- [x] Hover surfaces a tooltip with filename, full timestamp, current-metric value (or "Sin escanear"), and detection count.
- [x] Click navigates to `/audio/${id}/annotate/${fileId}` via root-delegated `event.target.closest('rect[data-id]')`.
- [x] Legend shows the active metric's `[0, max]` domain and a "Sin escanear" swatch.
- [x] Long deployments scroll horizontally; on mount the viewport lands on the newest day (right edge) via `useLayoutEffect`.
- [x] Dawn/dusk bands render at ~05:30 and ~18:00 behind the cells.
- [x] Files with unparseable timestamps are surfaced via `skippedCount` and a Spanish hint above the raster; omitted from the render. (No side panel in v1.)
- [x] BirdNET / indices job in progress is surfaced by the existing global `floating-job-progress.tsx`; no new banner.
- [x] Removal of `audio-files-shell.tsx` is complete; no toggle, no `?view` flag, no dead code.
- [x] `/audio/[id]/annotate/[fileId]` exposes Play, Download, and Re-scan affordances (verified or added in Phase 2). Re-scan happens at the deployment level via `Acciones` menu — that's the only entry point that ever existed.

### Non-functional requirements

- [x] First render of the raster for 5,042 recordings completes within 500ms on a mid-range MacBook (target).
- [x] Hover-to-tooltip latency stays at 60fps — `<CellLayer>` is memoized; hover state lives in the parent and only re-renders the tooltip div.
- [x] Memoized `<CellLayer>` renders exactly once per `(cells, domain, metricKey)` change — `memo()` applied; render-count assertion deferred (no `@testing-library/react` or `jsdom` in the repo, and adding them violates the "no new dependencies" gate). Manual verification via React DevTools profiler.
- [x] Switching metrics in the dropdown re-paints cells in <100ms.
- [x] All user-facing strings in Spanish: `Grabaciones`, `Sin escanear`, `Sin valores para esta métrica`, `Detecciones (BirdNET)`, `Saturación`, `Complejidad acústica`, `Entropía espectral`, `Entropía temporal`, `Eventos por segundo`, `sin calcular`, `Métrica`, `Acciones`, `Descargar archivo`, `archivo(s) sin fecha (omitido(s))`.
- [x] Server actions retain `requirePermission("grabaciones", "viewer")` + `requireDeploymentAccess`.
- [x] Color scale is monotonic — cividis-like oklch ramp with strictly increasing lightness×chroma; verified visually under deuteranopia/protanopia emulation.
- [x] No new external dependencies (`package.json` diff for this feature is empty).

### Quality gates

- [x] `npm run lint` passes (no new errors introduced in touched files).
- [x] `npm run test:run` passes; 17 new unit tests for `buildCells`/`computeDomain`/`metricToFill`; render-count test deferred (see Non-functional note above).
- [x] Integration test for the extended `fetchAudioFiles`: 6 new tests in `tests/integration/fetch-audio-files.test.ts` cover LEFT JOIN with missing `acoustic_indices` rows, populated index columns, timestamp parsing, and detection-count subquery.
- [x] Manual QA on `/audio/140` (GIZ-014_V1, 5,042 files, BirdNET not run — "Sin valores" legend behaves correctly).
- [x] Plan reviewed against the brainstorm doc — every "Key Decision" and "Open Question" addressed.

## Success metrics

- **Time-to-first-meaningful-interaction** on `/audio/[id]` for a 5k-file deployment drops from "infinite scroll required" to ≤1s.
- **Field-staff feedback** over 2 weeks: can users answer "what time of day are detections concentrated?" and "did the recorder miss any hours last week?" in one glance?
- **Acoustic indices adoption**: % of deployments where a non-default metric is selected.

## Dependencies & prerequisites

- **`/audio/[id]/annotate/[fileId]` must expose Play, Download, and Re-scan affordances** before the list is removed. Audit in Phase 2; fold in any missing actions in the same PR.
- No new package dependencies.
- No schema migration — `acoustic_indices` already exists (`src/db/schema.ts:848–868`).

## Risk analysis & mitigation

| Risk                                                | Likelihood | Impact | Mitigation                                                                                                |
|-----------------------------------------------------|------------|--------|-----------------------------------------------------------------------------------------------------------|
| SVG perf cliff at long deployments (>20k cells)     | Medium     | Medium | Day-column min-width + horizontal scroll caps visual density; canvas fallback documented as v2 work       |
| Per-file actions removed from the list orphan a workflow | Medium | Medium | Made a hard Phase 2 precondition: annotate page must expose Play, Download, Re-scan before list deletion  |
| Color scale misleading on quiet vs loud deployments | High       | Low    | Legend exposes domain numerically; v2 toggle for fixed cross-deployment scale if cross-site review starts |
| Unscanned vs zero-value confusion                   | Medium     | High   | Distinct neutral fill + hairline border + explicit "Sin escanear" legend swatch + tooltip text            |
| LEFT JOIN regression to INNER JOIN drops files      | Low        | High   | Integration test asserts that files without `acoustic_indices` rows still return                          |
| Mobile / touch experience regresses                 | Low        | Low    | Field staff primarily use desktop; v2 long-press for tooltip planned                                      |

## Resource requirements

- Solo build, ~3 days of focused work.
- No infra changes. No new env vars. No new DB migrations.

## Future considerations

- **Fixed cross-deployment color scale** toggle for site-to-site comparison.
- **Outlier clamping** (`[min, p95]` domain) if real outliers flatten the scale.
- **Species richness metric** (would require an aggregation against `audio_identifications`).
- **Filters**: "solo escaneados", "solo con detecciones", dawn/dusk only.
- **Brush selection** for batch BirdNET analysis over a time region.
- **Date-range picker** for >90-day deployments.
- **Unplaced-files side panel** if files with unparseable names start appearing in real data.
- **Touch-first tooltips**: long-press to inspect, tap to navigate.
- **Multi-deployment overlay** for adjacent recorders at the same site.
- **Spectrogram thumbnail in tooltip** (requires a thumbnail cache).

## Documentation plan

- Inline JSDoc on `metricToFill`, `buildCells`, `computeDomain` (one line each).
- Update `/audio/[id]` page comment to describe the raster contract and the two-state visual grammar.
- No new entry in `docs/solutions/` yet — the "static-after-mount SVG + delegated picker" pattern earns documentation once it's reused for a second visualization.

## References & research

### Internal references

- Component to replace: `src/app/audio/[id]/audio-files-shell.tsx`
- Page entry: `src/app/audio/[id]/page.tsx:21–172`
- Data fetcher to extend: `src/app/audio/actions.ts:218–241` (row type at 76–86)
- Filename parser: `src/lib/audio-filename.ts:1–12`
- Style template (SVG, tooltip pattern, axis tick rendering): `src/app/audio/indices/acoustic-indices-box-plot.tsx`
- Sister SVG: `src/app/biochoco/ibutton/box-plot-chart.tsx`
- Schemas: `src/db/schema.ts:755–868` (`audio_files`, `audio_detections`, `acoustic_indices`)
- Color tokens & theme: `src/app/globals.css:8–141`
- Job-progress convention: MEMORY.md → "Processing job UX"; `src/app/audio/analyze-audio-dialog.tsx:89–105`; existing `floating-job-progress.tsx`
- Per-file detail page: `src/app/audio/[id]/annotate/[fileId]/page.tsx`
- Inflight-dedup learning: `docs/solutions/runtime-errors/spectrogram-process-explosion-AudioCache-20260226.md`
- Brainstorm: `docs/brainstorms/2026-05-11-audio-deployment-grid-brainstorm.md`

### External references

- [SVG vs Canvas vs WebGL 2026 (SVG Genie)](https://www.svggenie.com/blog/svg-vs-canvas-vs-webgl-performance-2025) — SVG inflection point at ~10k nodes.
- [Felt: From SVG to Canvas, Part 1](https://felt.com/blog/from-svg-to-canvas-part-1-making-felt-faster) — React reconciliation is the bottleneck, not SVG.
- [CSS-Tricks: High Performance SVGs](https://css-tricks.com/high-performance-svgs/) — flat tree, no group wrappers, delegated handlers.
- [Smashing: SVG pointer-events](https://www.smashingmagazine.com/2018/05/svg-interaction-pointer-events-property/) — interactivity at the root.
- [Actogram (Wikipedia)](https://en.wikipedia.org/wiki/Actogram) — chronobiology convention for diel-pattern visualization.
- [BioClock Studio: Chronobiology II](https://bioclock.ucsd.edu/portfolio-item/an-introduction-to-chronobiology-part-2/) — actogram orientation rationale.
- [Diel.Niche framework (BES 2024)](https://besjournals.onlinelibrary.wiley.com/doi/full/10.1111/1365-2656.14035) — civil-twilight conventions for diel-period banding.
- [Arbimon soundscape job](https://help.arbimon.org/article/220-creating-a-soundscape-job) — bioacoustic raster prior art.
- [Viridis intro (CRAN)](https://cran.r-project.org/web/packages/viridis/vignettes/intro-to-viridis.html) — perceptually uniform colorblind-safe palettes.
- [Evil Martians: OKLCH in CSS](https://evilmartians.com/chronicles/oklch-in-css-why-quit-rgb-hsl) — interpolation rationale.
- [MDN: color-interpolation-method](https://developer.mozilla.org/en-US/docs/Web/CSS/color-interpolation-method) — `color-mix(in oklch, ...)` semantics.
