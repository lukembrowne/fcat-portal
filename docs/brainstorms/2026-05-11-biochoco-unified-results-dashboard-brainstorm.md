---
date: 2026-05-11
topic: biochoco-unified-results-dashboard
---

# BioChoco Unified Results Dashboard

## What We're Building

A unified BioChoco results dashboard that consolidates camera trap, audio (BirdNET + acoustic indices), and iButton temperature data into one surface — replacing today's `/biochoco/resultados` and absorbing the standalone `/audio/indices` page. The dashboard has two equal first-class views: **"Por hábitat"** (cross-habitat comparison) and **"Por sitio"** (today's site map/table with audio added to the drill-down). The current `/biochoco/ibutton` page stays for its upload workflow; `/audio/indices` is deprecated.

Habitat assessment data (understory, slope, disturbance, height class, directional photos — currently shown on the per-site detail page) becomes a first-class context layer in the comparison view. Verified-only filtering is strict for species/detection metrics; acoustic indices and temperature are shown regardless of verification.

## Why This Approach

Three layouts were considered:
- **A — Single scrollable dashboard with four stacked sections** (chosen). Side-by-side comparison across modalities is the explicit goal; co-visibility lets researchers spot cross-metric patterns (e.g., habitat with high ACI also has high species count, lower temp variance).
- **B — Sub-tabs per metric.** Cleaner per-metric breathing room, but breaks the comparison goal.
- **C — Habitat-card grid drilling into one habitat at a time.** Better if the habitat list grows large, but makes comparison click-heavy.

The data volume is modest (a handful of habitat types × tens of sites × few deployments each), so a dense single-page layout is manageable.

## Key Decisions

- **Route**: Replace `/biochoco/resultados`. Top-level tabs: `Por hábitat` (new) and `Por sitio` (existing map + site table). Site drill-down stays at `/biochoco/resultados/[siteId]` and is extended with audio panels.
- **"Por hábitat" structure**: Filter bar (habitat multi-select, project, diel selector for indices) → four stacked sections in this order:
  1. **Índices acústicos** — 5 boxplots (SS, ACI, Hf, Ht, EPS), grouped by habitat × diel period. Shown regardless of verification.
  2. **Cámaras trampa** — species richness + total detections per habitat. Verified deployments only.
  3. **Aves (BirdNET)** — species richness per habitat from verified audio annotations only.
  4. **Temperatura** — boxplots of mean/min/max per habitat.
- **Habitat context**: Color legend pinned at top with hover to surface the ODK habitat-assessment data (understory, disturbance, etc.) that already drives the per-site `HabitatSection`.
- **Verification semantics**: Strict — unverified camera deployments and unverified audio annotations are excluded entirely from species/detection counts. Acoustic indices and temperature ignore verification. Each section shows a "N de M depl. verificados" badge for transparency.
- **Time dimension**: Not in scope. All deployment rounds (V1, V2, …) for a site are aggregated. Revisit if temporal questions emerge.
- **Per-site drill-down**: Extend the existing site detail page (single scrollable, keeps Habitat + Cámara + iButton sections) with new audio panels — acoustic indices boxplots for that site's deployments by diel, plus verified-annotation species list. No new tabs.
- **Migration**: Remove `/audio/indices` route and its nav entry; keep `/biochoco/ibutton` (upload workflow remains valuable).

## Open Questions

- **Habitat data source**: Habitat type is on ODK site entities and fetched fresh per page load today. Does the new dashboard need a caching layer to keep load times tolerable when joining indices/detection/temp data across all sites?
- **"Por hábitat" species lists**: Show top-N species per habitat, or just a richness number? (Richness for v1 likely; species drill-down is a phase-2 candidate.)
- **Sample-size handling**: Acoustic indices already fade habitats with `n<4`. Should camera/audio species-richness use the same threshold, or a different rule given verification is required?
- **Habitat × diel cell density**: With both axes, the indices section could become tall. Consider a single boxplot per index with habitat as one facet axis vs. diel as another (e.g., faceted small multiples).
- **Project scope**: BioChoco is a single project today, but the indices page filters by project. Confirm the new dashboard is BioChoco-scoped and the project filter is implicit (or removed).

## Next Steps

→ `/workflows:plan` for implementation details (schema queries, server-action shape, component breakdown, deprecation steps for `/audio/indices`).
