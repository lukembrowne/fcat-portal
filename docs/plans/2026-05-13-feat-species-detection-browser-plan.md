---
title: Species Detection Browser
type: feat
date: 2026-05-13
modules: [camera-trap, audio]
related_brainstorm: docs/brainstorms/2026-05-13-species-detection-browser-brainstorm.md
depends_on: docs/plans/2026-05-13-feat-birdnet-confidence-threshold-filter-plan.md
deepened: 2026-05-13
---

# Species Detection Browser

## Enhancement Summary (2026-05-13 deepen pass)

Multi-agent review surfaced corrections in four areas. Apply these BEFORE starting Phase 1.

### Critical (must apply)

1. **Replace `effectiveSpeciesColumn` CASE-WHEN aggregation with UNION ALL queries.** CASE on the GROUP BY key is non-sargable on SQLite and forces a full table scan + temp B-tree sort at the BIOCHOCO scale (~1M audio identifications). Two index-eligible queries unioned in JS gives a 10–50× speedup. See "Architecture — Research Insights" below for the rewritten helper API.
2. **Partial indexes per identifications table, added in Phase 1 (not Phase 4).** One for active (non-corrected, non-rejected) rows on `species`, one for corrected rows on `corrected_species`. Plus a covering index for the species-index aggregation. Detail in "Phase 1 — Research Insights."
3. **Each server action MUST independently apply `ctProjectFilter`.** Don't rely on a parent query having filtered. This becomes an explicit acceptance criterion and a test assertion. Without it, deep-links like `?site=<id>` could leak deployment existence via timing or count differences.
4. **Whitelist all URL params before they reach Drizzle.** New helper `src/lib/species-search-params.ts` with parsers for `status` (enum whitelist), `project` (intersected with user's projects), `site`/`page`/`t` (positive integers, clamped). Without this, `?status=` could trigger Drizzle type coercion against an unexpected value.
5. **`projectIds` on `SpeciesIndexRow` must be aggregated from the same filtered query, not a second unfiltered lookup.** Otherwise a viewer with access to project A can see that species also exist in projects B/C.
6. **Phase 1 needs a redirect.** Between Phase 1 (CRUD moves to `/manage`) and Phase 2 (new index lands at `/species`), the bare `/species` route is a 404. Either land Phase 1 + the bare `/species` index together, or add a temporary redirect `/camera-trap/species` → `/camera-trap/species/manage` in Phase 1, removed when Phase 2 lands.

### High-value (apply before implementation)

7. **Colocate `effective-species` helper with schema, not in `src/lib/`.** Move to `src/db/effective-species.ts`. Pass Drizzle table objects, not string identifiers, so refactors stay type-safe.
8. **`react-leaflet-cluster` added to Phase 2 with a 30-marker threshold.** Below 30 the cluster overhead adds nothing; above 30 it prevents marker collision on the dense Chocó cluster.
9. **Verify `/api/audio/stream` honors HTTP `Range`.** Add an integration test asserting `206 Partial Content` for ranged requests. Without `Range` support, Media Fragment URI playback downloads the entire 30 MB FLAC before honoring `#t=`.
10. **Debounce URL syncing on the species-index search input.** Client-side filtering can be instant per keystroke, but `router.replace` should debounce at ~250 ms to avoid history spam. Use `replace` (not `push`).
11. **Clamp `?t=` server-side on the audio annotation page** to `[0, file.durationSeconds]` and reject NaN. Setting `currentTime` must wait for the audio element's `loadedmetadata` event.

### Simplifications (apply, then proceed)

12. **Drop `audio-detection-card-fallback.ts`.** Inline a 5-line `timeupdate` handler in `audio-detection-card.tsx` if a fallback turns out to be needed. Don't pre-extract.
13. **Drop `no-location-list.tsx`.** Inline `<details><summary>Sin ubicación</summary>...</details>` directly in `[slug]/page.tsx` — ~15 lines.
14. **Merge `site-card.tsx` into `site-list.tsx`.** A single card type rendered only by its list.
15. **Drop the `deployment-map.tsx` wrapper.** Call `dynamic(() => import("./deployment-map-inner"), { ssr: false })` directly where it's used. Mirrors `biochoco/overview` exactly.
16. **Move `audio-detection-card.tsx` to `src/app/audio/species/_components/`.** It depends on audio-only data shape, stream route, and annotation route. Keeping it in a "shared" folder is a leaky abstraction.
17. **Defer the `ImageGrid.highlightSpecies` prop to v2.** Edit to a shared component used elsewhere is regression surface for marginal UX gain. Existing badges already identify species per detection.
18. **Cut the Mermaid ER diagram.** Documents existing tables with no changes — adds noise.
19. **Fold Phase 4 into Phases 2 & 3.** Tests for an action belong in the same PR as the action. `EXPLAIN QUERY PLAN` takes 2 minutes — do it while writing the query, not as a separate phase. Three phases total: Foundation, Camera Trap, Audio. (E2E test for one species flow stays — keep a small Phase 4 just for the cross-module E2E + CLAUDE.md update.)

### Naming / documentation

20. **Document `cameraTrapProjectAccess` as the canonical deployment-access table** in `CLAUDE.md`, so a future audio-permissions refactor doesn't quietly create a leak. Consider renaming `getUserCameraTrapProjects` → `getUserDeploymentProjects` (separate refactor PR — out of scope for this plan, but flag it).
21. **Use `?seek=` instead of `?t=` on the annotation page** to avoid mental collision with Media Fragment URI `#t=`. Minor.

---

## Overview

Add per-module species detail pages that let users explore every detection of a single species across all accessible deployments. Two parallel routes — `/camera-trap/species/[slug]` and `/audio/species/[slug]` — share a layout (header → filter bar → deployment map → site list → expand-per-site drilldown) but render module-native detail UI (image grid for cameras, audio cards with inline playback for sound).

Each module gains a new sidebar entry "Explorar por especie" that lands on a searchable species index — a table of every species with at least one detection in that module, sorted by detection count descending.

This feature is read-only and adds zero new database tables. It builds on existing helpers (`requirePermission`, `getUserCameraTrapProjects`, `applyConfidenceFilter`, `ImageGrid`, `useSpeciesDisplay`) and the in-codebase `react-leaflet` pattern from the BIOCHOCO maps.

## Problem Statement / Motivation

Today, detections are siloed inside their parent deployment. To answer "where have we recorded Choco Toucan?" a user must open every audio deployment, filter to that species, repeat for camera trap. There is no single place to:

1. See the spatial distribution of a species across all FCAT sites.
2. Compare detection counts at sites for one species at a glance.
3. Listen to many recordings of the same species back-to-back.
4. Review verified + unverified detections of a species in one view.

The motivating user phrase: "if I want to hear all recordings of Choco Toucan, I'd like a way to easily do that."

## Proposed Solution

### Routes

| Path | Purpose | Permission |
|---|---|---|
| `/camera-trap/species` | Camera trap species index (searchable list with counts) | `camera-trap` viewer+ |
| `/camera-trap/species/[slug]` | Camera trap species detail (map + site drilldown) | `camera-trap` viewer+ |
| `/camera-trap/species/manage` | **Moved** from current `/camera-trap/species` — existing CRUD UI for species master data | `camera-trap` editor+ |
| `/audio/species` | Audio species index | `grabaciones` viewer+ |
| `/audio/species/[slug]` | Audio species detail | `grabaciones` viewer+ |
| `GET /api/audio/spectrogram-strip` (optional v2) | PNG strip for a time window | inherits grabaciones |

### Layout (both modules)

```
┌──────────────────────────────────────────────────────────────────┐
│  Ramphastos ambiguus  ·  Tucán del Chocó  ·  1.832 detecciones  │
├──────────────────────────────────────────────────────────────────┤
│  [Estado ▾]  [Proyecto ▾]  [Confianza: 0.70 ──●──]  (audio only) │
├──────────────────────────────────────────────────────────────────┤
│  ┌─ Mapa ──────────────────────────────────────────┐             │
│  │  ●412   ·   ●245   ·   ●89   ·   ●12             │             │
│  └──────────────────────────────────────────────────┘             │
│  Sitios (12) — orden: por conteo desc                            │
│  ▸ La Marquesa            412 detecciones                        │
│  ▾ Río Manduriacu (open)  245 detecciones                        │
│       [pagination 1 of 11]                                       │
│       ┌─ cards / images grid for this site ─┐                    │
│       │  ...                                │                    │
│       └─────────────────────────────────────┘                    │
│  ▸ Tesoro Escondido       89 detecciones                         │
│  ...                                                             │
│  Sin ubicación (no lat/lng): 3 sitios — [expand]                 │
└──────────────────────────────────────────────────────────────────┘
```

### Drilldown semantics

At most **one site is expanded at a time**, controlled by URL: `?site=<deploymentId>&page=<n>`. Filters live in `?status=...&project=...&conf=...`. Filter changes reset `page=1` and validate that `site` still has results; if not, the expansion collapses with an empty-state hint.

### Audio detection card UX

```
┌──────────────────────────────────────────────┐
│  Río Manduriacu  ·  2026-02-14 06:32:18      │
│  Confianza: 87 %   ✓ Verificado por luis     │
│  ▶ 0:00 / 0:07 (±3 s)                        │
│  [ Abrir en contexto → ]                     │
└──────────────────────────────────────────────┘
```

The inline player uses an HTML5 `<audio>` element with a Media Fragment URI (`#t=<start>,<end>`) hitting `/api/audio/stream`. The "Abrir en contexto" link goes to `/audio/[deploymentId]/annotate/[fileId]?t=<detectionStart>` (existing annotation page; the `t` param is a new optional anchor — small additive change to that page).

### Camera trap detection card UX

The existing `ImageGrid` is reused as-is for per-site expansion. Each image already shows bounding boxes + verification badges. One small addition: pass an optional `highlightSpecies` prop so the grid can dim bounding boxes of OTHER species on the image (gap #20 from spec-flow analysis).

## Architecture

### Data model — no schema changes

All data already exists:

- `biochoco_deployments.latitude`, `longitude` (real, nullable)
- `biochoco_species` (scientific name unique, common, spanish, type)
- `biochoco_detections` / `biochoco_identifications` (with `species`, `correctedSpecies`, `verificationStatus`)
- `audio_files` / `audio_detections` / `audio_identifications` (parallel structure)

### Effective-species semantics

A detection's "effective species" is computed at read time:

```
if verificationStatus = 'rejected'         → ignored (not a detection of any species)
if verificationStatus = 'corrected'        → effective species = correctedSpecies
else                                       → effective species = species
```

For audio, the `unverified` case also passes `applyConfidenceFilter(threshold)` (see `src/lib/audio-confidence.ts`).

This means counts and listings must aggregate by **effective species**, NOT raw `species` (gap #2). A new helper centralizes this:

```typescript
// src/lib/effective-species.ts
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

/**
 * Drizzle SQL fragment: identification row matches the given effective species name.
 * Excludes rejected. Honors correctedSpecies semantics.
 *
 * Usage:
 *   .where(and(effectiveSpeciesMatches('biochoco', scientificName), ...))
 */
export function effectiveSpeciesMatches(
  table: "biochoco" | "audio",
  scientificName: string
): SQL {
  const prefix = table === "biochoco" ? sql.identifier("biochoco_identifications") : sql.identifier("audio_identifications");
  return sql`(
    ${prefix}.verification_status != 'rejected'
    AND (
      (${prefix}.verification_status = 'corrected' AND ${prefix}.corrected_species = ${scientificName})
      OR (${prefix}.verification_status != 'corrected' AND ${prefix}.species = ${scientificName})
    )
  )`;
}

/**
 * Computed-column SQL for grouping by effective species name.
 * Returns the species used for aggregation.
 */
export function effectiveSpeciesColumn(table: "biochoco" | "audio"): SQL<string> {
  const prefix = table === "biochoco" ? sql.identifier("biochoco_identifications") : sql.identifier("audio_identifications");
  return sql<string>`(
    CASE WHEN ${prefix}.verification_status = 'corrected'
         THEN ${prefix}.corrected_species
         ELSE ${prefix}.species END
  )`;
}
```

### Slug helpers

`src/lib/species-slug.ts` (new):

```typescript
export function speciesSlug(scientificName: string): string {
  return scientificName
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Reverse lookup. Returns null if 0 or multiple matches (caller renders 404). */
export async function resolveSpeciesFromSlug(slug: string): Promise<Species | null>;
```

Resolution strategy: query `biochoco_species` and filter in memory comparing `speciesSlug(scientificName) === slug`. If 0 or >1 match, return null → page returns `notFound()`. In practice scientific names are unique in the table (unique index on `scientificName`), so collisions are extremely unlikely; still, the check is defensive.

### Permissions

Both modules share `getUserCameraTrapProjects(user)` (general-purpose despite the name; underlying column is `deployments.cameraTrapProjectId`). Pattern in every query:

```typescript
const user = await requirePermission(moduleProject, "viewer");
const projects = await getUserCameraTrapProjects(user);
// Then in queries: .where(and(..., ctProjectFilter(projects)))
```

If `projects.length === 0` (user has access to no projects), `ctProjectFilter` returns `IN (-1)` which yields empty results — index and detail pages render an empty state in Spanish.

### Shared components (`src/components/species/`)

| File | Purpose |
|---|---|
| `species-index-table.tsx` | Sortable/searchable client table of species + counts |
| `species-header.tsx` | Title (scientific/common/spanish via `useSpeciesDisplay`), total count, project chips |
| `species-filter-bar.tsx` | Verification multi-select, project select, confidence slider (prop-gated for audio) |
| `deployment-map.tsx` | Server wrapper that dynamic-imports `deployment-map-inner.tsx` (ssr: false) |
| `deployment-map-inner.tsx` | Client component using `react-leaflet`; markers sized by count |
| `site-list.tsx` | Server component rendering site cards; the expanded site renders its expansion `children` |
| `site-card.tsx` | Single site card with count, last-seen date, expand link |
| `no-location-list.tsx` | Below-map list of sites with NULL lat/lng (gap #5) |
| `audio-detection-card.tsx` | Audio detection card with `<audio>` Media-Fragment player + "Abrir en contexto" |
| `audio-detection-card-fallback.ts` | JS-driven currentTime fallback for browsers where `#t=` is unreliable |

### Server actions (or server-component queries)

```typescript
// src/app/camera-trap/species/actions.ts
getCameraTrapSpeciesIndex(filters): Promise<SpeciesIndexRow[]>
getCameraTrapSpeciesDetail(slug, filters): Promise<SpeciesDetail>     // header + sites + map markers
getCameraTrapSpeciesSitePage(slug, deploymentId, page, filters): Promise<{ items: ImageGridItem[], totalPages: number }>

// src/app/audio/species/actions.ts
getAudioSpeciesIndex(filters): Promise<SpeciesIndexRow[]>
getAudioSpeciesDetail(slug, filters): Promise<SpeciesDetail>
getAudioSpeciesSitePage(slug, deploymentId, page, filters): Promise<{ items: AudioDetectionCardData[], totalPages: number }>
```

All actions:
1. `requirePermission(moduleProject, "viewer")` first
2. `getUserCameraTrapProjects(user)` → filter
3. Use `effectiveSpeciesMatches()` and (audio only) `applyConfidenceFilter()` in WHERE

### Conceptual SQL

**Species index (audio):**
```sql
SELECT
  CASE WHEN i.verification_status = 'corrected'
       THEN i.corrected_species ELSE i.species END AS effective_species,
  COUNT(*) AS detection_count,
  MAX(f.recording_start) AS last_seen,
  COUNT(DISTINCT f.deployment_id) AS site_count
FROM audio_identifications i
JOIN audio_detections d ON d.id = i.audio_detection_id
JOIN audio_files f      ON f.id = d.audio_file_id
JOIN biochoco_deployments dep ON dep.id = f.deployment_id
WHERE i.verification_status != 'rejected'
  AND <applyConfidenceFilter(threshold)>
  AND <ctProjectFilter(projects)>
GROUP BY effective_species
ORDER BY detection_count DESC;
```

**Per-deployment counts for a species (audio):**
```sql
SELECT f.deployment_id, dep.name, dep.latitude, dep.longitude,
       COUNT(*) AS detection_count, MAX(f.recording_start) AS last_seen
FROM audio_identifications i
JOIN audio_detections d ON d.id = i.audio_detection_id
JOIN audio_files f      ON f.id = d.audio_file_id
JOIN biochoco_deployments dep ON dep.id = f.deployment_id
WHERE <effectiveSpeciesMatches(scientificName)>
  AND <applyConfidenceFilter(threshold)>
  AND <ctProjectFilter(projects)>
GROUP BY f.deployment_id
ORDER BY detection_count DESC;
```

**Per-site detections page (audio):** Same WHERE plus `f.deployment_id = ?`, JOIN to get `f.id, f.recording_start, d.start_time, d.end_time, d.min_freq, d.max_freq, i.confidence, i.verification_status`, `LIMIT 24 OFFSET (page-1)*24`.

Camera-trap variants are structurally identical with `biochoco_*` tables and no confidence filter.

### Architecture — Research Insights

**Replacement helper API (supersedes `effectiveSpeciesColumn`):**

The original CASE-WHEN aggregation forces a full scan on SQLite (CASE results aren't index keys). Use two index-eligible queries unioned in JS:

```typescript
// src/db/effective-species.ts — colocated with schema, not in src/lib/
import { sql, eq, and } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";

/**
 * Match condition: this identification row contributes to the given effective species.
 * Generates index-eligible predicates on (species) or (corrected_species) per branch.
 * Pass the Drizzle table object (audioIdentifications or identifications) for type safety.
 */
export function effectiveSpeciesMatches<T extends SQLiteTable>(
  table: T,
  scientificName: string
) {
  // Returns Drizzle `and(...)` — use directly in .where()
  return sql`(
    (${table}.verification_status IN ('unverified','verified') AND ${table}.species = ${scientificName})
    OR
    (${table}.verification_status = 'corrected' AND ${table}.corrected_species = ${scientificName})
  )`;
}

/**
 * Aggregate per-effective-species counts for the species index page.
 * Runs TWO queries and merges in JS — each branch hits a real index.
 */
export async function aggregateBySpecies(
  table: "biochoco_identifications" | "audio_identifications",
  whereExtras: SQL[] // ctProjectFilter, applyConfidenceFilter, deployment join filter, etc.
): Promise<Map<string, { count: number; lastSeen: Date | null; siteIds: Set<number> }>> {
  // Query A: active identifications (verified + unverified, non-corrected)
  // GROUP BY species
  // Query B: corrected identifications
  // GROUP BY corrected_species
  // Merge into Map<scientificName, aggregate>
  // Returns merged Map; caller joins biochoco_species once for display names.
}
```

The helper accepts Drizzle table objects (not string literals), so renaming a table at the schema is caught by TypeScript.

**Required indexes (added in Phase 1):**

```sql
-- biochoco_identifications
CREATE INDEX IF NOT EXISTS idx_bio_id_species_active
  ON biochoco_identifications(species, detection_id)
  WHERE verification_status IN ('unverified','verified');

CREATE INDEX IF NOT EXISTS idx_bio_id_corrected
  ON biochoco_identifications(corrected_species, detection_id)
  WHERE verification_status = 'corrected';

-- audio_identifications (mirror)
CREATE INDEX IF NOT EXISTS idx_audio_id_species_active
  ON audio_identifications(species, audio_detection_id)
  WHERE verification_status IN ('unverified','verified');

CREATE INDEX IF NOT EXISTS idx_audio_id_corrected
  ON audio_identifications(corrected_species, audio_detection_id)
  WHERE verification_status = 'corrected';
```

Partial indexes keep `WHERE verification_status != 'rejected'` implicit and stay compact. Validate with `EXPLAIN QUERY PLAN` showing `USING INDEX idx_*` (not `SCAN`).

**URL param parsers (`src/lib/species-search-params.ts`):**

```typescript
const STATUSES = ["unverified", "verified", "corrected", "rejected"] as const;
type Status = (typeof STATUSES)[number];

export function parseStatus(raw: string | undefined): Status[] {
  if (!raw) return ["unverified", "verified", "corrected"]; // default: all except rejected
  const values = raw.split(",").filter((v): v is Status => STATUSES.includes(v as Status));
  return values.length > 0 ? values : ["unverified", "verified", "corrected"];
}

export function parseProjectId(
  raw: string | undefined,
  userProjects: number[] | "all"
): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) return null;
  if (userProjects !== "all" && !userProjects.includes(n)) return null;
  return n;
}

export function parsePositiveInt(raw: string | undefined, fallback = 1, max = 1_000_000): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}

export function clampSeekSeconds(raw: string | undefined, maxDuration: number): number {
  const n = Number.parseFloat(raw ?? "");
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(n, maxDuration);
}
```

Every action calls these before any Drizzle query.

**Per-action `ctProjectFilter` invariant:**

```typescript
// Every public action — index, detail, site-page — must include this line:
const projects = await getUserCameraTrapProjects(user);
// And every WHERE must include ctProjectFilter(projects).
// Acceptance test: grep -L "ctProjectFilter" src/app/{camera-trap,audio}/species/actions.ts must return empty.
```

**`projectIds` aggregation source:**

`SpeciesIndexRow.projectIds` is computed via `GROUP_CONCAT(DISTINCT dep.camera_trap_project_id)` over the SAME filtered JOIN that produces counts — never a separate species → project lookup. This prevents leaking the existence of a species in projects the viewer cannot see.

## Implementation Phases

### Phase 1 — Foundation (shared helpers + sidebar + CRUD route move)

**Deliverables:**

1. **`src/lib/species-slug.ts`** — `speciesSlug()`, `resolveSpeciesFromSlug()`.
2. **`src/lib/effective-species.ts`** — `effectiveSpeciesMatches()`, `effectiveSpeciesColumn()`.
3. **Vitest unit tests** for both helpers, including:
   - Slug for "Ramphastos ambiguus" → "ramphastos-ambiguus"
   - Slug strips diacritics ("Cebus aequatorialis" → "cebus-aequatorialis")
   - `effectiveSpeciesMatches('biochoco', 'Crax rubra')` SQL fragment passes when `verificationStatus='corrected' AND correctedSpecies='Crax rubra'`, fails when `verificationStatus='rejected'`.
4. **Move CRUD route**: `src/app/camera-trap/species/page.tsx` + `species-client.tsx` → `src/app/camera-trap/species/manage/page.tsx` + `manage-client.tsx`.
   - Add a thin redirect from the old path is NOT done — instead we replace the old route with the new index in Phase 2. (Bookmarks to `/camera-trap/species` will land on the new index, which has a "Administrar especies" link; acceptable.)
5. **Audit internal links** (gap #3): grep for `'/camera-trap/species'` across the repo. Update any sidebar/breadcrumb/test/docs reference that meant the CRUD page to use `/manage`. Confirm `next/link` resolves cleanly.
6. **Add DB index if missing**: Check whether `biochoco_identifications.species` and `audio_identifications.species` columns are indexed. If not, add covering indexes for the GROUP BY pattern via `scripts/push-schema.mjs`. (Verify with `EXPLAIN QUERY PLAN`.)
7. **Sidebar nav** (`src/components/sidebar-nav.tsx:148–178`):
   - Camera-trap children gain (viewer+): `{ label: "Explorar por especie", href: "/camera-trap/species", icon: "binoculars" }` and (editor+): `{ label: "Administrar especies", href: "/camera-trap/species/manage", icon: "pencil" }` (replaces existing "Especies" link).
   - Audio children gain (viewer+): `{ label: "Explorar por especie", href: "/audio/species", icon: "binoculars" }`.
   - Verify icon name exists in `IconName` union; add to icon registry if not.

**Files touched (revised post-deepen):**
- `src/lib/species-slug.ts` (new)
- `src/db/effective-species.ts` (new — colocated with schema, NOT in `src/lib/`)
- `src/lib/species-search-params.ts` (new — URL param whitelist parsers)
- `src/lib/__tests__/species-slug.test.ts` (new)
- `src/lib/__tests__/species-search-params.test.ts` (new)
- `src/db/__tests__/effective-species.test.ts` (new — SQL snapshot + EXPLAIN check)
- `src/app/camera-trap/species/manage/page.tsx` (moved)
- `src/app/camera-trap/species/manage/manage-client.tsx` (moved + renamed)
- `src/app/camera-trap/species/page.tsx` (new — temporary redirect to `/manage` until Phase 2 lands)
- `src/components/sidebar-nav.tsx` (edit)
- `src/components/icon.tsx` (edit if `binoculars` not present)
- `scripts/push-schema.mjs` (edit — add partial indexes; idempotent `CREATE INDEX IF NOT EXISTS`)

**Success criteria (revised):**
- Old CRUD page is at `/camera-trap/species/manage`, all existing CRUD actions work.
- Bare `/camera-trap/species` redirects to `/manage` (temporary; removed in Phase 2).
- `npm run test:run` passes new unit tests including SQL snapshot of `effectiveSpeciesMatches`.
- `EXPLAIN QUERY PLAN` against the species index aggregation shows `USING INDEX idx_*` for both UNION branches (no `SCAN` or `USE TEMP B-TREE FOR GROUP BY`).
- `npm run lint` passes.
- Sidebar shows "Explorar por especie" links (they 404 until Phase 2/3).

### Phase 1 — Research Insights

- Indexes are added in Phase 1 (not Phase 4) because adding them later on a populated table is a multi-minute migration. `CREATE INDEX IF NOT EXISTS` is idempotent and safe for `push-schema.mjs`.
- The temporary `/camera-trap/species` → `/manage` redirect closes the gap between Phase 1 deploy and Phase 2 deploy. When Phase 2 lands, replace the redirect page with the real index page in the same PR.
- `src/db/effective-species.ts` lives next to schema deliberately. When `verificationStatus` enum changes, the helper must change in lockstep — colocation makes the coupling visible.

### Phase 2 — Camera trap species index + detail

**Deliverables:**

1. **Server actions** (`src/app/camera-trap/species/actions.ts`):
   - `getCameraTrapSpeciesIndex(searchParams)` → returns array of `{ scientificName, commonName, spanishName, detectionCount, siteCount, lastSeen, projectIds }`.
   - `getCameraTrapSpeciesDetail(slug, searchParams)` → returns `{ species, totalCount, sites: SiteSummary[], sitesWithoutLocation: SiteSummary[], availableProjects }`.
   - `getCameraTrapSpeciesSitePage(slug, deploymentId, page, searchParams)` → returns `{ items: ImageGridItem[], totalPages, currentPage }`.
   - All actions wrap in `ActionResult<T>` and call `requirePermission("camera-trap", "viewer")`.

2. **Index page** `src/app/camera-trap/species/page.tsx`:
   - Server component. Reads `?search=&sort=count|name&order=desc|asc` from `searchParams`.
   - Renders `<SpeciesIndexTable />` (client component) with the data.
   - Empty state: "No hay especies con detecciones en los proyectos a los que tienes acceso."

3. **Detail page** `src/app/camera-trap/species/[slug]/page.tsx`:
   - Server component. Reads `?status=&project=&site=&page=` from `searchParams`.
   - Calls `resolveSpeciesFromSlug(slug)`; if null → `notFound()`.
   - Renders `<SpeciesHeader />`, `<SpeciesFilterBar mode="camera-trap" />`, `<DeploymentMap markers={...} />`, `<NoLocationList />`, `<SiteList sites={...} expandedSiteId={site} expansionContent={...} />`.
   - If `site` is set, fetches page data and renders `<ImageGrid items={...} highlightSpecies={species.scientificName} />` inside the expansion slot. Includes pagination footer.
   - Empty state on detail header: "No hay detecciones que coincidan con los filtros."

4. **Shared components in `src/components/species/`** — all listed under Architecture. Each:
   - Server components where possible (header, site-list, no-location-list).
   - Client components only where needed (filter-bar with form state, map inner, index-table with sort/search, audio-detection-card).

5. **`ImageGrid` `highlightSpecies` prop** (gap #20):
   - Edit `src/components/image-grid.tsx`: add optional `highlightSpecies?: string` prop.
   - When set, render bounding boxes of detections whose effective species matches `highlightSpecies` with normal opacity; dim others to `opacity-30`.
   - Verify on existing usage sites that the prop is optional (no behavior change when omitted).

**Files touched (revised post-deepen — simpler component layout):**
- `src/app/camera-trap/species/actions.ts` (new — uses `aggregateBySpecies`, `parseStatus`, `parseProjectId`, `parsePositiveInt`)
- `src/app/camera-trap/species/page.tsx` (new — replaces the Phase 1 redirect)
- `src/app/camera-trap/species/[slug]/page.tsx` (new — inlines `dynamic(() => import("…/deployment-map-inner"), { ssr: false })` and the "Sin ubicación" `<details>` block)
- `src/app/camera-trap/species/[slug]/loading.tsx` (new, skeleton)
- `src/components/species/species-index-table.tsx` (new — client; client-side filter, debounced URL sync via `router.replace`)
- `src/components/species/species-header.tsx` (new — server)
- `src/components/species/species-filter-bar.tsx` (new — client; `mode: "camera-trap" | "audio"` gates the confidence slider)
- `src/components/species/deployment-map-inner.tsx` (new — client; react-leaflet with `react-leaflet-cluster` at threshold 30)
- `src/components/species/site-list.tsx` (new — server; renders site cards inline, NO separate `site-card.tsx`)
- `package.json` (edit — add `react-leaflet-cluster` dep)

**Dropped from Phase 2 (per simplicity review):**
- `deployment-map.tsx` wrapper (inline the dynamic import where needed)
- `site-card.tsx` (merged into `site-list.tsx`)
- `no-location-list.tsx` (inline `<details>` block)
- `ImageGrid.highlightSpecies` prop edit (deferred to v2; existing badges already identify species per detection)

**Edge cases handled (from SpecFlow):**

- Gap #1 (slug collision): `resolveSpeciesFromSlug` returns null on 0 or >1 match → `notFound()`.
- Gap #2 (correctedSpecies aggregation): all queries use `effectiveSpeciesColumn` / `effectiveSpeciesMatches`.
- Gap #5 (NULL lat/lng): `SiteSummary[]` is split into `sites` (with coords) for the map + list and `sitesWithoutLocation` (no coords) for an explicit collapsible "Sin ubicación" list rendered below the map. Counts include both.
- Gap #6 (filter hides expanded site): in `[slug]/page.tsx`, after applying filters, check whether `site` is still in the result set. If not, render the site-list normally with an empty-state banner: "El sitio seleccionado no tiene detecciones con los filtros actuales. [Limpiar selección]".
- Gap #7 (empty states): each level has an explicit Spanish empty state.
- Gap #10 (pagination reset): the filter bar emits links that omit `site` and `page` params; the site card link sets `?site=X&page=1`.
- Gap #11 (deep-linking): every searchParam combination is server-rendered. Invalid `site` ID = treated like #6. Invalid `page` clamped to `[1, totalPages]`.
- Gap #15 (all-rejected detection): excluded via `effectiveSpeciesMatches` which already filters `status != 'rejected'`. Such detections do not appear in the species view (correct).
- Gap #18 (search): the `species-index-table` does client-side filtering on the loaded list (fine for typical species count ≤ 500). Accent-insensitive via `normalize("NFD")` + diacritic strip on both query and target. Matches scientific, common, AND Spanish names.
- Gap #21 (sort stability): tie-break on `scientificName ASC`.
- Gap #22 (large site count): for v1 a species with >100 sites renders all cards (collapsed → cheap). If we observe rendering issues, add virtualization in v2.

### Phase 2 — Research Insights

**Map clustering threshold (30 markers).** Add `react-leaflet-cluster` (or `leaflet.markercluster` directly). Below 30 markers, render plain `CircleMarker`s — clusters add no value and obscure spatial pattern. Above 30, switch to clustered rendering with `disableClusteringAtZoom={14}` so users can still zoom in to individual sites.

**Hybrid client/server for the index table.** Server accepts `?search=&sort=&order=` and renders an SSR-friendly initial table. The client wraps the input in `useState` + a debounced `useEffect` that calls `router.replace("?search=…", { scroll: false })`. Use `replace`, not `push`, so the back button doesn't snapshot every keystroke. Debounce at 250 ms. Filtering itself can be instant in the client component over the pre-loaded list.

**Suspense boundary for the expanded site.** Wrap the per-site expansion in a server `<Suspense>` so changing `?site=` only refetches that subtree, not the whole page (counts, map markers). The expansion server component takes `slug`, `siteId`, `page`, `filters` as props and is the only thing that re-renders when the user opens another site.

**Image grid lazy loading.** Confirm `<img loading="lazy">` is set in `ImageGrid` already (it is — line ~150 of `image-grid.tsx`). Confirm the photo proxy emits `Cache-Control: public, max-age=...` (it does, per audio stream pattern).

**Acceptance test for the security invariant:** `grep -L "ctProjectFilter" src/app/camera-trap/species/actions.ts` returns empty. Same for audio in Phase 3. This is a literal CI-runnable assertion.

**Success criteria:**
- Click "Explorar por especie" → lands on index → table sorted by count desc with search box.
- Search for "tucán" filters to species matching common name (accent-insensitive).
- Click a species → detail page loads with map, sites sorted by count, no expansion.
- Click map marker → page scrolls to that site card (via `<a href="#site-N">`).
- Click site card → URL gets `?site=N&page=1`, page re-renders with ImageGrid below the card.
- Click "Verificadas" filter → URL gets `?status=verified`, counts + map markers update; if expanded site has no verified detections, expansion shows empty state with "Limpiar selección".
- URL with invalid slug renders 404.
- URL with `site` for a deployment the user can't access renders the site-list empty state (the deployment is filtered out by `ctProjectFilter`).
- Lighthouse / DevTools: detail page loads in < 1.5 s with realistic data (verify on staging).

### Phase 3 — Audio species index + detail

**Deliverables:**

1. **Server actions** (`src/app/audio/species/actions.ts`):
   - Mirrors Phase 2 but uses audio tables and applies `applyConfidenceFilter(parseThresholdParam(searchParams.conf))`.
   - `getAudioSpeciesSitePage` returns `AudioDetectionCardData[]` shape (id, fileId, deploymentId, recordingStart, startTime, endTime, minFreq, maxFreq, confidence, verificationStatus, verifiedBy, verifiedAt).

2. **Routes**:
   - `src/app/audio/species/page.tsx` (index)
   - `src/app/audio/species/[slug]/page.tsx` (detail)
   - `src/app/audio/species/[slug]/loading.tsx`

3. **`<AudioDetectionCard>` component** (`src/components/species/audio-detection-card.tsx`):
   - Renders metadata, mini-player, "Abrir en contexto" link.
   - Player: `<audio src="/api/audio/stream?fileId={fileId}#t={start},{end}" preload="none" controls>` with ±3 s padding clamped to `[0, fileDuration]`.
   - Onplay handler: sets `currentTime = paddedStart` and adds a `timeupdate` listener that pauses at `paddedEnd` (handles browsers where Media Fragments don't constrain playback end). This is the JS fallback (gap #13).
   - "Abrir en contexto" → `/audio/{deploymentId}/annotate/{fileId}?t={detectionStart}` (gap #19 — explicit: `deploymentId` is the deployment, `fileId` is the audio file).

4. **Annotation page `t` param** (small additive change):
   - `src/app/audio/[id]/annotate/[fileId]/page.tsx`: read optional `?t=<seconds>` and pass it as initial seek position to the annotation client. If the annotation client already supports an initial seek, just wire the param; otherwise add a one-line effect that calls the existing seek function on mount.

5. **Filter bar threshold slider**:
   - Reuse the existing `ConfidenceThresholdSlider` if one exists (per the confidence-threshold plan); otherwise wire `parseThresholdParam` → `formatThreshold` and write the slider as part of `<SpeciesFilterBar mode="audio" />`. The slider updates `?conf=...` and respects `DEFAULT_CONFIDENCE_THRESHOLD = 0.7`.
   - Slider is only rendered when `mode === "audio"` (gap #8: default comes from `audio-confidence.ts`, identical for index and detail pages, so counts agree).

**Files touched (revised post-deepen):**
- `src/app/audio/species/actions.ts` (new — must independently call `getUserCameraTrapProjects` + `ctProjectFilter` in every action; uses `applyConfidenceFilter` + `parseThresholdParam`)
- `src/app/audio/species/page.tsx` (new)
- `src/app/audio/species/[slug]/page.tsx` (new — inlines `dynamic(...)` for map and `<details>` for "Sin ubicación")
- `src/app/audio/species/[slug]/loading.tsx` (new)
- `src/app/audio/species/_components/audio-detection-card.tsx` (new — colocated with route, NOT in `src/components/species/`; uses HTML5 `<audio>` with Media Fragment URI + inline 5-line `timeupdate` fallback)
- `src/app/audio/[id]/annotate/[fileId]/page.tsx` (edit — accept `?seek=` and clamp via `clampSeekSeconds`)
- `src/app/audio/[id]/annotate/[fileId]/annotation-client.tsx` (edit — initial seek after `loadedmetadata`)
- `src/app/api/audio/stream/__tests__/route.test.ts` (new — integration test asserting `206 Partial Content` for ranged requests)

**Dropped from Phase 3 (per simplicity review):**
- `audio-detection-card-fallback.ts` (inlined 5-line `timeupdate` handler in the card component)

**Edge cases handled:**

- Gap #4 (audio permissions): uses the same `getUserCameraTrapProjects` helper (verified general-purpose). Permission gate is `requirePermission("grabaciones", "viewer")`.
- Gap #8 (confidence slider default): index and detail both call `parseThresholdParam(searchParams.conf)`; same default → counts match.
- Gap #13 (Media Fragment fallback): JS-driven `currentTime` + `timeupdate` pause handler.
- Gap #19 (annotation link target): explicitly documented as `/audio/{deploymentId}/annotate/{fileId}?t={start}`.

**Success criteria:**
- "Explorar por especie" in audio nav → index → Choco Toucan visible with count.
- Click → detail → map shows audio deployments with toucan detections.
- Click site → cards appear with metadata + play button.
- Click play → audio loads, plays only the detection window (verified in Chrome + Safari + Firefox).
- Click "Abrir en contexto" → lands on annotation page, scrubber at the detection start time.
- Slide confidence threshold → counts update across header, map, site list.

### Phase 3 — Research Insights

**HTTP Range support is the load-bearing assumption.** Without it, `<audio src="…#t=10,15">` downloads the full 30+ MB FLAC before honoring the fragment. The existing `/api/audio/stream/route.ts` already supports `Range` (verified via the audio annotation flow), but the new integration test asserts `206 Partial Content` for a ranged GET so a future refactor can't silently regress it.

**Media Fragment URI cross-browser support.** Chrome ≥ 60, Firefox ≥ 41, Safari ≥ 11 all parse `#t=start,end` on `<audio>` and constrain initial playback. Some Safari versions don't constrain the END (continues past `end`). The inline `timeupdate` listener (5 lines) handles this: `audio.addEventListener("timeupdate", () => { if (audio.currentTime >= end) audio.pause(); }, { once: false })`. Add `audio.removeEventListener` on unmount.

**FLAC playback.** All evergreen browsers support FLAC in `<audio>` (Chrome ≥ 56, Firefox ≥ 51, Safari ≥ 11). WAV is universal. No format-detection branching needed.

**`?seek=` naming.** Use `seek` instead of `t` to avoid mental collision with Media Fragment `#t=`. Client + server agree on the name.

**Hydration ordering for initial seek.** Setting `audio.currentTime` from the URL param must happen after the `loadedmetadata` event fires, not on mount. If the annotation client already has a seek-on-mount path, it should `await` metadata or use an `onLoadedMetadata` handler:

```tsx
<audio
  ref={audioRef}
  onLoadedMetadata={(e) => {
    if (initialSeek > 0) e.currentTarget.currentTime = initialSeek;
  }}
/>
```

If sessionStorage already restores a scrub position, URL `?seek=` wins on first navigation only (clear the storage key after applying once).

### Phase 4 — Light verification (folded from prior Phase 4)

Most of the original Phase 4 work folds into Phases 2 & 3 (unit tests, EXPLAIN QUERY PLAN, integration tests live with the code that needs them). Phase 4 keeps only the cross-cutting work.

**Deliverables:**

1. **E2E test** (Playwright) — `e2e/species-browser.spec.ts`: log in, navigate to `/camera-trap/species`, search, open species, expand a site, verify ImageGrid renders, change filter, verify counts update. Repeat for `/audio/species` including audio playback assertion (play button → `<audio>` element has `currentTime > 0` within 1s).
2. **CLAUDE.md update**:
   - Note the new species browser routes under "Architecture."
   - Note `src/db/effective-species.ts` as the canonical way to aggregate by effective species.
   - Document that `cameraTrapProjectAccess` is the **canonical deployment-access table** used by both camera-trap and audio modules — a future audio-permissions split must update both helpers in lockstep.
3. **Performance smoke test on staging** — manually open the species detail page for the highest-count species (e.g., the most-detected audio species) and confirm `< 500 ms` server time via DevTools network panel. EXPLAIN-level validation already happened in Phase 1.

**Files touched:**
- `e2e/species-browser.spec.ts` (new)
- `CLAUDE.md` (edit)

## Acceptance Criteria

### Functional requirements

- [ ] Sidebar shows "Explorar por especie" under both Cámaras trampa and Grabaciones modules (viewer+).
- [ ] Sidebar shows "Administrar especies" under Cámaras trampa (editor+) pointing to the moved CRUD page.
- [ ] `/camera-trap/species` and `/audio/species` render a sortable, searchable species index with detection counts.
- [ ] Search is accent-insensitive and matches scientific, common, and Spanish names.
- [ ] `/camera-trap/species/[slug]` and `/audio/species/[slug]` render header, filter bar, map, site list.
- [ ] Map markers are sized proportionally to detection count and clicking a marker scrolls to its site card.
- [ ] Sites without lat/lng appear in a "Sin ubicación" list below the map.
- [ ] Clicking a site card sets `?site=<id>&page=1`; that site's detections render inline.
- [ ] Pagination footer on expanded sites uses `?page=N`.
- [ ] Verification status filter (multi-select; default all except rejected) updates counts and map.
- [ ] Project filter narrows to selected project.
- [ ] Audio confidence slider (range 0.10–1.00, step 0.05, default 0.70) updates all audio counts.
- [ ] Filter changes reset `?page=1` and validate that the expanded `site` still has results; otherwise show "Limpiar selección" empty state.
- [ ] Camera-trap expansion uses `ImageGrid` with `highlightSpecies` dimming non-matching bboxes.
- [ ] Audio expansion uses `<AudioDetectionCard>` with `<audio>` Media-Fragment playback (±3 s padding) and JS fallback for browsers that don't constrain.
- [ ] "Abrir en contexto" link on audio cards navigates to `/audio/{deploymentId}/annotate/{fileId}?t={start}` with scrubber at the detection start.
- [ ] Invalid species slug renders 404.
- [ ] User with access to 0 projects sees a Spanish empty state on both index and detail pages.
- [ ] All user-visible strings are Spanish.
- [ ] Old `/camera-trap/species` CRUD page works at `/camera-trap/species/manage`.

### Non-functional requirements

- [ ] Index page loads < 1.5 s for ≤ 500 species with realistic counts.
- [ ] Detail page TTFB < 500 ms for a species with up to 10 000 detections (verified on staging).
- [ ] No N+1 query patterns; aggregation queries use indexes.
- [ ] Map renders smoothly with 50+ markers.
- [ ] Audio playback starts within 300 ms of click for a 7 s clip on broadband.
- [ ] `npm run build`, `npm run lint`, `npm run test:run`, `npm run test:e2e` all pass.

### Quality gates

- [ ] Code review approval.
- [ ] Manual QA across both modules.
- [ ] Test coverage for slug helpers, effective-species helper, index action, detail action.
- [ ] Performance verified with EXPLAIN QUERY PLAN.

## Alternatives Considered

1. **Unified `/species/[name]` overview**: Rejected for v1 (brainstorm decision). Two parallel module pages match the existing module split and let each render module-native UI. A future unified page can simply link to both module-specific pages.

2. **Flat ImageGrid across all sites (no drilldown)**: Rejected — doesn't scale to thousands of detections and loses spatial context.

3. **Pre-computed materialized counts table**: Rejected for v1 — adds schema complexity and write-side maintenance. With proper indexes, on-the-fly aggregation is fast enough. Revisit if EXPLAIN shows table scans.

4. **Server-side spectrogram strip endpoint**: Considered for richer audio cards but deferred. For v1, audio cards omit the spectrogram strip; the full spectrogram appears in the existing annotation page after "Abrir en contexto". Adding a server-side `/api/audio/spectrogram-strip` route is a clean v2 extension.

5. **Activity sparkline per site card**: Deferred to v2 (brainstorm). Adds a per-site query bucket-by-week, not needed for the v1 use case.

## Dependencies & Prerequisites

- `src/lib/audio-confidence.ts` must exist with `applyConfidenceFilter`, `parseThresholdParam`, `formatThreshold`, `DEFAULT_CONFIDENCE_THRESHOLD` exports (already implemented per the 2026-05-13 confidence-threshold plan).
- `react-leaflet` + `leaflet` already in deps.
- `useSpeciesDisplay` / `SpeciesDisplayProvider` already in `src/lib/species-display.ts`.
- `requirePermission`, `getUserCameraTrapProjects`, `ctProjectFilter` already in `src/lib/auth.ts` and `src/lib/camera-trap-auth.ts`.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Aggregation query slow on large detection tables | UNION ALL approach + partial indexes added in Phase 1; `EXPLAIN QUERY PLAN` shows `USING INDEX` for both branches |
| Cross-module permission leak via shared `cameraTrapProjectAccess` | Document table as canonical deployment-access in CLAUDE.md; every action independently applies `ctProjectFilter`; CI grep enforces |
| `projectIds` leaks species existence in foreign projects | Aggregated only from the filtered JOIN, never a separate lookup |
| URL params bypass Drizzle param safety | Whitelist parsers in `src/lib/species-search-params.ts` before any Drizzle query |
| Slug collisions for non-ASCII names | Diacritic strip + uniqueness check at resolve time; render 404 if ambiguous |
| `<audio>` Media Fragment URI doesn't constrain `end` on some Safari versions | Inline `timeupdate` listener pauses at `end`; cleanup on unmount |
| Audio annotation `?seek=` race with sessionStorage scrub restore | URL param wins on first navigation; clear storage key after applying |
| Leaflet hydration mismatches | Inline `dynamic(() => import("./inner"), { ssr: false })` pattern from `biochoco/overview` |
| Map performance with many markers | `react-leaflet-cluster` at threshold 30; `disableClusteringAtZoom={14}` |
| `/api/audio/stream` regresses HTTP Range support | New integration test asserts `206 Partial Content` for ranged GET |
| Filter + expanded-site race | Server-side validation: if expanded site has no results under filters, render empty state with explicit "Limpiar selección" link |
| Phase 1 leaves bare `/camera-trap/species` as 404 between deploys | Temporary redirect to `/manage` in Phase 1; removed in Phase 2 |
| Existing CRUD route bookmarks break | Replaced with redirect during Phase 1; index page links to `/manage` prominently in Phase 2 |
| Multi-tab state divergence | Read-only views; not a correctness issue, just stale tabs |
| Search input floods history | `router.replace` (not `push`) + 250 ms debounce |

## Spanish UI Strings (Appendix A)

| English (developer note) | Spanish |
|---|---|
| Explore by species (sidebar) | Explorar por especie |
| Manage species (sidebar, admin) | Administrar especies |
| Species index page title | Especies |
| Detection count column | Detecciones |
| Site count column | Sitios |
| Last detected column | Última detección |
| Search placeholder | Buscar especie... |
| Empty state (index, no species) | No hay especies con detecciones en los proyectos a los que tienes acceso. |
| Detail page header — total | {N} detecciones en {M} sitios |
| Filter: status | Estado de verificación |
| Filter: status options | Todas · Verificadas · Sin verificar · Rechazadas |
| Filter: project | Proyecto |
| Filter: confidence (audio) | Confianza mínima (BirdNET) |
| Map section title | Mapa de detecciones |
| Site list title | Sitios |
| Sites without location | Sin ubicación |
| Expand button | Ver detecciones |
| Collapse button | Ocultar |
| Open in context (audio) | Abrir en contexto |
| Detail empty after filters | No hay detecciones que coincidan con los filtros. |
| Expanded site empty under filters | El sitio seleccionado no tiene detecciones con los filtros actuales. [Limpiar selección] |
| Slug 404 | No se encontró esta especie. |
| Pagination prev/next | Anterior · Siguiente |

## Open Questions (resolved or deferred)

| Question | Resolution |
|---|---|
| Slug format | lowercase + hyphens, diacritic-stripped |
| Default verification filter | All except rejected |
| Pagination size | 24 per page (matches ImageGrid columns) |
| Activity sparklines on site cards | Deferred to v2 |
| Unified `/species/[name]` | Out of scope for v1 |
| Spectrogram strip on audio cards | Deferred to v2 |
| Map marker scroll target | Site card (via anchor link); auto-expands if site has results |
| Search debounce | Client-side filter, no debounce needed; instant on each keystroke |
| Audio threshold default | Inherits from `audio-confidence.ts` (0.70) |
| Multi-tab divergence | Acceptable; no mutation actions on these pages |
| Old `/camera-trap/species` URL | No redirect; replaced by new index page (CRUD moves to `/manage`) |

## References

### Internal references

- Brainstorm: `docs/brainstorms/2026-05-13-species-detection-browser-brainstorm.md`
- Confidence threshold plan: `docs/plans/2026-05-13-feat-birdnet-confidence-threshold-filter-plan.md`
- Existing CRUD page: `src/app/camera-trap/species/page.tsx`, `species-client.tsx`
- ImageGrid component: `src/components/image-grid.tsx:16-50`
- Audio streaming route: `src/app/api/audio/stream/route.ts`
- Species display context: `src/lib/species-display.ts`
- Permission helpers: `src/lib/auth.ts:107-146`, `src/lib/camera-trap-auth.ts:29-74`
- Audio confidence helper: `src/lib/audio-confidence.ts`
- Leaflet pattern: `src/app/biochoco/overview/overview-map-inner.tsx`, `overview-map.tsx`
- Sidebar nav: `src/components/sidebar-nav.tsx:148-178`
- Slug pattern reference: `src/app/public/biochoco/[token]/especies/[slug]/page.tsx:36-52`
- Pagination pattern reference: same file
- Schema (deployments, species, identifications): `src/db/schema.ts:128-206`, `:345-475`, `:755-843`
- Effective species computation pattern: `src/app/camera-trap/actions.ts:3160-3178`

### Institutional learnings applied

- Permission filtering across joins (avoid the camera-trap → grabaciones split mistake) — `docs/solutions/spec-process-explosion-AudioCache-20260226.md`
- `dynamic(() => import(...), { ssr: false })` for react-leaflet (Next.js gotcha)
- `min-w-0` on sidebar inset to prevent map overflow
- Slug encoding via lowercase + hyphens (reuses public gallery pattern)
- ImageGrid scroll-restoration via sessionStorage (existing pattern)
- Drizzle `??null` for nullable columns (gotcha when joining)

### External references

None — all patterns are in-codebase.

## Future Considerations

- **Unified `/species/[name]`** linking to both module pages.
- **Activity sparklines** on site cards (weekly buckets).
- **Server-side spectrogram strip endpoint** for richer audio cards.
- **Bulk play** for audio (auto-advance through a site's detections).
- **Cross-module species correlation** (e.g., "this species was heard at sites A, B, C; seen at sites A, C, D — sites that match: A, C").
- **Calendar heatmap** for species seasonality.
- **Export** species detections to CSV / camtrap-DP package.
- **CMS-style metadata** on the species page (description, photo, range map) — extends `biochoco_species`.
