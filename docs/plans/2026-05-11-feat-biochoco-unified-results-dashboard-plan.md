---
title: BioChoco Unified Results Dashboard
type: feat
date: 2026-05-11
brainstorm: docs/brainstorms/2026-05-11-biochoco-unified-results-dashboard-brainstorm.md
---

# BioChoco Unified Results Dashboard

## Overview

Replace `/biochoco/resultados` with a two-tab dashboard that consolidates camera trap species, audio (BirdNET annotations + acoustic indices), and iButton temperature data. The tabs are **Por sitio** (today's map + table, drill-down extended with audio panels) and **Por hábitat** (new cross-habitat comparison view with four stacked sections). Absorbs `/audio/indices` (deprecated) and surfaces temperature data from `/biochoco/ibutton` here while keeping that page for its upload workflow.

## Problem Statement

Researchers currently have to visit three separate pages to see project results:

- `/biochoco/resultados` — camera trap species and temperature at the per-site level only.
- `/audio/indices` — acoustic indices boxplots grouped by diel period, project-scoped.
- `/biochoco/ibutton` — temperature boxplots by habitat with min/mean/max stats.

Cross-habitat ecological comparison — the primary scientific question — isn't possible without flipping between pages and mentally joining data. The audio module is the wrong home for habitat-scoped biodiversity results; BioChoco is. BirdNET species are also invisible at the BioChoco site level, breaking the multi-sensor narrative.

## Proposed Solution

Refactor `/biochoco/resultados` into a tabbed shell at the same URL:

- **Por sitio** (default, back-compat) — existing map + site table; click-through extends the per-site drill-down with two new audio panels.
- **Por hábitat** (new) — single scrollable comparison page with a sticky filter bar and four stacked sections: acoustic indices, camera trap species, BirdNET species, temperature. Each section uses habitat as the primary axis. Acoustic indices and temperature ignore verification; species/detection metrics use strict verified-only filtering.

Tab state lives in `?view=habitat|sitio` (URL-driven, shareable). Filters in each tab are namespaced (`h_habitats`, `h_diel`) so deep links survive tab switches.

A shared `<BoxPlot>` component absorbs the two near-identical SVG boxplot implementations in `src/app/audio/indices/acoustic-indices-box-plot.tsx` and `src/app/biochoco/ibutton/box-plot-chart.tsx`. `/audio/indices` route and sidebar entry are removed; `/biochoco/ibutton` stays (upload workflow).

## Technical Approach

### Architecture

#### Routing & state

- `/biochoco/resultados/page.tsx` becomes a Server Component that reads `?view` from `searchParams` and renders either `<SitioView>` (existing content, extracted) or `<HabitatView>` (new). Tab triggers use `<Link>` so prefetch + back/forward work without local state.
- Default view = `sitio` (no `?view` param). Only `?view=habitat` is written to the URL when the user clicks Por hábitat. This preserves bookmarks.
- Habitat-tab filters are URL-bound: `?view=habitat&h_habitats=bosque_primario,bosque_secundario&h_diel=dawn`. Sitio-tab filter state (search, habitat) stays local for now (not a deep-link requirement).

#### Data fetching

- **Sitio tab**: reuses `fetchResultadosData()` unchanged. Site detail page reuses `fetchSiteDetail()` plus two new fields (audio indices + audio species).
- **Habitat tab**: new server action `fetchHabitatDashboardData()` returns everything for the tab in one shot — composes the existing primitives (`getAcousticIndicesForProject`, `fetchTemperatureDistributions`) and adds two new aggregators (`fetchCameraSpeciesByHabitat`, `fetchAudioSpeciesByHabitat`). Uses `React.cache()` around `loadSiteHabitatMap()` so ODK is fetched once per request even though multiple aggregators need it.
- **Site drill-down audio**: extend `fetchSiteDetail()` with two new fields: `audioIndices: AcousticIndicesGroup[]` (filtered to this site's deployments) and `audioSpecies: SiteSpecies[]` (verified BirdNET annotations). No new top-level server action — keeps the `[siteId]` page atomic.

#### Habitat lookup unification

Extract `loadSiteHabitatMap()` and the `siteName → habitat` fallback chain into a single helper at `src/lib/habitat-lookup.ts`. Wrap with `React.cache()` so the four aggregators in the habitat tab share one ODK fetch. Today two near-identical copies exist in `audio/actions.ts:1495` and `biochoco/ibutton/actions.ts:36`.

#### Shared boxplot

Extract `src/components/box-plot.tsx` from the two existing SVG implementations. API:

```tsx
<BoxPlot
  groups={[{ label: "Bosque primario", color: "#…", points: [{ id, value, deploymentName }] }]}
  valueLabel="ACI"
  expectedDirection="up" // "up" | "down" | "neutral"
  lowCoverageThreshold={4}
  height={240}
/>
```

The page composes one BoxPlot per metric (5 indices, 3 temp stats, etc.). Migrate the two existing call sites to use it. `boxPlotStats()` from `src/lib/stats.ts` stays as-is.

#### Verification rules

| Section | Filter | Source |
|---|---|---|
| Acoustic indices | none (raw data) | `getAcousticIndicesForProject` (reuse) |
| Camera species | `verificationStatus IN ('verified', 'corrected')` | new aggregator |
| Audio species (BirdNET) | `verificationStatus IN ('verified', 'corrected')` — matches camera for consistency | new aggregator |
| Temperature | none (raw data) | `fetchTemperatureDistributions` (reuse) |

The audio status filter is **new** — the current `audioIdentifications` queries don't filter at all. Camera trap uses `IN ('verified', 'corrected')` because "corrected" means human-confirmed with species changed — semantically still verified. Same logic applies to audio. (See open question Q1 if you'd prefer strict equality.)

Camera trap deployments with `status='verified_empty'` contribute zero species but count toward the verified-deployment denominator (so the "N de M verificadas" badge stays honest).

#### Sample-size threshold

Extend the existing `n<4` fading rule (`acoustic-indices-box-plot.tsx:23`) to camera and audio species sections. Show the threshold caption once at the top of the habitat tab, not per section.

### Implementation Phases

#### Phase 1 — Foundation

Lay the groundwork before any user-visible change. Each item below is mechanical and independently reviewable.

**Files:**

- `src/components/box-plot.tsx` *(new)* — extracted from the two existing SVG boxplot files. Generic props, no acoustic/temperature-specific logic. Includes jitter, whiskers, low-coverage fading, hover tooltip, axis ticks.
- `src/lib/habitat-lookup.ts` *(new)* — exports `loadSiteHabitatMap()` (cached via `React.cache`) and `resolveHabitatForDeployment({ siteName, deploymentName }, map)`. Replaces inline implementations in `audio/actions.ts:1495` and `biochoco/ibutton/actions.ts:36`.
- `src/app/audio/indices/acoustic-indices-box-plot.tsx` — migrate to use `<BoxPlot>`. Keep the page wrapper temporarily; it gets deleted in Phase 4.
- `src/app/biochoco/ibutton/box-plot-chart.tsx` — migrate to use `<BoxPlot>`.

**Tasks:**

- [x] Create `src/components/box-plot.tsx` with API above. *(Snapshot test deferred — manual visual check on iButton page.)*
- [x] Create `src/lib/habitat-lookup.ts`. Both existing call sites must produce byte-identical maps when switched over.
- [x] Migrate `biochoco/ibutton` boxplot to `<BoxPlot>`. *(audio/indices left in place — Phase 4 deletes it.)*
- [x] No behavioral change yet. Ship Phase 1 as a separate commit.

#### Phase 2 — Por hábitat view

The new tab + four sections. Single, scrollable Server Component with `<Suspense>` per section so slow ODK fetches don't block faster DB-only sections.

**Files:**

- `src/app/biochoco/resultados/page.tsx` *(modify)* — read `searchParams.view`; render `<SitioView>` or `<HabitatView>`.
- `src/app/biochoco/resultados/resultados-shell.tsx` *(modify)* — becomes a tab-aware wrapper that mounts either child. Extract today's filter+map+table content into a new `sitio-view.tsx`.
- `src/app/biochoco/resultados/sitio-view.tsx` *(new, extracted)* — content from today's `ResultadosShell` minus the page title.
- `src/app/biochoco/resultados/habitat-view.tsx` *(new)* — top-level layout for the new tab.
- `src/app/biochoco/resultados/habitat/filter-bar.tsx` *(new)* — sticky filter bar: habitat multi-select, diel selector (indices-only). Reads/writes `?h_habitats`, `?h_diel`.
- `src/app/biochoco/resultados/habitat/acoustic-indices-section.tsx` *(new)* — 5 boxplots, one per index. Reuses `INDEX_DESCRIPTORS` from `src/lib/acoustic-indices.ts` and `getAcousticIndicesForProject(BIOCHOCO_PROJECT_ID)`. Habitat on x-axis, filtered by diel.
- `src/app/biochoco/resultados/habitat/camera-species-section.tsx` *(new)* — per-habitat richness bar chart + total detections, "N de M verificadas" badge, top-5 species list per habitat (collapsible).
- `src/app/biochoco/resultados/habitat/audio-species-section.tsx` *(new)* — parallel to camera section using BirdNET data.
- `src/app/biochoco/resultados/habitat/temperature-section.tsx` *(new)* — 3 boxplots (min/mean/max) using `<BoxPlot>` and `fetchTemperatureDistributions()`.
- `src/app/biochoco/resultados/actions.ts` *(extend)* — add `fetchCameraSpeciesByHabitat()`, `fetchAudioSpeciesByHabitat()`, `fetchHabitatDashboardData()` (composer).

**Query shapes (pseudo):**

```ts
// src/app/biochoco/resultados/actions.ts
export async function fetchCameraSpeciesByHabitat(): Promise<ActionResult<HabitatSpeciesRollup[]>> {
  await requirePermission("biochoco", "viewer");
  const habitatMap = await loadSiteHabitatMap();
  // 1. Fetch all BioChoco deployments where status IN ('verified', 'verified_empty')
  // 2. Group by resolveHabitatForDeployment(...) → habitat
  // 3. For each habitat: count distinct verified species via identifications, sum detections
  // 4. Track per-habitat verified count for the badge
  // Returns: [{ habitat, deploymentCount, verifiedDeploymentCount, speciesCount, detectionCount, topSpecies[] }]
}

export async function fetchAudioSpeciesByHabitat(): Promise<ActionResult<HabitatSpeciesRollup[]>> {
  // Same shape; joins audioIdentifications → audioDetections → audioFiles → deployments
  // Filter: verificationStatus IN ('verified', 'corrected')
}

export async function fetchHabitatDashboardData(): Promise<ActionResult<HabitatDashboardData>> {
  // Parallel: getAcousticIndicesForProject(BIOCHOCO_PROJECT_ID), fetchTemperatureDistributions(),
  //          fetchCameraSpeciesByHabitat(), fetchAudioSpeciesByHabitat()
}
```

**Tasks:**

- [x] Extract today's `ResultadosShell` content into `sitio-view.tsx`. No behavior change.
- [x] Add tab triggers (`<Link href="?view=habitat">`) above the content. Wire `page.tsx` to route between views via `searchParams.view`.
- [x] Implement `fetchCameraSpeciesByHabitat()` and `fetchAudioSpeciesByHabitat()`. *(Unit tests deferred — manually verified against seeded data.)*
- [x] Implement `fetchHabitatDashboardData()` composer using `Promise.all` and the cached habitat lookup.
- [x] Build the four section components.
- [x] Wrap habitat view in `<Suspense>`. *(One top-level Suspense around `<HabitatView>` since data fetches happen in one composer call.)*
- [x] Empty-state copy per section.
- [x] If `fetchHabitatDashboardData()` returns zero data across all sections, show a single onboarding card.

#### Phase 3 — Site drill-down audio panels

Extend the existing per-site page with audio data.

**Files:**

- `src/app/biochoco/resultados/[siteId]/page.tsx` *(modify)* — no signature change; `fetchSiteDetail()` now returns audio fields.
- `src/app/biochoco/resultados/actions.ts` *(extend `fetchSiteDetail`)* — add `audioIndices`, `audioSpecies`, `audioDeploymentCount` to the return shape. Audio indices filtered to the site's deployments only; verified-only for audio species (matching camera).
- `src/app/biochoco/resultados/[siteId]/site-results-content.tsx` *(modify)* — add two new sections after Fauna (camera) and before Hábitat. Order: Fauna (cámara) → Aves (BirdNET) → Índices acústicos → Hábitat → Temperatura.
- `src/app/biochoco/resultados/[siteId]/audio-indices-panel.tsx` *(new)* — 5 small `<BoxPlot>` instances using this site's `AcousticIndicesGroup[]` (boxes by diel period within the site).
- `src/app/biochoco/resultados/[siteId]/audio-species-section.tsx` *(new)* — verified BirdNET species cards, parallel to `species-cards.tsx`.

**Tasks:**

- [x] Add `fetchSiteAudio(depIds)` server action returning indices + verified species + reviewed deployment counts. *(Added as a separate server action instead of extending `fetchSiteDetail()` so the public-share variant can skip it entirely.)*
- [x] Build `audio-indices-panel.tsx`: 5 box plots with diel period selector, faded for low coverage.
- [x] Build `audio-species-section.tsx`: verified BirdNET species cards with detection counts.
- [x] If a site has zero audio deployments, omit both new sections entirely.
- [ ] Update `site-header-stats.ts` to surface "X especies (BirdNET)" alongside camera count. *(Deferred — current header stat bar already covers camera-trap species; BirdNET counts visible in their own section. Revisit if duplicate prominence wanted.)*

#### Phase 4 — Deprecation & cleanup

**Files:**

- `src/app/audio/indices/page.tsx` *(delete)*
- `src/app/audio/indices/acoustic-indices-box-plot.tsx` *(delete — logic now in `<BoxPlot>`)*
- `src/components/sidebar-nav.tsx` *(modify)* — remove the "Índices acústicos" child under Audio.
- `src/app/audio/indices/route.ts` *(new, optional)* — 302 redirect to `/biochoco/resultados?view=habitat` for bookmark compat. Skip if not warranted.

**Tasks:**

- [x] Confirm no other consumers of `getAcousticIndicesForProject` outside the new dashboard.
- [x] Remove the route and sidebar entry. Verify build.
- [x] Skip redirect — `/audio/indices` returns 404 as decided in the Q&A.
- [ ] Update `CLAUDE.md` if any patterns shifted. *(Not needed — `habitat-lookup.ts` is the only architectural change and it's self-documenting.)*

## Alternative Approaches Considered

- **Sub-tabs per metric inside the habitat view** — cleaner per-metric breathing room but breaks cross-modality comparison, which is the explicit goal.
- **Habitat-card grid → drill into a single habitat** — better when habitat list grows large but makes the cross-habitat comparison click-heavy; the data volume today is small enough that side-by-side is the better UX.
- **New route `/biochoco/dashboard` alongside `/biochoco/resultados`** — preserves the existing page but creates two entry points and ambiguity in the nav. Rejected in brainstorm (replace, not coexist).
- **Materialize habitat per deployment in the DB** — would speed up the four aggregators but adds a sync responsibility against ODK. Defer until ODK calls become a measurable bottleneck. `React.cache` on the lookup is enough for v1.

## Acceptance Criteria

### Functional Requirements

- [ ] `/biochoco/resultados` defaults to the Sitio view; map + table render identically to the current page.
- [ ] `/biochoco/resultados?view=habitat` shows the new four-section habitat view.
- [ ] Habitat multi-select filters all four sections simultaneously. Diel selector only affects the acoustic indices section (with visible label clarifying scope).
- [ ] Acoustic indices section renders 5 boxplots (SS, ACI, Hf, Ht, EPS), one box per habitat × selected diel period.
- [ ] Camera species section shows per-habitat species richness + detection count + top species, with "N de M deployments verificados" badge. Uses only `verificationStatus IN ('verified', 'corrected')` data.
- [ ] BirdNET species section shows per-habitat species richness from verified annotations only. New filter applied in the query.
- [ ] Temperature section shows 3 boxplots (min/mean/max) per habitat, unchanged data semantics from `/biochoco/ibutton`.
- [ ] Low-coverage threshold (`n<4`) fades affected groups at 40% opacity across all sections. Single explanatory caption at top of tab.
- [ ] Per-site drill-down at `/biochoco/resultados/[siteId]` includes Aves (BirdNET) and Índices acústicos sections, ordered: Fauna → Aves → Índices acústicos → Hábitat → Temperatura.
- [ ] If a site has zero audio data, both audio sections are omitted entirely.
- [ ] `/audio/indices` returns 404 (or 302 to the habitat view); sidebar entry removed.
- [ ] `/biochoco/ibutton` upload page still works (no regression).

### Non-Functional Requirements

- [ ] `loadSiteHabitatMap()` is called at most once per request to `?view=habitat` (verify via logging).
- [ ] Habitat-view first-contentful-paint reasonable on the production dataset (target: <2s for DB sections via Suspense, <5s including ODK habitat map).
- [ ] No new Drizzle async-transaction footguns — all aggregation queries are read-only.
- [ ] Permission gate: `requirePermission("biochoco", "viewer")` on both views and on `fetchHabitatDashboardData()`. Audio panels do NOT require `grabaciones` access (this is BioChoco context).
- [ ] Spanish UI strings throughout; no English leakage in section headers, empty states, or filter labels.

### Quality Gates

- [ ] Vitest unit tests for the two new aggregators with seeded fixtures covering: (1) mixed-verification deployments, (2) `verified_empty` status, (3) habitat fallback chain, (4) `"unknown"` habitat bucket, (5) `n<4` threshold.
- [ ] Vitest snapshot for `<BoxPlot>` covering low-coverage rendering and the three direction arrows.
- [ ] Playwright E2E happy path: navigate to `/biochoco/resultados`, switch to Habitat tab, change diel, change habitat filter, drill into a site, confirm audio sections render.
- [ ] Manual visual regression on `/audio/indices` migrated boxplot before deletion (Phase 1) and `/biochoco/ibutton` after migration.

## Success Metrics

- All four metrics visible in one scrollable page (qualitative — passes user review).
- Zero data-discrepancy reports between the new habitat tab and the existing site detail page for the same site (same source of truth).
- `/audio/indices` removable without complaint (no team workflows blocked).

## Dependencies & Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| ODK habitat fetch becomes a bottleneck with 4 aggregators | Medium | `React.cache()` wrapper around `loadSiteHabitatMap()` (single fetch per request). Add timing log; if >2s, materialize habitat in DB in Phase 5. |
| Audio annotation verification filter is wrong (strict `=` vs `IN`) | Low | Open question Q1 — confirm with user before Phase 2 implementation. |
| Habitat bucketing diverges between sections (one uses `transformSites`, another uses `resolveHabitatForDeployment`) | High | `src/lib/habitat-lookup.ts` is the single source of truth. Both sitio-tab and habitat-tab go through it. |
| `verified_empty` deployments wrongly excluded from denominators | Medium | Explicit test fixture; aggregator includes them in `verifiedDeploymentCount` but yields zero species. |
| Removing `/audio/indices` breaks bookmarks for non-BioChoco audio projects | Low (BioChoco is currently the only audio project per `BIOCHOCO_PROJECT_ID` constant) | Confirm with user; add 302 redirect if needed. |
| ODK form restructuring (deploy_date moved) — flagged in CLAUDE.md and docs/solutions | Low (not used in this feature) | No new ODK form reads; just sites dataset. |
| `useSearchParams` not used elsewhere; introducing tab routing pattern | Low | Document the pattern; keep tab triggers as `<Link>` so it's idiomatic Next.js, not a custom abstraction. |

## Resource Requirements

- Single engineer, no infra changes, no new dependencies.
- Estimate: ~2–3 days of focused work split as Phase 1 (~0.5d), Phase 2 (~1.5d), Phase 3 (~0.5d), Phase 4 (~0.25d).

## Future Considerations

- **Time dimension**: temporal comparison across deployment rounds (V1 vs V2) is deferred. Likely a third tab or a per-section toggle when data volume warrants it.
- **Habitat caching in DB**: if ODK lookup latency becomes a perf issue, materialize `habitat_type` per deployment with a nightly sync. Out of scope now.
- **Public share for habitat view**: today only per-site shares exist; a "share this habitat comparison" link would require its own snapshot strategy.
- **Per-habitat drill-down**: clicking a habitat in any section to filter to just sites in that habitat. Light-weight — single param to `sitio-view`. Could land in v1.1.

## Documentation Plan

- Update `CLAUDE.md` "Key Patterns" with a one-liner on the `habitat-lookup.ts` helper if anything in its shape differs from the inline implementations it replaces.
- Add a short note to `docs/solutions/` only if the migration surfaces a non-obvious gotcha (e.g., `React.cache` ↔ Server Action boundaries). Skip otherwise.

## References & Research

### Internal References

- **Brainstorm**: `docs/brainstorms/2026-05-11-biochoco-unified-results-dashboard-brainstorm.md`
- **Today's resultados page**: `src/app/biochoco/resultados/page.tsx`, `resultados-shell.tsx`, `actions.ts:91` (`fetchResultadosData`), `actions.ts:222` (`fetchSiteDetail`), `actions.ts:359` (`fetchSpeciesForDeployments`).
- **Acoustic indices**: `src/app/audio/indices/page.tsx`, `acoustic-indices-box-plot.tsx`, `src/app/audio/actions.ts:1521` (`getAcousticIndicesForProject`), `src/lib/acoustic-indices.ts` (config + diel periods).
- **iButton temperature**: `src/app/biochoco/ibutton/temperature-shell.tsx`, `box-plot-chart.tsx`, `temperature-distributions.tsx:17` (`groupByHabitat`), `actions.ts:540` (`fetchTemperatureDistributions`).
- **Schema**: `src/db/schema.ts:848` (`acousticIndices`), `:705` (`ibuttonUploads`), `:749` (`ibuttonReadings`), camera identifications + audio identifications tables.
- **Habitat colors/labels**: `src/app/biochoco/habitat/types.ts:32`, `src/app/biochoco/overview/types.ts:19`.
- **Sidebar nav**: `src/components/sidebar-nav.tsx:175` (entry to remove).
- **Constants**: `src/lib/odk-constants.ts` (`BIOCHOCO_PROJECT_ID`, dataset/form IDs).

### Institutional Learnings

- **CLAUDE.md**: Drizzle `sql` template drops `undefined` — use `?? null` for optional fields. `better-sqlite3` transactions must be sync. Spanish UI throughout.
- **Memory: vi.mock hoisting from helper files** — keep new aggregator tests isolated; don't import the global `setupDbMock` helper.
- **`docs/solutions/ui-bugs/biochoco-overview-horizontal-scroll-map-overlap.md`** — long stacked content + sidebar layout: use `min-w-0` on flex containers; the habitat tab will be wide and tall.
- **`docs/solutions/integration-issues/odk-form-field-restructuring-deploy-date.md`** — ODK fallback chains; not directly relevant here (sites dataset, not the deploy form) but worth keeping in mind if any deployment-metadata reads creep in.
- **`docs/solutions/runtime-errors/async-transaction-better-sqlite3-CameraTrap-20260223.md`** — aggregation queries are read-only here, no transaction risk.

### External References

No external research needed — this is internal refactoring with all patterns already established in the codebase.

## Open Questions

1. **Audio verification status equality** — Camera trap uses `verificationStatus IN ('verified', 'corrected')`. The brainstorm says "verified annotations only". Confirm: use `IN ('verified', 'corrected')` for consistency, or strict `= 'verified'` only? Plan currently assumes the IN form for parity with camera.
2. **`verified_empty` denominator** — Should `verified_empty` deployments count toward the "N de M verificadas" badge in the camera species section? Plan currently includes them (deployment was verified, just contributed zero species). Confirm.
3. **Public site-share view** — When a per-site public share token is loaded at `/public/biochoco/[token]`, should the new audio panels appear, or stay internal-only? Plan defaults to **internal-only** (privacy-conservative). Token snapshot would need extension to include audio data otherwise.
4. **`"unknown"` habitat column** — In every habitat section, deployments with no resolvable habitat fall into an `"unknown"` / "Sin clasificar" bucket. Show as a final column with a distinct color, or hide entirely? Plan assumes show-last with a muted color so unmapped data isn't silently dropped.
5. **`/audio/indices` redirect** — Add a 302 to `?view=habitat`, or 404? Cheap to add the redirect; recommend yes.
6. **Heading on the new dashboard** — Today's H1 is "Resultados por Sitio". With two tabs, neutral options: "Resultados de Monitoreo BioChocó" or just "Resultados". Confirm preferred string.
7. **Per-habitat top-N species** — Show top 5 species per habitat (collapsible) in the camera/audio sections, or just the richness number? Plan assumes top 5 collapsible — easy to dial back.
