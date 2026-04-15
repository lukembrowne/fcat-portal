---
title: Cumulative Precipitation Year-over-Year Comparison
type: feat
date: 2026-04-14
---

# Cumulative Precipitation Year-over-Year Comparison

## Overview

Add a cumulative precipitation view to the climate dashboard so staff can compare year-to-date rainfall across years (2022+) and identify anomalous wet/dry years. Hovering any date (e.g., April 14) shows how much rain has fallen since Jan 1 in each year, with a vertical reference line for "today".

## Problem Statement

The current Precipitación tab (`src/app/climate/dashboard/climate-charts.tsx:144-155`) shows a per-interval bar chart. There is no way to answer: *"Is 2026 tracking wetter or drier than 2023 at this point in the year?"* Users can filter by year, but they can only look at one year at a time and cannot visually compare cumulative totals on the same calendar axis.

## Proposed Solution

Inside the existing **Precipitación** tab, add a view toggle:

- **Por período** (current bar chart — default)
- **Acumulado anual** (new cumulative line chart)

The new view renders a line chart with:
- **X-axis**: day of year, labeled by month (Ene, Feb, …, Dic)
- **Y-axis**: cumulative mm since Jan 1
- **One line per year**, 2022 onward (current year highlighted, prior years muted/dashed)
- **Vertical `ReferenceLine`** at today's day-of-year, labeled "Hoy"
- **Tooltip** showing each year's cumulative mm at the hovered day-of-year (aligned on calendar date, not index — Feb 29 handled explicitly)

### Why a sub-toggle instead of a new top-level tab
Keeps all rain-related views under one conceptual header; avoids bloating the 6-tab row. Low-effort UX — same mental model as the Viento tab, which already shows two stacked charts (`climate-charts.tsx:173-214`).

## Technical Approach

### Data query (new server action)

Add `fetchCumulativePrecipitation(minYear = 2022)` in `src/app/climate/dashboard/actions.ts`. Uses SQLite window function over the `hourly` resolution:

```ts
// Pseudocode — returns one row per (year, day-of-year) from 2022 onward
const rows = db.all(sql`
  WITH daily AS (
    SELECT
      CAST(strftime('%Y', timestamp) AS INTEGER) AS year,
      CAST(strftime('%j', timestamp) AS INTEGER) AS doy,
      strftime('%m-%d', timestamp) AS mmdd,
      SUM(rain_mm) AS daily_mm
    FROM climate_readings
    WHERE resolution = 'hourly'
      AND CAST(strftime('%Y', timestamp) AS INTEGER) >= ${minYear}
    GROUP BY year, doy
  )
  SELECT
    year, doy, mmdd,
    ROUND(SUM(daily_mm) OVER (
      PARTITION BY year ORDER BY doy
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ), 1) AS cumulative_mm
  FROM daily
  ORDER BY year, doy;
`);
```

Gated by `requirePermission("climate", "viewer")`. Returns `ActionResult<CumulativePrecipPoint[]>`.

### Pivot shape for Recharts

Recharts plots one `<Line dataKey=... />` per series, so pivot server-side (or in the component) into:

```ts
// One row per calendar day (mm-dd), one column per year
type CumulativeRow = {
  mmdd: string;      // "04-14"
  doy: number;       // 104 (non-leap)
  label: string;     // "14 Abr"
  "2022": number | null;
  "2023": number | null;
  "2024": number | null;
  "2025": number | null;
  "2026": number | null;
};
```

Leap-day handling: use `mmdd` (month-day string) as the join key so Feb 29 lines up only where it exists; non-leap years show `null` for that row and Recharts' `connectNulls={true}` bridges the gap.

### New component

`src/app/climate/dashboard/cumulative-precip-chart.tsx` — client component, receives the pivoted rows and renders:

```tsx
<LineChart data={rows}>
  <XAxis dataKey="label" ticks={monthStartTicks} />
  <YAxis label={{ value: "mm acumulados", angle: -90 }} />
  <Tooltip />
  <Legend />
  <ReferenceLine x={todayLabel} stroke="#ef4444" label="Hoy" />
  {years.map((y) => (
    <Line key={y} dataKey={String(y)} name={String(y)}
          stroke={colorForYear(y)}
          strokeWidth={y === currentYear ? 2.5 : 1.5}
          strokeDasharray={y === currentYear ? undefined : "4 2"}
          dot={false} connectNulls />
  ))}
</LineChart>
```

### Tab integration

In `climate-charts.tsx:144-155`, replace the single `BarChart` inside `<TabsContent value="precipitacion">` with a small segmented toggle (reuse shadcn `ToggleGroup` or inline buttons) that switches between `BarChart` (existing) and `<CumulativePrecipChart />`.

State for the toggle lives in `dashboard-shell.tsx` alongside `activeTab`, so switching away and back remembers the choice. Data for the cumulative view is fetched **once on mount** (or on first switch) since it always covers 2022→today and is independent of the global date filter.

### Filter bar interaction

The cumulative view ignores the global date-range filter (it always shows full years for comparison). Surface this with a small helper text: *"Esta vista muestra años completos desde 2022, ignorando el filtro de fechas."*

## Acceptance Criteria

- [x] Precipitación tab shows a **Por período / Acumulado anual** toggle
- [x] Acumulado anual renders one line per year from 2022 through current year
- [x] X-axis spans Jan 1 → Dec 31 with month tick labels in Spanish
- [x] Y-axis is cumulative mm since Jan 1 of that year
- [x] Vertical "Hoy" reference line at today's calendar date
- [x] Current year's line is visually emphasized (thicker, solid) vs prior years (dashed or lighter)
- [x] Tooltip shows cumulative mm for all years at the hovered calendar date
- [x] New server action calls `requirePermission("climate", "viewer")`
- [x] Leap-day (Feb 29) aligns only in leap years; non-leap years render `null` without breaking the line
- [x] Empty-state handled when no data exists for 2022+ (e.g., fresh install)
- [x] Helper text explains the view ignores the global date filter

## Files Touched

- `src/app/climate/dashboard/actions.ts` — add `fetchCumulativePrecipitation`, types `CumulativePrecipPoint`, `CumulativeRow`
- `src/app/climate/dashboard/cumulative-precip-chart.tsx` — **new** client component
- `src/app/climate/dashboard/climate-charts.tsx` — add toggle inside Precipitación tab
- `src/app/climate/dashboard/dashboard-shell.tsx` — (optional) state for which precip sub-view is active, lazy-load cumulative data

## Open Questions

1. **Lines 2022+ only?** Confirmed by user. 2021 is already excluded elsewhere as incomplete (`actions.ts:306`) — reuse that precedent.
2. **Color palette for year lines**: use a sequential scale (older = lighter gray, newer = saturated color) or a categorical scale? Sequential reads better for "compare current year vs history" — recommend sequential with current year in red/primary.
3. **Climatological normal band**: Should we overlay a gray envelope showing the historical min/max or 25th–75th percentile across prior years? Nice-to-have; defer to v2.
4. **Data source resolution**: use `hourly` (current default) — `15min` would give identical daily sums and cost more.

## References

- Existing precipitation chart: `src/app/climate/dashboard/climate-charts.tsx:144-155`
- Yearly-excl-2021 precedent: `src/app/climate/dashboard/actions.ts:306`
- Two-chart-in-one-tab pattern (Viento): `climate-charts.tsx:173-214`
- Schema: `src/db/schema.ts:615-656` (`climateReadings.rainMm`, `resolution`, `timestamp`)
- Tabs component: `@/components/ui/tabs`
- Recharts `ReferenceLine`: https://recharts.org/en-US/api/ReferenceLine
