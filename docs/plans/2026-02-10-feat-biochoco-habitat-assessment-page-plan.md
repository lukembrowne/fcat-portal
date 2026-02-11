---
title: "BioChoco Habitat Assessment Page"
type: feat
date: 2026-02-10
---

# BioChoco Habitat Assessment Page

## Overview

New page at `/biochoco/habitat` that displays habitat evaluation data collected via the `habitat_assessment` ODK form. The page shows a map of all monitoring sites (colored by assessment status and habitat type), summary tables of structural habitat metrics grouped by the 7 habitat types, and inline photo thumbnails from each assessed site.

## Problem Statement / Motivation

BioChoco field teams are collecting habitat assessment data (canopy cover, tree density, understory, slope, edge distance, disturbance, and directional photos) via ODK Central. Currently there is no way to view this data in the portal — staff must export CSVs manually. A dedicated page will let coordinators quickly see which sites have been assessed, compare habitat structure across the 7 habitat types, and review field photos.

## Data Source

**ODK Form:** `habitat_assessment` (BIOCHOCO - Evaluaci&oacute;n de H&aacute;bitat) in project 8.

Key fields from each submission (OData will flatten with `_` separators):

| Group | Fields |
|---|---|
| Site selection | `site_selection_site` (UUID), `site_selection_site_id`, `site_selection_site_name`, `site_selection_habitat_type`, `site_selection_assessment_date` |
| Canopy | `canopy_section_densiometer_readings_densi_north/east/south/west`, `canopy_section_open_sky_mean`, `canopy_section_canopy_cover_percent` |
| Height | `height_section_canopy_height_class` (`10_20`, `20_30`, `over_30`) |
| Trees | `tree_section_trees_medium`, `tree_section_trees_large` |
| Understory | `understory_section_understory_density` (`open`, `moderate`, `dense`) |
| Slope | `slope_section_slope_category` (`flat`, `slight`, `moderate`) |
| Edge | `edge_section_distance_to_edge_m`, `edge_section_adjacent_habitat` |
| Disturbance | `disturbance_signs` (space-separated: `none`, `cattle`, `logging`, `trails`) |
| Photos | `photo_section_photo_north/east/south/west/canopy` (filenames) |
| Meta | `meta_instanceID` (uuid:xxx format), `habitat_notes`, `habitat_assessed` |

**7 habitat types** (already defined in `src/app/biochoco/overview/types.ts` as `HABITAT_NAMES`):
1. `primary_forest` — Bosque Primario
2. `secondary_forest` — Bosque Secundario
3. `cacao_nacional` — Cacao Nacional
4. `cacao_giz` — Cacao GIZ
5. `cacao_ccn` — Cacao CCN
6. `reforestation` — Reforestaci&oacute;n
7. `pasture` — Potrero

## Proposed Solution

### Page Layout (`/biochoco/habitat`)

```
┌──────────────────────────────────────────────────┐
│  Evaluaci&oacute;n de H&aacute;bitat                            │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │           Map (Leaflet)                    │  │
│  │  ● Assessed (colored by habitat type)      │  │
│  │  ○ Not assessed (gray)                     │  │
│  │  Legend: 7 habitat colors + gray            │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  Progress: 12/95 sitios evaluados (12.6%)        │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │  Summary cards (one per habitat type)       │  │
│  │  - # sites assessed / total                 │  │
│  │  - Avg canopy cover %                       │  │
│  │  - Canopy height distribution               │  │
│  │  - Avg trees (medium + large)               │  │
│  │  - Understory density distribution          │  │
│  │  - Disturbance types found                  │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │  Detailed table (all assessed sites)        │  │
│  │  Site | Habitat | Canopy% | Height | Trees  │  │
│  │  | Understory | Slope | Dist. | Photos      │  │
│  │                                             │  │
│  │  Photos column: 5 thumbnails (N,E,S,W,C)   │  │
│  │  Click thumbnail → expand inline            │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

### Map Behavior

- All sites from the `monitoring_sites_v0_14` entity list shown on the map
- Sites WITH habitat assessment: colored by habitat type (7 distinct colors matching existing `HABITAT_NAMES`)
- Sites WITHOUT habitat assessment: gray, lower opacity
- Popup shows site ID, name, habitat type, and assessment date (if assessed)
- Reuse existing Leaflet + react-leaflet pattern with dynamic import (no SSR)
- Include FCAT reserve boundary overlay

### Summary Tables

One card per habitat type (grid layout, 2-3 columns). Each card shows:
- Count: `N assessed / M total sites`
- Avg canopy cover: mean of `canopy_cover_percent`
- Canopy height: bar showing distribution across `10_20`, `20_30`, `over_30`
- Trees: avg medium + avg large counts
- Understory: counts of open/moderate/dense
- Common disturbances: list of disturbance types found

### Photo Viewer

- In the detailed site table, each row has 5 small thumbnails (N, E, S, W, Canopy)
- Photos loaded via existing `/api/odk/photos` proxy route
- Click a thumbnail to expand it inline (or simple lightbox)
- Photo URL format: `/api/odk/photos?projectId=8&formId=habitat_assessment&id={instanceId}&file={filename}`

## Technical Approach

### Files to Create

| File | Purpose |
|---|---|
| `src/app/biochoco/habitat/page.tsx` | Server Component — permission check + data fetch |
| `src/app/biochoco/habitat/actions.ts` | Server action to fetch habitat submissions + sites |
| `src/app/biochoco/habitat/types.ts` | TypeScript interfaces for habitat data |
| `src/app/biochoco/habitat/habitat-shell.tsx` | Client Component — orchestrates map, tables, photos |
| `src/app/biochoco/habitat/habitat-map.tsx` | Client wrapper for dynamic Leaflet import |
| `src/app/biochoco/habitat/habitat-map-inner.tsx` | Leaflet map with habitat-colored markers |
| `src/app/biochoco/habitat/habitat-summary-cards.tsx` | Summary cards grid per habitat type |
| `src/app/biochoco/habitat/habitat-site-table.tsx` | Detailed table with inline photo thumbnails |

### Files to Modify

| File | Change |
|---|---|
| `src/lib/odk-constants.ts` | Add `BIOCHOCO_FORM_HABITAT = "habitat_assessment"` |
| `src/app/api/odk/photos/route.ts` | Add `BIOCHOCO_FORM_HABITAT` to `ALLOWED_FORMS` set |
| `src/components/sidebar-nav.tsx` | Add "H&aacute;bitat" nav item under BioChoc&oacute; |

### Data Flow

```
page.tsx (Server Component)
  → requirePermission("biochoco", "viewer")
  → fetchHabitatData() from actions.ts
    → Promise.all([
        fetchEntities(BIOCHOCO_PROJECT_ID, BIOCHOCO_DATASET_SITES),
        fetchSubmissions(BIOCHOCO_PROJECT_ID, BIOCHOCO_FORM_HABITAT, { flatten: true }),
      ])
    → Join sites with submissions on site UUID
    → Return { sites, assessments, assessedSiteIds }
  → <HabitatShell data={...} />
```

### Habitat Color Palette

```typescript
const HABITAT_COLORS: Record<string, string> = {
  primary_forest: "#1b7a3d",    // dark green
  secondary_forest: "#4caf50",  // medium green
  cacao_nacional: "#8B4513",    // saddle brown
  cacao_giz: "#D2691E",         // chocolate
  cacao_ccn: "#CD853F",         // peru
  reforestation: "#66BB6A",     // light green
  pasture: "#FDD835",           // yellow
};
```

### Instance ID Extraction

ODK `meta_instanceID` comes as `uuid:xxxxxxxx-xxxx-...`. The photo proxy expects just the UUID part. Strip the `uuid:` prefix when building photo URLs.

## Acceptance Criteria

- [x] Page at `/biochoco/habitat` requires `biochoco` viewer permission
- [x] Map shows all monitoring sites; assessed sites colored by habitat type, unassessed in gray
- [x] Map popups show site details and assessment date
- [x] Summary cards display per-habitat-type aggregated metrics (canopy %, height, trees, understory, disturbances)
- [x] Detailed table lists all assessed sites with key metrics
- [x] Inline photo thumbnails load via the existing photo proxy; click to expand
- [x] "H&aacute;bitat" nav item appears in sidebar under BioChoc&oacute;
- [x] `habitat_assessment` form added to photo proxy allowlist
- [x] All data fetched live from ODK Central (no local DB storage needed)
- [x] Spanish UI labels throughout

## Dependencies & Risks

- **ODK form ID assumption**: We're assuming `habitat_assessment` — if wrong, just update `BIOCHOCO_FORM_HABITAT` constant.
- **Submission flattening**: Using `fetchSubmissions(..., { flatten: true })` to get flat keys like `site_selection_site_id` instead of nested objects. Verify field names match.
- **Site coordinates**: Sites get lat/lng from the entity list (same as overview map), not from the habitat form itself.
- **Photo loading**: 5 photos per site could be slow for many sites. Thumbnails should be small and lazy-loaded.

## References

- Existing overview page pattern: `src/app/biochoco/overview/page.tsx`
- ODK client (fetchSubmissions with flatten): `src/lib/odk-client.ts:116`
- Photo proxy with allowlist: `src/app/api/odk/photos/route.ts`
- Habitat type constants: `src/app/biochoco/overview/types.ts:19`
- Leaflet map pattern: `src/app/biochoco/overview/overview-map-inner.tsx`
- Sidebar nav: `src/components/sidebar-nav.tsx:50`
