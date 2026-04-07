---
title: "feat: Site Results Dashboard for BioChoco"
type: feat
date: 2026-03-15
brainstorm: docs/brainstorms/2026-03-15-site-results-dashboard-brainstorm.md
---

# feat: Site Results Dashboard for BioChoco

## Overview

Add a "Resultados" section to the BioChoco module (`/biochoco/resultados`) that provides integrated, site-level summaries of all monitoring data. Each monitoring site gets a dashboard aggregating camera trap species, temperature trends, and habitat assessments across all deployments/visits.

## Problem Statement / Motivation

Currently, monitoring data is scattered across separate sections (camera trap results, iButton temperature, habitat assessments). Researchers must manually cross-reference data from multiple pages to understand what's happening at a single site. This feature consolidates everything into one place per site, answering the core ecological question: "What's at this location?"

## Proposed Solution

Two-page feature:

1. **Landing page** (`/biochoco/resultados`) — Map + filterable table showing all sites with data readiness icons
2. **Site detail page** (`/biochoco/resultados/[siteId]`) — Comprehensive dashboard with camera trap species cards, temperature overlay chart, habitat stats + photos, and audio placeholder

## Key Decisions (from brainstorm)

- **Only verified/corrected** species identifications are shown (strict filter)
- **Excluded deployments** (`excluded=true`) are filtered out
- **Absolute time** for temperature overlay chart (real dates, no alignment)
- **Simple icons** for data readiness (✓ green / ✗ gray / ⏳ amber)
- **Representative photo**: Highest-confidence verified detection per species
- **Multiple habitat assessments**: Show most recent, note if others exist
- **Detection class filter**: Only animal detections (class 1)
- **Fix ct-images API** to accept biochoco permission
- **Species with correctedSpecies**: Use `coalesce(correctedSpecies, species)` per existing pattern

## Technical Approach

### Architecture

```
/biochoco/resultados/
├── page.tsx                    # Server Component — landing page
├── actions.ts                  # Server actions for data fetching
├── types.ts                    # Types for resultados feature
├── resultados-shell.tsx        # Client shell for landing page (map + table)
├── resultados-map.tsx          # Server wrapper for dynamic map import
├── resultados-map-inner.tsx    # Client Leaflet map component
├── site-table.tsx              # Client filterable table component
├── loading.tsx                 # Skeleton loader
└── [siteId]/
    ├── page.tsx                # Server Component — site detail page
    ├── site-detail-shell.tsx   # Client shell for detail page
    ├── site-location-map.tsx   # Small static map wrapper
    ├── site-location-map-inner.tsx  # Client Leaflet map (small)
    ├── species-cards.tsx       # Species card grid component
    ├── temperature-overlay.tsx # Multi-deployment temperature chart
    └── loading.tsx             # Skeleton loader
```

### Data Flow

```
Landing page:
  Server Action fetchResultadosData() →
    parallel: [fetchOdkSites(), queryDeploymentsByBiochocoProject(), queryIbuttonUploads()]
    → compute data readiness per site
    → return { sites: SiteWithReadiness[] }

Site detail page:
  Server Action fetchSiteDetail(siteId) →
    parallel: [
      fetchOdkSites(),                    // site metadata
      queryDeploymentsForSite(siteId),    // all non-excluded deployments
      querySpeciesForSite(siteId),        // aggregated species with photo IDs
      queryTemperatureForSite(siteId),    // iButton readings grouped by deployment
      fetchHabitatForSite(siteId),        // ODK habitat assessment
    ]
    → return { site, deployments, species, temperature, habitat }
```

### Implementation Phases

#### Phase 1: Foundation — Data Layer + Navigation

**Goal**: Server actions that aggregate data correctly, sidebar nav entry, route scaffolding.

**Files to create/modify:**

- `src/app/biochoco/resultados/types.ts` — New types:
  ```typescript
  // Types needed:
  // SiteWithReadiness — extends SiteInfo with readiness flags per data type
  // ReadinessStatus — 'complete' | 'in_progress' | 'none'
  // SiteSpecies — species name, spanish name, type, detectionCount, confidence, photoImageId
  // SiteTemperature — deploymentId, deploymentName, dateRange, readings[]
  // SiteDetail — full site data bundle
  ```

- `src/app/biochoco/resultados/actions.ts` — Server actions:
  - `fetchResultadosData()` — Landing page data
    - Fetch ODK sites (reuse pattern from `overview/actions.ts`)
    - Query `biochoco_deployments` filtered by BioChoco project, `excluded != true`
    - Query `ibutton_uploads` joined to deployments
    - Map deployments to sites using `siteName` first, then `extractSiteId()` fallback
    - Compute readiness per site:
      - Cámaras: ✓ if any deployment has `status IN ('processed','verified')` with verified/corrected identifications; ⏳ if deployments exist but unprocessed; ✗ if none
      - Temperatura: ✓ if `ibutton_uploads` exist for any deployment at this site; ✗ otherwise
      - Hábitat: ✓ if ODK habitat assessment exists for site; ✗ otherwise
      - Audio: always ✗ (placeholder)
  - `fetchSiteDetail(siteId: string)` — Site detail page data
    - Find all non-excluded deployments for this site
    - Species aggregation query:
      ```sql
      SELECT coalesce(i.corrected_species, i.species) as species_name,
             s.spanish_name, s.type as taxonomic_type,
             count(*) as detection_count,
             avg(i.confidence) as avg_confidence,
             (SELECT img.id FROM biochoco_images img
              JOIN biochoco_detections det ON det.image_id = img.id
              JOIN biochoco_identifications ident ON ident.detection_id = det.id
              WHERE coalesce(ident.corrected_species, ident.species) = coalesce(i.corrected_species, i.species)
              AND ident.verification_status IN ('verified','corrected')
              AND det.detection_class = 1
              AND img.deployment_id IN (...)
              ORDER BY ident.confidence DESC LIMIT 1) as photo_image_id
      FROM biochoco_identifications i
      JOIN biochoco_detections d ON d.id = i.detection_id
      JOIN biochoco_images img ON img.id = d.image_id
      LEFT JOIN biochoco_species s ON s.scientific_name = coalesce(i.corrected_species, i.species)
      WHERE img.deployment_id IN (:deploymentIds)
        AND i.verification_status IN ('verified','corrected')
        AND d.detection_class = 1
      GROUP BY species_name
      ORDER BY detection_count DESC
      ```
    - Temperature: Query `ibutton_readings` for all deployment IDs at this site, grouped by deployment
    - Habitat: Fetch ODK habitat submissions, filter by siteId, take most recent
    - Return `ActionResult<SiteDetail>`

- `src/components/sidebar-nav.tsx` — Add "Resultados" after "Temperatura":
  ```typescript
  biochocoChildren.push({ label: "Resultados", href: "/biochoco/resultados" });
  ```

- `src/app/api/ct-images/[id]/route.ts` — Fix permission check to also accept `biochoco`:
  ```typescript
  // Change from:
  user.permissions.some((p) => p.projectId === "camera-trap")
  // To:
  user.permissions.some((p) => p.projectId === "camera-trap" || p.projectId === "biochoco")
  ```

**Shared utilities to extract/reuse:**
- Move `extractSiteId()` from `ibutton/actions.ts` to a shared location (e.g., `src/app/biochoco/utils.ts`) since both iButton and resultados need it
- Reuse `SiteInfo` type from `overview/types.ts`
- Reuse `HABITAT_NAMES`, `HABITAT_COLORS`, `getHabitatName()` from existing files

**Success criteria:**
- [x] Server actions return correct data for sites with full data, partial data, and no data
- [x] Species query only returns verified/corrected identifications with detection class 1
- [x] Excluded deployments are filtered out
- [x] "Resultados" appears in sidebar navigation
- [x] ct-images API accepts biochoco permission

---

#### Phase 2: Landing Page — Map + Table

**Goal**: Interactive map with site markers + filterable table with data readiness icons.

**Files to create:**

- `src/app/biochoco/resultados/page.tsx` — Server Component:
  ```typescript
  export default async function ResultadosPage() {
    await requirePermission("biochoco", "viewer");
    const result = await fetchResultadosData();
    if (!result.success) return <ErrorState />;
    return <ResultadosShell data={result.data} />;
  }
  ```

- `src/app/biochoco/resultados/loading.tsx` — Skeleton with map placeholder + table rows

- `src/app/biochoco/resultados/resultados-shell.tsx` — `"use client"` shell:
  - Map section (dynamic import, ssr: false)
  - Table section with filters
  - State: search text, habitat type filter

- `src/app/biochoco/resultados/resultados-map.tsx` — Server wrapper filtering valid-coordinate sites, dynamic import of inner map

- `src/app/biochoco/resultados/resultados-map-inner.tsx` — `"use client"` Leaflet map:
  - Reuse pattern from `overview-map-inner.tsx`
  - Circle markers colored by habitat type (reuse `HABITAT_COLORS`)
  - Popup with site name, habitat, readiness summary, "Ver resultados →" link
  - Reserve boundary overlay via `useReserveBoundary()`
  - Two tile layers (Calles/Satelite)

- `src/app/biochoco/resultados/site-table.tsx` — `"use client"` filterable table:
  - Columns: Sitio (ID + name), Hábitat, Visitas (deployment count), Cámaras, Temperatura, Hábitat, Audio
  - Readiness icons: ✓ (green `CheckCircle2`), ⏳ (amber `Clock`), ✗ (gray `Minus`)
  - Search filter on site name/ID
  - Habitat type dropdown filter
  - Row click → `router.push(/biochoco/resultados/${siteId})`
  - Sort by any column

**Reusable components:**
- `Card`/`CardHeader`/`CardTitle`/`CardContent` from shadcn/ui
- Lucide icons for readiness indicators

**Success criteria:**
- [x] Map renders all sites with valid coordinates
- [x] Table shows all sites with correct readiness icons
- [x] Clicking map popup or table row navigates to site detail
- [x] Filters work (search + habitat dropdown)
- [x] `min-w-0` on all flex children to prevent sidebar overflow (per documented gotcha)
- [x] Empty state if no sites exist

---

#### Phase 3: Site Detail — Header + Camera Trap Species Cards

**Goal**: Site detail page header with location map, summary stats, and species card grid.

**Files to create:**

- `src/app/biochoco/resultados/[siteId]/page.tsx` — Server Component:
  ```typescript
  export default async function SiteDetailPage({ params }: { params: Promise<{ siteId: string }> }) {
    await requirePermission("biochoco", "viewer");
    const { siteId } = await params;
    const result = await fetchSiteDetail(siteId);
    if (!result.success) return <ErrorState />;
    if (!result.data.site) return <NotFound />;
    return <SiteDetailShell data={result.data} />;
  }
  ```

- `src/app/biochoco/resultados/[siteId]/loading.tsx` — Skeleton loader

- `src/app/biochoco/resultados/[siteId]/site-detail-shell.tsx` — `"use client"` shell:
  - Breadcrumb: Resultados > {siteName}
  - Header section with site info + small map
  - Sections separated by `<Separator />`
  - Sections: Fauna, Temperatura, Hábitat, Audio

- `src/app/biochoco/resultados/[siteId]/site-location-map.tsx` + `site-location-map-inner.tsx`:
  - Small map (~200px height) centered on site coordinates
  - Single marker for the site
  - Reserve boundary overlay
  - No interaction (scroll zoom disabled)
  - Pattern: dynamic import, ssr: false

- `src/app/biochoco/resultados/[siteId]/species-cards.tsx` — `"use client"`:
  - Summary bar: "X especies · Y detecciones · Z visitas verificadas"
  - Responsive grid of species cards (2-3 columns on desktop)
  - Each card:
    - Photo thumbnail via `/api/ct-images/{photoImageId}?size=thumb` (or placeholder silhouette if no photo)
    - Species name (scientific, italic) + Spanish common name
    - Detection count badge
    - Average confidence percentage
    - Taxonomic group icon/badge (mammal, bird, reptile, etc.)
  - Sorted by detection count descending
  - Empty state: "No se han verificado identificaciones de especies para este sitio."

**Success criteria:**
- [x] Site detail page loads with correct header info
- [x] Small map shows site within reserve boundary
- [x] Species cards render with photos from ct-images API
- [x] Cards correctly filtered to verified/corrected only
- [x] Graceful handling when no species data exists
- [x] 404 handling for invalid siteId
- [x] Breadcrumb navigation works

---

#### Phase 4: Site Detail — Temperature + Habitat + Audio Placeholder

**Goal**: Complete the site detail page with remaining sections.

**Files to create:**

- `src/app/biochoco/resultados/[siteId]/temperature-overlay.tsx` — `"use client"`:
  - Uses Recharts `LineChart` with `ResponsiveContainer`
  - One `Line` per deployment, each with a distinct color from a palette
  - X-axis: absolute dates (`dateFormatter` from existing pattern)
  - Y-axis: temperature °C
  - Tooltip showing deployment name + date + temperature
  - Legend showing deployment name + date range per color
  - Summary stats row: Overall min/max/mean across all deployments
  - Links to individual deployment pages: "Ver detalle →" for each deployment
  - **Performance**: Downsample to daily min/max/mean if total readings > 5,000 (aggregate server-side)
  - Empty state: "No hay datos de temperatura para este sitio."

- Habitat section (inline in `site-detail-shell.tsx` or separate component):
  - Stats cards grid:
    - Cobertura del dosel (canopy cover %)
    - Conteo de árboles (tree count)
    - Densidad del sotobosque (understory density label)
    - Pendiente (slope)
    - Distancia al borde (distance to edge)
    - Signos de perturbación (disturbance signs)
  - 5 directional photos in a row:
    - Labels: Norte, Este, Sur, Oeste, Dosel
    - Photos via `/api/odk/photos?projectId=8&formId=habitat_assessment&id={instanceId}&file={filename}`
    - Placeholder if photo missing
  - Note if multiple assessments: "Evaluación más reciente (de N total)"
  - Empty state: "No se ha realizado evaluación de hábitat para este sitio."

- Audio placeholder section:
  - Card with muted styling
  - "Audio — Próximamente"
  - Brief text: "Los datos de monitoreo acústico se integrarán en una futura actualización."

**Performance considerations for temperature:**
- Server-side: If a site has >5,000 total readings across all deployments, aggregate to daily stats (min, max, mean per day per deployment) before sending to client
- Client-side: Recharts handles ~5,000 points well; daily aggregation keeps it under that threshold for most sites

**Success criteria:**
- [x] Temperature overlay chart renders multiple deployments in different colors
- [x] Chart handles sites with 1 deployment and sites with 10+ deployments
- [x] Habitat stats display correctly from ODK data
- [x] Habitat photos load via ODK photo proxy
- [x] Empty states render for all sections when no data exists
- [x] Audio placeholder is visible and clearly marked as future
- [x] Page performs well with realistic data volumes

---

## Data Model Notes

No new database tables needed. All data is queried from existing tables:

- `biochoco_deployments` — filtered by BioChoco project + `excluded != true`
- `biochoco_images` → `biochoco_detections` → `biochoco_identifications` — species data
- `biochoco_species` — species name lookup
- `ibutton_uploads` + `ibutton_readings` — temperature data
- ODK API — site entities + habitat form submissions

### Site-to-Deployment Join Strategy

Priority order:
1. `deployment.siteName` matches ODK entity `site_id` or `site_name`
2. `extractSiteId(deployment.name)` via regex `^(.+?)_V\d+$/i` matches ODK entity `site_id`
3. If neither matches, deployment is excluded from results (logged as warning)

## Dependencies & Risks

| Risk | Mitigation |
|------|------------|
| ODK API latency (2-5s for habitat data) | Parallel fetching; loading skeletons; consider caching |
| Large temperature datasets for sites with many visits | Server-side daily aggregation when >5,000 readings |
| Species photos not yet generated (no thumbnail) | Graceful fallback to placeholder icon |
| Deployment-to-site mapping failures | Two-step fallback (siteName → extractSiteId); log unmapped deployments |
| Leaflet SSR crash | Existing pattern: dynamic import with `{ ssr: false }` |
| Sidebar overflow with wide table | Apply `min-w-0` per documented gotcha |

## Acceptance Criteria

### Functional
- [ ] "Resultados" nav item appears in BioChoco sidebar for all biochoco viewers
- [ ] Landing page shows interactive map with all sites + filterable table
- [ ] Data readiness icons correctly reflect available data per site
- [ ] Site detail page shows header with location map and summary stats
- [ ] Species cards show only verified/corrected identifications (animal detections only)
- [ ] Species cards display representative photos via ct-images API
- [ ] Temperature overlay chart shows all deployments in different colors
- [ ] Habitat section shows stats + directional photos from ODK
- [ ] Audio placeholder section is visible
- [ ] Excluded deployments are filtered out everywhere
- [ ] ct-images API accepts biochoco project permission

### Non-Functional
- [ ] Page loads in <3s for sites with typical data volumes
- [ ] Temperature chart handles 10+ deployments without browser freeze
- [ ] All UI strings in Spanish
- [ ] Empty states for every section when data is absent
- [ ] Loading skeletons for both pages
- [ ] 404 handling for invalid siteId
- [ ] `requirePermission("biochoco", "viewer")` on all server actions

## References

### Internal
- Brainstorm: `docs/brainstorms/2026-03-15-site-results-dashboard-brainstorm.md`
- Sidebar nav: `src/components/sidebar-nav.tsx:61-75`
- ODK site entities: `src/lib/odk-types.ts:218-227` (`OdkSiteEntity`)
- Site info type: `src/app/biochoco/overview/types.ts:3-10` (`SiteInfo`)
- Extract site ID: `src/app/biochoco/ibutton/actions.ts:125-128` (`extractSiteId()`)
- Species count pattern: `src/app/camera-trap/actions.ts:1218-1227`
- iButton queries: `src/app/biochoco/ibutton/actions.ts`
- Habitat fetching: `src/app/biochoco/habitat/actions.ts`
- Map pattern: `src/app/biochoco/overview/overview-map-inner.tsx`
- Temperature chart: `src/app/biochoco/ibutton/[id]/temperature-line-chart.tsx`
- Photo proxy: `src/app/api/ct-images/[id]/route.ts:47-51` (permission fix needed)
- Reserve boundary: `src/lib/use-reserve-boundary.ts`
- Habitat colors: `src/app/biochoco/habitat/types.ts` (`HABITAT_COLORS`)

### Documented Gotchas (from docs/solutions/)
- `min-w-0` on flex children to prevent map/table overflow in sidebar layouts
- ODK `{ flatten: true }` for grouped form data (habitat assessment)
- `coalesce(correctedSpecies, species)` for species names
- `requirePermission()` on ALL server actions, not just pages
- Never use async in `db.transaction()` callbacks (better-sqlite3 is synchronous)
- Google Shared Drive API requires `supportsAllDrives: true`
