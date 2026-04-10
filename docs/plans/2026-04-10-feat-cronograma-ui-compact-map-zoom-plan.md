---
title: Cronograma UI — Compact Layout, Map Zoom, ODK Dates
type: feat
date: 2026-04-10
---

# Cronograma UI — Compact Layout, Map Zoom, ODK Dates

## Overview

Redesign the biochoco overview/cronograma page to be more compact and interactive. Move the schedule table above the map, replace card grids with compact stat pills (matching resultados pages), make the "Mapa" column zoom to the site on the existing Leaflet map instead of opening ArcGIS, and remove the SiteSummaryTable (replacing with actual ODK deploy/retrieve dates in the schedule table).

## Changes

### 1. Reorder layout: Table above Map

**File:** `src/app/biochoco/overview/dashboard-shell.tsx`

Move the `<ScheduleTable>` section above the `<OverviewMap>` section. Current order is Map → Table; new order is Table → Map.

### 2. Compact month stats (MonthNavigator)

**File:** `src/app/biochoco/overview/month-navigator.tsx`

Replace the 4-card grid (`grid-cols-2 md:grid-cols-4` with `<Card>` components) with a `<CompactStatBar>` row of pills, matching the pattern in `src/app/biochoco/resultados/[siteId]/compact-stat-bar.tsx`.

Before (cards with text-2xl numbers):
```
┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
│ Instalar │ │ Recuperar│ │  Total   │ │  Sitios  │
│    15    │ │    15    │ │    30    │ │    30    │
└──────────┘ └──────────┘ └──────────┘ └──────────┘
```

After (compact pill row):
```
[↑ 15 Instalar] [↓ 15 Recuperar] [📅 30 Total] [📍 30 Sitios]
```

Import `CompactStatBar` from `@/app/biochoco/resultados/[siteId]/compact-stat-bar` (or move it to a shared location like `src/components/compact-stat-bar.tsx` first since it's now used in two places).

### 3. Map zoom from table ("Mapa" column)

**Files:**
- `src/app/biochoco/overview/dashboard-shell.tsx` — add shared ref/callback
- `src/app/biochoco/overview/overview-map-inner.tsx` — expose map via `useMap` + imperative handle
- `src/app/biochoco/overview/schedule-table.tsx` — replace ArcGIS link with zoom button

**Approach:**

a) In `dashboard-shell.tsx`, create a `useRef` to store a `flyToSite` callback:
```tsx
const flyToSiteRef = useRef<((lat: number, lng: number) => void) | null>(null);
```

b) In `overview-map-inner.tsx`, add a child component inside `<MapContainer>` that uses the `useMap()` hook and registers itself:
```tsx
function MapController({ onMapReady }: { onMapReady: (fn: (lat: number, lng: number) => void) => void }) {
  const map = useMap();
  useEffect(() => {
    onMapReady((lat, lng) => {
      map.flyTo([lat, lng], 17, { duration: 1 });
    });
  }, [map, onMapReady]);
  return null;
}
```

c) Pass `onMapReady` through `OverviewMap` → `OverviewMapInner`. In `dashboard-shell.tsx`:
```tsx
<OverviewMap
  ...
  onMapReady={(fn) => { flyToSiteRef.current = fn; }}
/>
```

d) Pass `onFocusSite` to `ScheduleTable`:
```tsx
<ScheduleTable
  ...
  onFocusSite={(lat, lng) => {
    flyToSiteRef.current?.(lat, lng);
    // Scroll map into view
    document.getElementById('overview-map')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }}
/>
```

e) In `schedule-table.tsx`, replace the ArcGIS `<a>` tag with a `<button>` that calls `onFocusSite`:
```tsx
{
  id: "map",
  header: "Mapa",
  cell: ({ row }) => {
    const { lat, lng } = row.original;
    if (lat == null || lng == null) return "—";
    return (
      <button
        onClick={() => onFocusSite?.(lat, lng)}
        className="inline-flex items-center gap-1 text-blue-600 hover:underline"
      >
        <MapPin className="h-3.5 w-3.5" />
        Ver
      </button>
    );
  },
}
```

Add `id="overview-map"` to the map section wrapper in `dashboard-shell.tsx` for scroll targeting.

### 4. Compact project summary (Resumen General)

**File:** `src/app/biochoco/overview/project-summary.tsx`

Replace the 2x2 card grid (Total/Programados/Instalados/Completados) and the 2-column Cronología/Estadísticas cards with compact stat pills + a minimal info section.

Top row becomes a `<CompactStatBar>`:
```
[📅 306 Total] [⏳ 265 Programados] [📍 15 Instalados] [✓ 26 (8.5%) Completados]
```

Bottom section: merge Cronología and Estadísticas into a single compact `<div>` with `text-sm` inline items instead of two separate Card components. Something like:
```
Primera: 19 Ene 2026 · Última: 19 Sep 2027 · Fin: 19 Oct 2027
Duración: 30d promedio (29–31d) · 102 sitios
```

### 5. Remove SiteSummaryTable

**Files:**
- `src/app/biochoco/overview/dashboard-shell.tsx` — remove `<SiteSummaryTable>` + separator
- `src/app/biochoco/overview/site-summary-table.tsx` — delete file

The table shows planned V1/V2/V3 dates from the Google Sheets schedule. The "Real" column is always "—" because actual dates aren't populated.

**Instead:** Add actual deploy/retrieve dates from ODK directly to the main schedule table (see #6).

### 6. Add actual ODK dates to the schedule table

**Files:**
- `src/app/biochoco/overview/actions.ts` — enrich schedule rows with actual dates from ODK submissions
- `src/app/biochoco/overview/schedule-table.tsx` — add "Fecha Real" column
- `src/lib/schedule-types.ts` — add `actualDeployDate` / `actualRetrieveDate` fields

**ODK field locations** (per documented learnings):

Deploy date (from `instalar_sensores` submissions):
```typescript
const depInfo = sub.deployment_info as Record<string, unknown> | undefined;
const actualDeployDate =
  (depInfo?.deploy_date as string) ??
  (sel?.fecha_instalacion as string) ??
  (sub.fecha_instalacion as string) ??
  null;
```

Retrieve date (from `retrieve_sensors` submissions):
```typescript
const retInfo = sub.retrieval_info as Record<string, unknown> | undefined;
const actualRetrieveDate =
  (retInfo?.retrieval_date as string) ??
  (sel?.fecha_recuperacion as string) ??
  (sub.fecha_recuperacion as string) ??
  null;
```

In `actions.ts`, after fetching deployments/retrievals from ODK, build a map of `deploymentId → actualDate` and spread onto the schedule rows. Add a new column "Fecha Real" to the table that shows the actual date (green text if it exists, gray "—" if pending).

### 7. Move CompactStatBar to shared location

**Files:**
- `src/components/compact-stat-bar.tsx` — new shared location (move from resultados)
- `src/app/biochoco/resultados/[siteId]/compact-stat-bar.tsx` — delete, update imports
- `src/app/biochoco/resultados/[siteId]/site-detail-shell.tsx` — update import path
- `src/app/biochoco/overview/month-navigator.tsx` — import from shared
- `src/app/biochoco/overview/project-summary.tsx` — import from shared

## Acceptance Criteria

- [x] Schedule table renders above the map
- [x] Month stats (Instalar/Recuperar/Total/Sitios) display as compact pills, not cards
- [x] Clicking "Ver" in the Mapa column flies to the site on the Leaflet map at zoom ~17 and scrolls the map into view
- [x] Project summary stats display as compact pills
- [x] Cronología + Estadísticas merged into compact inline text
- [x] SiteSummaryTable removed
- [x] Actual deploy/retrieve dates from ODK appear in the schedule table
- [x] CompactStatBar is shared component used by both resultados and overview
- [ ] No horizontal scroll or layout overflow (test with sidebar open)
- [ ] No regressions on mobile viewport

## Gotchas

- **Leaflet `useMap()` must be inside `<MapContainer>`** — the MapController component must be a child of MapContainer, not a sibling
- **min-w-0 on flex children** — per documented learning, ensure all flex children in the sidebar layout chain have `min-w-0` to prevent horizontal overflow with the map
- **ODK form field fallback chains** — deploy dates moved from `site_selection.fecha_instalacion` to `deployment_info.deploy_date`; retrieve dates from `site_selection.fecha_recuperacion` to `retrieval_info.retrieval_date`. Always use full fallback chain for both old and new submissions
- **Scroll behavior** — `scrollIntoView` after `flyTo` needs the map section to have an `id` attribute
- **`flyToSiteRef` stability** — use `useCallback` for the `onMapReady` handler to avoid re-registering on every render
