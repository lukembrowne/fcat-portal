# Site Results Dashboard — Brainstorm

**Date:** 2026-03-15
**Status:** Ready for planning

## What We're Building

A new "Resultados" section in the BioChoco module (`/biochoco/resultados`) that provides integrated, site-level summaries of all monitoring data. Each monitoring site gets a dashboard aggregating camera trap results, temperature data, habitat assessments, and (eventually) audio data across all deployments/visits.

### Two-level navigation:

1. **Landing page** (`/biochoco/resultados`) — Interactive Leaflet map showing all sites with data readiness indicators, plus a filterable table below. Clicking either navigates to the site detail page.

2. **Site detail page** (`/biochoco/resultados/[siteId]`) — Comprehensive dashboard for a single site, aggregating data across all deployments.

## Why This Approach

- **Site-level** (not deployment-level) because the ecological question is "what's happening at this location over time?" — individual visits are implementation details.
- **Aggregate across visits** to show cumulative species lists, temperature trends, and effort — with the ability to drill into individual deployments when needed.
- **Map + table landing** mirrors the existing overview page pattern, keeping the UX consistent.
- **Internal only** for now — no public sharing, no auth complexity. Can revisit later.

## Site Detail Page Sections

### 1. Header + Location Map
- Site name, ID, habitat type, coordinates
- Small static Leaflet map showing the site pinpointed within the reserve boundary
- Summary stats: total deployments, total camera trap days, date range of monitoring

### 2. Camera Trap Results (Fauna)
- **Species cards grid**: Each card shows:
  - Species name (scientific + Spanish common name)
  - Detection count across all deployments
  - Average confidence score
  - Representative photo thumbnail (best confidence detection from actual images)
- Cards sorted by detection count (most common first)
- Summary stats: total species, total detections, species by taxonomic group (mammal/bird/reptile/etc.)

### 3. Temperature (iButton)
- **Overlay chart**: All deployments' temperature readings on one chart, different color per visit
  - X-axis: date, Y-axis: temperature °C
  - Legend showing deployment ID / date range per color
- Summary stats: overall min/max/mean across all deployments
- Links to individual deployment detail pages (`/biochoco/ibutton/[id]`) for full data

### 4. Habitat Assessment
- Key metrics displayed as stat cards: canopy cover %, tree count, understory density, slope, distance to edge, disturbance signs
- 5 directional photos (N/E/S/W/canopy) from the ODK habitat assessment form
- If multiple assessments exist (multiple visits), show the most recent with a note

### 5. Audio (Placeholder)
- "Próximamente" placeholder section
- Brief description of what will go here once acoustic monitoring data is available

## Landing Page Data Readiness

The table on the landing page shows each site with indicators for which data types are available:

| Column | Source | "Ready" condition |
|--------|--------|-------------------|
| Cámaras | `biochoco_deployments` with status ≥ processed | Has at least one processed deployment with identifications |
| Temperatura | `ibutton_uploads` | Has at least one iButton upload for the site |
| Hábitat | ODK habitat form | Has a habitat assessment submission |
| Audio | — | Always "pending" for now |

Sites with no data at all could be shown grayed out or filtered out.

## Key Decisions

- **Route**: `/biochoco/resultados` with "Resultados" nav item in sidebar
- **Grouping**: By site, aggregating all deployments/visits
- **Species display**: Cards with actual photo thumbnails from detections
- **Temperature**: Overlay chart comparing visits with different colors
- **Habitat**: Stats + 5 directional photos from ODK
- **Detail map**: Small Leaflet map on each site page
- **Audio**: Placeholder section for future implementation
- **Access**: Internal only (standard BioChoco permissions)

## Open Questions

- Should species cards link to the full camera trap results page for that deployment, or show an expanded view inline?
- For the landing page map, what colors/icons should indicate data readiness? (Could reuse habitat type colors with overlay icons for data status)
- Should there be any export/download capability (PDF report per site for sharing with landowners later)?
- How to handle sites with only partial data (e.g., camera trap done but no iButton yet) — show what's available with "sin datos" for the rest?

## Data Sources Summary

| Data | Storage | Access Pattern |
|------|---------|----------------|
| Site list + coordinates | ODK dataset `BIOCHOCO_DATASET_SITES` | Already fetched by overview page |
| Deployments | `biochoco_deployments` table | Query by siteName or derive siteId from deployment name |
| Camera trap species | `biochoco_identifications` + `biochoco_species` | JOIN through images → detections → identifications |
| Species photos | Photo proxy API (`/api/odk/photos/...`) or Drive | Need representative image selection logic |
| Temperature readings | `ibutton_readings` + `ibutton_uploads` | Query by deploymentId |
| Habitat assessment | ODK form submissions | Fetch from ODK API (like existing habitat page) |
