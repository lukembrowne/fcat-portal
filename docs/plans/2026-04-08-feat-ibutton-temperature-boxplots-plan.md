---
title: iButton Temperatura — box plots + compact stat strip
type: feat
date: 2026-04-08
---

# iButton Temperatura — box plots + compact stat strip

## Overview

Rework the `/biochoco/ibutton` Temperatura dashboard in two ways:

1. **Replace the habitat bar chart** (`habitat-chart.tsx`) with **box plots** that show the distribution of per‑deployment `min`, `avg`, and `max` across a grouping dimension (habitat type and/or site). Overlay each deployment as a jittered point so the spread is visible. Hovering a point reveals the deployment name.
2. **Replace the 2‑card summary grid** (`summary-cards.tsx`) with a **single compact horizontal strip** matching the style used on `/camera-trap` (see `src/app/camera-trap/page.tsx:107-120`).

Motivation: the portal now has multiple iButton deployments per site and per habitat type, so the current bar graph (which shows a single min/avg/max per habitat) collapses out the very variation researchers care about. And the big 2‑up card grid wastes vertical space on only two numbers.

## Current state (file map)

- `src/app/biochoco/ibutton/page.tsx` — RSC entry; calls `fetchIbuttonStatus`, `fetchHabitatSummary`, `fetchProcessedDeployments` and hands results to `TemperatureShell`.
- `src/app/biochoco/ibutton/temperature-shell.tsx:62-120` — layout shell. Renders `SummaryCards`, `HabitatChart`, `DeploymentsTable`.
- `src/app/biochoco/ibutton/summary-cards.tsx` — current 2‑up grid with Recharts-free cards (Despliegues procesados / Lecturas totales). **Will be replaced.**
- `src/app/biochoco/ibutton/habitat-chart.tsx` — current Recharts `BarChart` with three rows (Mín/Prom/Máx) × habitat bars. **Will be replaced.**
- `src/app/biochoco/ibutton/actions.ts:582-670` — `fetchHabitatSummary()` already pushes per‑deployment `mins[] / maxes[] / means[]` arrays into `byHabitat`, then reduces them to a single scalar (`Math.min(...)`, `Math.max(...)`, average). We will stop reducing and surface the raw arrays (with deployment identity).
- `src/app/biochoco/ibutton/types.ts` — `HabitatSummary` type will gain a `deployments: { deploymentId, deploymentName, siteName, tempMin, tempMean, tempMax }[]` field.
- `src/app/camera-trap/page.tsx:107-120` + `SummaryStat` at `:135-153` — reference implementation of the compact stat strip we're copying.
- Chart lib: **Recharts v3.7.0**. It has no native box plot — implementation notes below.

## Proposed solution

### Part A — Compact stat strip

Replace `SummaryCards` with an inline strip in `temperature-shell.tsx` (or a small colocated component `summary-strip.tsx`). Keep it terse and mirror the camera‑trap visual exactly:

```tsx
// src/app/biochoco/ibutton/temperature-shell.tsx (sketch)
{status && (
  <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2
                  rounded-md border bg-card px-4 py-2.5 text-sm">
    <SummaryStat label="Despliegues procesados"
                 value={`${status.processed} / ${status.total}`}
                 dotClass="bg-blue-600" valueClass="text-blue-700" />
    <span className="h-4 w-px bg-border" aria-hidden />
    <SummaryStat label="Pendientes"
                 value={status.unprocessed}
                 dotClass="bg-orange-500" valueClass="text-orange-600" />
    <span className="h-4 w-px bg-border" aria-hidden />
    <SummaryStat label="Lecturas totales"
                 value={status.totalReadings.toLocaleString("es")}
                 dotClass="bg-emerald-600" valueClass="text-emerald-700" />
  </div>
)}
```

- Reuse the `SummaryStat` signature from `camera-trap/page.tsx:135-153` (copy or extract to `src/components/summary-stat.tsx` if we want it shared — not required for this ticket, YAGNI says copy).
- Delete `summary-cards.tsx` once referenced nowhere.

Open question: should `Pendientes` be omitted when `unprocessed === 0`? Reference page shows the strip unconditionally. Recommendation: always render all three, it's four tokens of text.

### Part B — Box plot chart

#### Data shape

Extend `actions.ts:fetchHabitatSummary()` (or add a sibling `fetchTemperatureDistributions()`) to return, per habitat bucket:

```ts
// src/app/biochoco/ibutton/types.ts
export interface DeploymentStatPoint {
  deploymentId: number;
  deploymentName: string;
  siteName: string | null;
  tempMin: number;
  tempMean: number;
  tempMax: number;
}

export interface HabitatDistribution {
  habitatType: string;
  habitatLabel: string;
  deploymentCount: number;
  deployments: DeploymentStatPoint[];  // raw per-deployment triples
}
```

The grouping loop in `actions.ts:610-636` already accumulates per‑habitat arrays; change it to push `DeploymentStatPoint` objects instead of three parallel scalar arrays. Keep the habitat sorting.

For the "per site" view we can compute a second aggregation in the same function (`bySite: Map<string, DeploymentStatPoint[]>`) or derive it client‑side from the flat deployment list — client‑side derivation is cheaper and keeps the server action simple. **Recommend: client‑side grouping** from a single flat `DeploymentStatPoint[]` payload.

So the cleanest refactor is:

- Server returns `DeploymentStatPoint[]` (flat) + a lookup of `deploymentId → habitatType/habitatLabel`.
- Client component groups by `habitatLabel` or `siteName` depending on the active tab.

#### Chart approach — pure SVG, no new deps

Recharts has no box plot primitive and no custom‑shape path that makes whiskers/quartiles clean. A small hand‑rolled SVG component is simpler than bending Recharts or pulling in `@visx/stats`.

Create `src/app/biochoco/ibutton/box-plot-chart.tsx`:

```tsx
// Rough skeleton — NOT final code
"use client";
type Stat = "tempMin" | "tempMean" | "tempMax";
const STAT_LABEL: Record<Stat, string> = {
  tempMin: "Mínima",
  tempMean: "Promedio",
  tempMax: "Máxima",
};

export function BoxPlotChart({
  groups,          // { label, color, points: DeploymentStatPoint[] }[]
  stat,            // which field to plot
}: { groups: Group[]; stat: Stat }) {
  // 1. compute y-domain across all points
  // 2. for each group compute quartiles: q1, median, q3, min, max (Tukey whiskers)
  //    (use a tiny local helper; no d3 needed for ~5–20 points)
  // 3. render SVG: y-axis with ticks, per-group box + whiskers + median line
  // 4. overlay jittered circles (seeded jitter from deploymentId for stability)
  // 5. <title> on each <circle> for native browser tooltip
  //    plus a custom floating tooltip via onMouseEnter showing deployment name
  //    + site + value
}
```

Key details:

- **Quartile helper** — write a 20‑line `quantiles(sorted, [0.25, 0.5, 0.75])` in `src/lib/stats.ts`. No need for a stats library.
- **Jitter** — deterministic jitter keyed by `deploymentId` so points don't dance between renders. E.g. `jitter(id) = ((id * 9301 + 49297) % 233280) / 233280 - 0.5` → scale to ±0.3 × box width.
- **Edge case: n=1** — collapse the "box" to a single horizontal tick at the point value; do not render whiskers. Show only the data point.
- **Edge case: n=2** — render a degenerate box (q1=min, q3=max, median=avg); still show points.
- **Tooltip** — Recharts tooltip isn't available since we're not using Recharts for this. Use a lightweight portal tooltip: track `hoveredPoint` in state, render an absolutely‑positioned `<div>` with `deploymentName`, `siteName`, value. Fall back to `<title>` inside `<circle>` for accessibility and keyboard users. Reference existing tooltip idiom in `[id]/temperature-line-chart.tsx:75-90` for style consistency.
- **Responsive width** — wrap in a `ResponsiveContainer` clone (measure parent width with `useRef + ResizeObserver`) or just use `width="100%"` on the SVG and rely on `viewBox`. Prefer the latter — simpler.
- **Colors** — reuse `HABITAT_COLORS` from `src/app/biochoco/habitat/types.ts` for habitat boxes. For the site view fall back to a single neutral color (e.g. `bg-slate-500`) since there are many sites.

#### Layout: how to show "min / avg / max" together

Options:

| Option | Pros | Cons |
|---|---|---|
| **A.** 3 side‑by‑side box plots (one per statistic), each with one box per habitat | Compact, one chart card, easy to scan across stats | Wider; cramped with many habitats |
| **B.** Tabs: `Mínima | Promedio | Máxima`, one chart visible at a time | Clean, lots of horizontal room per stat | Extra click to compare stats |
| **C.** Small‑multiples grid (3 columns) | Best for comparing distributions at a glance | Most layout work |

**Recommendation: Option C** — a 3‑column responsive grid (`grid grid-cols-1 lg:grid-cols-3 gap-4`), one box‑plot chart per stat. Each chart renders habitat groups on the x‑axis. On narrow viewports it stacks vertically.

#### Grouping toggle (habitat vs. site)

A small segmented control above the charts:

```
[ Por Hábitat ]  [ Por Sitio ]
```

- `Por Hábitat` — groups by `habitatLabel`, colored by `HABITAT_COLORS`.
- `Por Sitio` — groups by `siteName`, single neutral color. If the site count > ~15, auto‑switch the chart layout to horizontal (boxes stacked vertically, values on x axis) to avoid cramped labels. **Start simple: vertical only, label rotation `-30°`**. Revisit if researchers have many sites.

Persist the toggle in local state only (not URL) — it's a view preference, not deep‑linkable.

### Component wiring

```
temperature-shell.tsx
├── <SummaryStrip status={status} />            // new, replaces <SummaryCards>
├── <TemperatureDistributions
│      deployments={flatDeploymentStats}        // from server action
│      habitatLookup={habitatLookup}
│   />                                          // new
│    ├── <ToggleGroup habitat|site />
│    └── grid
│        ├── <BoxPlotChart stat="tempMin" groups={groups} />
│        ├── <BoxPlotChart stat="tempMean" groups={groups} />
│        └── <BoxPlotChart stat="tempMax" groups={groups} />
└── <DeploymentsTable ... />                    // unchanged
```

New files:
- `src/app/biochoco/ibutton/summary-strip.tsx` (optional — inline is fine)
- `src/app/biochoco/ibutton/temperature-distributions.tsx`
- `src/app/biochoco/ibutton/box-plot-chart.tsx`
- `src/lib/stats.ts` — `quantiles()`, `tukeyWhiskers()` helpers

Deleted:
- `src/app/biochoco/ibutton/summary-cards.tsx`
- `src/app/biochoco/ibutton/habitat-chart.tsx`

Modified:
- `src/app/biochoco/ibutton/actions.ts` — change `fetchHabitatSummary` (or add sibling) to return flat `DeploymentStatPoint[]` + habitat lookup.
- `src/app/biochoco/ibutton/types.ts` — add `DeploymentStatPoint`, tweak exports.
- `src/app/biochoco/ibutton/page.tsx` — fetch new shape, pass through.
- `src/app/biochoco/ibutton/temperature-shell.tsx` — new imports/layout.

## Acceptance criteria

- [ ] Top of `/biochoco/ibutton` shows a single compact horizontal stat strip (matches camera‑trap `/camera-trap` style) with "Despliegues procesados", "Pendientes", "Lecturas totales".
- [ ] `summary-cards.tsx` is deleted and no other page imports it.
- [ ] Habitat bar chart is replaced by a **box‑plot distributions card** containing three box plots (Mín / Prom / Máx) side‑by‑side (or stacked on narrow screens).
- [ ] Each box plot shows: a box (Q1–Q3), median line, Tukey whiskers, and one jittered circle per deployment.
- [ ] Hovering a point shows a tooltip with the **deployment name**, site name, and numeric value in °C. A `<title>` fallback is present for accessibility.
- [ ] A toggle allows switching grouping between **Por Hábitat** and **Por Sitio**. The active grouping persists across tab clicks within the session but does not need to survive a reload.
- [ ] Degenerate cases are handled: a group with n=1 shows just the dot (no box); a group with n=2 shows a minimal box; empty state (`deployments.length === 0`) shows the same "No hay datos procesados todavía." message the current chart shows.
- [ ] No new npm dependencies added.
- [ ] `npm run lint` and `npm run test:run` pass. No Playwright changes required (this view isn't E2E covered today — confirm before adding).
- [ ] Works in both light and dark mode if dark mode is already supported on this page (check `bg-card` token).
- [ ] No layout regressions on the page at widths 1440 / 1024 / 768 (per project UI rule: verify the component in full context, not isolation).

## Technical considerations

- **Server action stays fast.** `fetchHabitatSummary` already runs 3 correlated subqueries per deployment (`:595-597`). We're not adding more queries — just passing the already‑computed per‑deployment min/max/mean through instead of reducing them away. Payload grows from O(habitats) to O(deployments), which for BIOCHOCO is in the dozens. Fine.
- **Stat helpers** should live in `src/lib/stats.ts` and have unit tests in `tests/unit/stats.test.ts` covering: empty input, single value, two values, exact quartile boundaries (e.g. `[1,2,3,4,5]` → q1=2, median=3, q3=4), Tukey outlier detection. Use linear interpolation ("type 7", same as R default and NumPy default).
- **Outliers**: research convention varies on whether outliers (points beyond `q1 - 1.5*IQR` / `q3 + 1.5*IQR`) should be drawn inside or outside the whiskers. Since we're showing **all** points anyway, it doesn't matter — but the whisker line should extend only to the most extreme **non‑outlier**, not to the data min/max. This matches standard box‑plot convention and makes the outliers visually distinct as points beyond the whisker.
- **Client component boundary**: `box-plot-chart.tsx` and `temperature-distributions.tsx` are `"use client"` (they need hover state + grouping state). `temperature-shell.tsx` is already a client component.
- **Serialization from RSC**: Don't pass icons or functions from `page.tsx` → `temperature-shell.tsx`. Only plain data. (Per MEMORY.md gotcha.)
- **Dark mode / `bg-card`**: reuse tokens; avoid hardcoded hex except `HABITAT_COLORS` (already an exception used elsewhere).
- **Accessibility**: box plot SVG needs `role="img"` and an `aria-label` summarizing the group; each circle needs a `<title>` child with deployment name + value for screen readers and keyboard tooltip fallback.

## Out of scope

- Export to PNG / CSV of the distribution data.
- Statistical tests (ANOVA / Kruskal-Wallis) comparing habitats — mentioned as possible future work in the 2026-02-24 brainstorm; not requested here.
- Filtering by date range or by flagged readings. The underlying stats still come from `ibutton_uploads` / `ibutton_readings` unfiltered.
- Changing the deployments table below the chart.

## Open questions (ask before implementing if unclear)

1. **Toggle scope.** Is the Por Hábitat / Por Sitio toggle required for v1, or should v1 ship with habitat only and sites come later? (Default assumption in this plan: ship both.)
2. **Outlier convention.** OK with standard Tukey whiskers (1.5 × IQR) with all points still plotted? (Default: yes.)
3. **Card title.** Keep current title "Temperatura por Hábitat (°C)" or rename to something like "Distribución de temperaturas"? (Default: latter, since the card now holds all three stats.)

## References

- Current bar chart: `src/app/biochoco/ibutton/habitat-chart.tsx`
- Current summary cards: `src/app/biochoco/ibutton/summary-cards.tsx`
- Reference stat strip: `src/app/camera-trap/page.tsx:107-153`
- Server action to refactor: `src/app/biochoco/ibutton/actions.ts:582-670`
- Individual deployment line chart (tooltip style reference): `src/app/biochoco/ibutton/[id]/temperature-line-chart.tsx:75-90`
- Habitat palette: `src/app/biochoco/habitat/types.ts` (`HABITAT_COLORS`)
- Original dashboard brainstorm: `docs/brainstorms/2026-02-24-ibutton-temperature-dashboard-brainstorm.md`
