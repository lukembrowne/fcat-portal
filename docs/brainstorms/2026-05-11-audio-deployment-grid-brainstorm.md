---
date: 2026-05-11
topic: audio-deployment-grid
---

# Audio Deployment Recordings — Time × Days Grid

## What We're Building

Replace the flat, 5,000+ item list on `/audio/[id]` with a single **continuous-time raster** that maps recordings onto a days × time-of-day plane. Each recording renders as a small rectangle at its actual timestamp; color encodes a user-selectable metric (detection count, species richness, soundscape saturation, ACI, etc.).

The visualization serves three goals at once: **browse & play** individual recordings, **compare patterns across time** (e.g., dawn chorus vs midday), and **see coverage & gaps** at a glance. Hover reveals filename/timestamp/metric value; click opens the existing per-file detail page (scan / spectrogram / play).

## Why This Approach

A continuous-time raster (Approach A) was chosen over hour-bucketed heatmaps (B) and hybrid hour-cells-with-marks (C) because:

- **Schedule-agnostic** — FCAT deployments record on heterogeneous cadences (5-min intervals, hourly, dawn/dusk-only, etc.). A continuous time axis stays honest to whatever the recorder actually produced; dense schedules render as solid bars, sparse schedules as scattered dots.
- **Data-honest** — no hidden aggregation; gaps and outages are immediately visible.
- **One screen, one mental model** — 24h × ~18 days fits in a viewport, with the same encoding for every deployment.
- **Reuses existing primitives** — the acoustic-indices boxplot (`AcousticIndicesBoxPlot.tsx`) already establishes a pattern of custom SVG with hover tooltips; the same approach scales here.

The simpler aggregated heatmap was rejected because variable recording cadence makes per-cell aggregation misleading (an "hour" can hold 12 files or 1). The hybrid approach was deferred as premature complexity.

## Key Decisions

- **Layout**: X = days (columns); Y = continuous 0–24h (top to bottom). Each recording = one rectangle at its real timestamp.
- **Color encoding**: User-selectable metric via a dropdown above the grid. Initial set: detection count, species richness, soundscape saturation, ACI, frequency entropy, temporal entropy, events/sec. Unscanned files distinguished from "scanned with zero" — likely via a neutral/empty fill vs a colored fill from the metric scale.
- **Interactions**: Hover → tooltip with filename, timestamp, metric value. Click → navigate to the existing per-file detail page. No inline player and no batch-select in v1.
- **Replaces the list entirely** — grid is the only view on `/audio/[id]`. The day-grouped collapsible list is removed.
- **Timestamp source**: Parsed from filename (already done by `parseRecordingTimestamp()`), treated as local Ecuador time (UTC-5) per existing convention.
- **Rendering**: SVG, consistent with the boxplot. Performance for ~5k rects should be acceptable; if not, fall back to canvas.

## Open Questions

- **Long deployments (>30 days)**: horizontal scroll, pagination, or auto-collapse to weeks? Needs decision in planning.
- **Empty cells (no recording at that time)**: rendered as background (e.g., light gray) or just omitted? Likely background to preserve grid structure and make gaps visible.
- **Color scale**: per-deployment auto-scale vs fixed scale across deployments? Auto-scale makes intra-deployment patterns pop; fixed scale enables cross-deployment comparison. Probably auto-scale in v1.
- **Diel period overlays**: optional shaded bands for dawn / midday / dusk / night (matching the existing `acoustic-indices.ts` definitions)? Nice-to-have.
- **Mobile / narrow viewports**: fallback to the old list, or horizontal scroll? Defer.
- **Where does "trigger analysis" live now that the list's per-row scan button is gone?** The Acciones menu still exists at the deployment level; per-file scan can live on the detail page.

## Next Steps

→ `/workflows:plan` to scope the implementation: new `AudioDeploymentGrid` component (SVG-based), metric selector, color scales per metric, replace `AudioFilesShell`'s day-grouped list, and decide the long-deployment scroll behavior.
