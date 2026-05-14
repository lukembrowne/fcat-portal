# Species Detection Browser — Brainstorm

**Date:** 2026-05-13
**Modules:** camera-trap, audio
**Status:** Brainstorm — ready for planning

## What We're Building

Per-module species detail pages that let users explore every detection of a given species across all accessible deployments. Two parallel routes — `/camera-trap/species/[scientificName]` and `/audio/species/[scientificName]` — that share components (header, filter bar, deployment map, site list, expansion grid) but render module-native detail UI (image grid vs. audio cards).

Each page answers: "Show me everywhere we've seen/heard this species, at what sites, and let me look at or listen to the actual detections."

Both pages are reached from a new sidebar entry **"Explorar por especie"** in each module's nav, which lands on a species index — a searchable list of all species with at least one detection in that module, sorted by detection count.

## Why This Approach

- **Separate per-module pages** keep the data model and UI language native to each module (ImageGrid for cameras, spectrogram + audio player for sound) while letting shared components — the deployment map, site list, filter bar, header — be extracted into a `src/components/species/` directory used by both routes.
- **Map + site drilldown** scales naturally. A species like Choco Toucan may have thousands of audio detections; a flat list is unusable. The map gives spatial context (which sites have this species), the site list gives a sorted-by-count summary, and expanding a site reveals paginated detections only for that site. Counts are computed once at the top level, not per detection.
- **All-deployments-by-default scope** matches the motivating use case ("hear all recordings of choco toucan") and respects per-project permissions automatically by filtering through `requirePermission()`-aware deployment queries.
- **Shared verification/species schema** means both modules can use the same query shape (join `deployments → files/images → detections → identifications → species`) with module-specific table names. No new data model.

## Key Decisions

### Page Structure
- **Routes:** `/camera-trap/species/[scientificName]` and `/audio/species/[scientificName]` (URL-encoded scientific name as slug; resolves to a row in `biochoco_species`).
- **Species index:** `/camera-trap/species` and `/audio/species` show a searchable table of species with detection counts in that module, sorted by count desc by default. (Note: the existing `/camera-trap/species` CRUD page may need to move to `/camera-trap/species/manage` or be merged.)
- **Nav entry:** "Explorar por especie" added to camera-trap and audio sidebar nav.

### Layout (same shape for both modules)
1. **Header** — species name (scientific + common + Spanish per `useSpeciesDisplay`), total count, project breakdown chip.
2. **Filter bar** — verification status (multi-select, default: hide rejected), project (single-select dropdown), and **audio-only** confidence threshold slider (respects the in-progress `audio-confidence` helper).
3. **Map** — deployment markers sized/colored by detection count, hover for site name + count, click to scroll to that site in the list below.
4. **Site list** — collapsible cards sorted by count desc. Each card shows: site name, project, count, last-detected date. Expanding a card loads that site's detections (paginated).
5. **Expansion (per site)** — module-specific:
   - **Camera trap:** Reuses `ImageGrid` to show detection crops/images for that species at that site, with verification badges. Click → existing image annotation overlay.
   - **Audio:** Card grid of detection clips. Each card has a small spectrogram strip (with the detection's frequency box highlighted), inline mini-player with ±3s padding, deployment/date/confidence/verification metadata, plus an **"Abrir en contexto"** link to `/audio/[id]/annotate/[fileId]` for deeper inspection.

### Filters (chosen)
- Verification status (multi-select; default: all except rejected)
- Project (single-select; default: all accessible)
- Confidence threshold — audio only (slider; respects existing/in-progress threshold pattern)

Date range was **not** selected — the site drilldown plus the activity already give enough temporal structure; can revisit if needed.

### Performance
- Top-level counts (total + per-site) computed via a single grouped query, not per-detection.
- Site expansion lazy-loads detections, paginated (e.g., 24 per page).
- Audio detection cards stream spectrogram crops from the existing cached spectrogram path; clip playback uses HTTP byte-range against the stored FLAC/WAV.
- Permissions enforced via the same deployment-scoped pattern used in module results pages.

## Open Questions

1. **Map component reuse** — does the portal already have a Leaflet/Mapbox component used elsewhere (e.g., deployment overview, weather dashboard)? If yes, reuse; if not, decide which provider.
2. **Species slug encoding** — use URL-encoded scientific name (`Ramphastos%20ambiguus`) or hyphenated (`Ramphastos-ambiguus`)? Hyphenated is friendlier but needs a lookup on render.
3. **Existing `/camera-trap/species` CRUD page** — does it move to `/camera-trap/species/manage` (admin-only), or do we merge "edit master data" into the new index? Suggest moving to a subpath to keep the index purely exploratory.
4. **Default verification filter** — confirm "all except rejected" is correct; or should unverified be shown separately from verified by default?
5. **Audio playback latency** — clip extraction on-the-fly with `ffmpeg`/byte-range vs. pre-cached clips. Probably byte-range against the existing FLAC, but worth verifying for large batches.
6. **Per-site pagination size** — start at 24 (matches ImageGrid columns)? Add infinite scroll or numbered pagination?
7. **Activity sparkline on site cards** — useful summary, but adds another query. Defer to v2 unless cheap.
8. **Unified `/species/[name]` overview** — out of scope for v1 per decision to keep modules separate, but worth flagging as a possible future addition that links to both module-specific pages.

## Components to Extract / Build

- `src/components/species/species-header.tsx` — name display + total count chip
- `src/components/species/species-filter-bar.tsx` — verification + project + (optional) confidence
- `src/components/species/deployment-map.tsx` — markers sized by count
- `src/components/species/site-list.tsx` — expandable site cards
- `src/components/species/audio-detection-card.tsx` — spectrogram strip + mini-player + open-in-context link
- Camera trap expansion reuses existing `ImageGrid`

## Data Access Patterns

- **Species index per module:** `SELECT species, COUNT(*) FROM <module>_identifications WHERE deployment IN (accessible) GROUP BY species ORDER BY count DESC`
- **Species detail counts:** `SELECT deployment_id, COUNT(*) FROM <module>_identifications WHERE species = ? AND deployment IN (accessible) GROUP BY deployment_id`
- **Site expansion:** paginated query for that species + that deployment, joined to file/image metadata for display.

All queries pass through the user's permission scope via the same helpers used in module results pages.

## Next

Run `/workflows:plan` to break this into implementation steps.
