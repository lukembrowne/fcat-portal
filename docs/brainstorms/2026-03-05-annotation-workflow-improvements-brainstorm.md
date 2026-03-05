# Camera Trap Annotation Workflow Improvements

**Date:** 2026-03-05
**Status:** Approved

## What We're Building

Three targeted improvements to the camera trap annotation workflow to reduce friction and improve speed:

### 1. Auto-focus species search on detection selection

When a user draws a new bounding box or clicks an existing annotation to select it, the "Buscar especie..." search input in the sidebar automatically receives focus. This lets the user immediately start typing a species name without reaching for the search bar.

- Works for both new manual detections (drawn bboxes) and clicking existing detection boxes
- Number hotkeys (1-9, 0) continue to work since they're already intercepted from the search input via `use-annotation-shortcuts.ts`
- Deselecting a detection (Escape) should blur the search and clear the query

### 2. Frequency-based stable species hotkeys ("Frecuentes")

Replace the current "Recientes" section (ordered by most-recently-used, which shifts constantly) with "Frecuentes" — ordered by total identification count within the deployment.

- Query changes from `ORDER BY verifiedAt DESC` to `ORDER BY COUNT(*) DESC`
- Section header renamed from "Recientes" to "Frecuentes"
- Hotkey assignments are now stable — the most-used species in a deployment rarely change position mid-session
- No count badges displayed (keep it clean) — just the stable ordering

### 3. Bold group headers with divider lines

Add visual separators between species groups (Mamiferos, Aves, Reptiles, etc.) in the sidebar:

- Subtle horizontal divider line above each group header (except the first)
- Group headers rendered bolder and slightly larger than species rows
- Applies to the main grouped list, not the Frecuentes section

## Why This Approach

- **Auto-focus** is the simplest possible change (a `ref.focus()` call) that eliminates the most common friction point — reaching for the search bar after every selection
- **Frequency-based ordering** addresses the core confusion: hotkeys that keep changing. Most deployments have a handful of dominant species, so frequency ordering is naturally stable
- **Bold headers + dividers** is the standard visual pattern that adds clarity without complexity (no collapsing state, no color management)

## Key Decisions

- Auto-focus sidebar search (not inline popup) — keeps the UI simple, leverages existing search + hotkey infrastructure
- Frequency-based ordering (not pinned favorites or session locking) — zero configuration needed, works automatically
- Rename to "Frecuentes" to accurately reflect the new behavior
- Bold headers + divider lines (not colored accents or collapsible sections) — minimal visual change

## Open Questions

- None — scope is well-defined and self-contained

## Files to Modify

- `src/components/species-sidebar.tsx` — add ref forwarding for search input, add group visual separators, rename "Recientes" to "Frecuentes"
- `src/app/camera-trap/results/[id]/images/[imageId]/image-annotation-client.tsx` — trigger focus on detection selection
- `src/app/camera-trap/actions.ts` — change `getRecentSpecies` to frequency-based query (rename to `getFrequentSpecies`)
- `src/app/camera-trap/results/[id]/images/[imageId]/page.tsx` — update server call from `getRecentSpecies` to `getFrequentSpecies`
