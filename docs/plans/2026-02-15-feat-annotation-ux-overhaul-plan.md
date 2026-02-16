---
title: "feat: Annotation UX Overhaul"
type: feat
date: 2026-02-15
brainstorm: docs/brainstorms/2026-02-15-annotation-ux-overhaul-brainstorm.md
---

# Annotation UX Overhaul

## Overview

Overhaul the camera trap annotation page (`/camera-trap/results/[jobId]/images/[imageId]`) to reduce species assignment from 4 clicks to 1, add detection deletion, and restructure the layout into three zones: species sidebar (left), detection cards (above image), and collapsible help panel (below image).

## Problem Statement

1. **Too many clicks to assign a species**: Click "Corregir..." → open popover → search → click species = 4 steps. Should be 1 click.
2. **No way to delete false/duplicate detections**: Rejection only changes status — the bounding box remains visible. Need hard delete.
3. **Sidebar wastes space**: Right sidebar mixes detection cards with species selection, creating a cramped vertical flow.
4. **Verified items locked**: UI hides edit controls after verification, even though the backend supports re-correction.
5. **No help text**: New users have no guidance on the annotation workflow or keyboard shortcuts.
6. **Recent species not wired up**: `getRecentSpecies()` exists in the backend but is never called.

## Proposed Solution

Three-zone layout with always-visible species list, compact detection cards, and streamlined keyboard-driven workflow.

```
+-------------------+------------------------------------------+
| LEFT SIDEBAR      |  DETECTION CARDS (horizontal strip)       |
| (Species list)    +------------------------------------------+
|                   |                                          |
| - Search box      |  IMAGE + BOUNDING BOX OVERLAY            |
| - Scrollable list |                                          |
| - Hotkeys 1-0     |                                          |
|   for top 10      |                                          |
|                   +------------------------------------------+
|                   |  HELP PANEL (collapsible)                 |
+-------------------+------------------------------------------+
```

## Design Decisions

These were resolved during brainstorming and SpecFlow analysis:

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Delete type | Hard delete (remove rows) | Simpler, no ghost data |
| Sidebar position | Left | Natural for left-to-right reading |
| Detection cards | Horizontal strip above image | Frees sidebar for species list |
| Species assignment | Select box → click species (1 click) | Fastest workflow |
| Auto-verify | Yes, on species assignment | Saves an extra click |
| Bbox editing | Delete + redraw | Simpler than resize handles |
| Help panel | Detailed, collapsible, below image | Reference material, not active workflow |
| Number keys | Context-dependent | No detection selected → select detection; detection selected → assign species |
| Navigation warnings | None | All actions save immediately |
| Rejected detections | Cannot be species-assigned | Use delete + redraw instead |
| Hotkey-to-species mapping | Follows visible (filtered) list | Enables type-to-narrow then press `1` workflow |
| Escape in search | Clears search if has text; deselects detection if empty | Two-level Escape behavior |

## Technical Approach

### Architecture

**Component tree (new):**
```
page.tsx (Server Component — data fetching, auth)
└── ImageAnnotationClient (Client Component — replaces ImageDetailClient)
    ├── SpeciesSidebar (left sidebar)
    │   ├── Search input
    │   └── Scrollable species list with hotkey numbers
    ├── Main content area
    │   ├── DetectionCardStrip (horizontal strip above image)
    │   │   └── DetectionCard × N (compact, uniform)
    │   ├── BBoxOverlay (existing, minor tweaks)
    │   └── HelpPanel (collapsible, below image)
    └── DeleteDetectionDialog (confirmation modal)
```

**Data flow (unchanged pattern):** Server Component fetches all data → passes as props to Client Component → server actions for mutations → `router.refresh()` for re-fetch.

**New server action:** `deleteDetection(detectionId)` — hard delete with editor permission and activity log.

**Modified server action:** `assignSpecies(identificationId, newSpecies)` — composite action that auto-determines verify vs. correct based on comparing `newSpecies` to `identification.species` (the original ML prediction). If match → set `verified`; if mismatch → set `corrected` with `correctedSpecies`.

### Implementation Phases

#### Phase 1: Backend — New server actions and data wiring

**Files:**
- `src/app/camera-trap/actions.ts` — new `deleteDetection`, new `assignSpecies`
- `src/app/camera-trap/results/[id]/images/[imageId]/page.tsx` — wire up `getRecentSpecies`

**Tasks:**

- [x] Create `deleteDetection(detectionId: number)` server action
  - `requirePermission("camera-trap", "editor")`
  - Verify detection exists, fetch its image info for the activity log
  - `db.delete(detections).where(eq(detections.id, detectionId))` (CASCADE deletes identification)
  - Write to `activityLog`: "Deleted detection #N from image filename.jpg"
  - `revalidatePath` for the image detail page
  - Return `ActionResult<void>`

- [x] Create `assignSpecies(identificationId: number, newSpecies: string)` server action
  - `requirePermission("camera-trap", "editor")`
  - Fetch the identification to get `identification.species` (original ML prediction)
  - Compare `newSpecies` with `identification.species`:
    - Match → `verificationStatus: "verified"`, `correctedSpecies: null`
    - Mismatch → `verificationStatus: "corrected"`, `correctedSpecies: newSpecies`
  - Set `verifiedBy` and `verifiedAt`
  - WHERE clause: `verificationStatus IN ("unverified", "verified", "corrected")` — rejected excluded
  - `revalidatePath`
  - Return `ActionResult<void>`

- [x] Wire up `getRecentSpecies` in `page.tsx`
  - Derive `deploymentId` from the job (via `getJobWithDetails` or a simpler query)
  - Pass `recentSpecies` to the client component
  - Handle case where deployment is unknown (return empty array)

- [ ] Fix `getJobVerificationStats` to include manual detections
  - Query via `detections.imageId → images` join instead of `detections.jobId` directly
  - Manual detections (`jobId: null`) on images belonging to the job should be counted

#### Phase 2: Layout restructure — Three-zone grid

**Files:**
- `src/app/camera-trap/results/[id]/images/[imageId]/image-detail-client.tsx` → rename to `image-annotation-client.tsx`
- `src/app/camera-trap/results/[id]/images/[imageId]/page.tsx` — update import

**Tasks:**

- [x] Restructure the grid layout from `grid-cols-[1fr_320px]` to three-zone design
  ```tsx
  <div className="flex gap-4 h-[calc(100vh-12rem)]">
    {/* Left sidebar — species list */}
    <aside className="w-64 shrink-0 flex flex-col min-w-0 overflow-hidden">
      <SpeciesSidebar ... />
    </aside>

    {/* Main content — detection cards + image + help */}
    <div className="flex-1 flex flex-col min-w-0 gap-3">
      {/* Detection cards strip */}
      <DetectionCardStrip ... />

      {/* Image with bbox overlay */}
      <div className="flex-1 min-h-0 rounded-lg overflow-hidden border bg-muted">
        <BBoxOverlay ... />
      </div>

      {/* Collapsible help panel */}
      <HelpPanel />
    </div>
  </div>
  ```
  - Use `min-w-0` on all flex children (per learnings: prevents overflow)
  - Use `overflow-y-auto overflow-x-hidden` on scrollable areas
  - Fixed height container (`h-[calc(100vh-12rem)]`) to prevent page scroll — annotation should fill viewport

- [ ] Move breadcrumb and prev/next navigation outside the grid (keep in page.tsx header)

#### Phase 3: Species sidebar component

**Files:**
- `src/components/species-sidebar.tsx` (new)

**Tasks:**

- [x] Create `SpeciesSidebar` component
  - **Props:** `speciesList: Species[]`, `recentSpecies: Species[]`, `selectedDetectionId: number | null`, `onSelectSpecies: (scientificName: string) => void`
  - **Search input** at top: filters species by scientific name, common name, Spanish name
  - **Scrollable list** below search:
    - If no search query and `recentSpecies.length > 0`: show "Recientes" section first
    - Group by type (mammals, birds, etc.) using same `TYPE_LABELS` and `TYPE_ORDER` from `species-combobox.tsx`
    - Each item shows: hotkey number badge (1-10 for first 10 visible), italic scientific name, common name (muted)
    - Hotkey numbers update as the list filters (they always map to the currently visible order)
  - **Click handler:** calls `onSelectSpecies(scientificName)` — disabled if no detection selected
  - **Visual states:**
    - No detection selected → species items appear slightly muted, cursor not-allowed
    - Detection selected → species items are interactive, hover highlight
    - Currently assigned species gets a checkmark or highlight

- [ ] Extract shared constants from `species-combobox.tsx`
  - Move `TYPE_LABELS`, `TYPE_ORDER`, `RANK_BADGES` to a shared location (or just import from `species-combobox.tsx`)
  - Keep `species-combobox.tsx` intact — it's still used on the species management page

#### Phase 4: Detection card strip component

**Files:**
- `src/components/detection-card-strip.tsx` (new)

**Tasks:**

- [x] Create `DetectionCardStrip` component
  - **Props:** `detections: DetectionWithIdentification[]`, `selectedDetectionId: number | null`, `onSelectDetection: (id: number) => void`, `onDeleteDetection: (id: number) => void`
  - **Layout:** horizontal flex with `gap-2 overflow-x-auto` for scrolling when many detections
  - **Each card (compact, fixed width ~160px):**
    - Number badge (colored circle matching bbox color)
    - Species name (truncated) or "Sin identificar"
    - Confidence percentage (small, muted)
    - Status dot: green (verified), red (rejected), blue (corrected), gray (unverified)
    - Trash icon button (top-right corner, small, appears on hover)
  - **Selected card:** `ring-2 ring-primary` border (same pattern as current)
  - **Click:** selects detection (calls `onSelectDetection`)
  - **Trash click:** calls `onDeleteDetection` (parent handles confirmation dialog)
  - **Empty state:** if 0 detections, show "No hay detecciones" with hint to draw a box

#### Phase 5: Help panel component

**Files:**
- `src/components/annotation-help-panel.tsx` (new)

**Tasks:**

- [x] Create `AnnotationHelpPanel` component
  - **Collapsible** using Radix `Collapsible` (matches `sidebar-shell.tsx` pattern)
  - **Trigger:** "Ayuda y atajos de teclado" header with chevron icon
  - **Content sections:**
    1. **Flujo de trabajo** — numbered steps:
       - Seleccionar una deteccion (clic en el cuadro o tecla 1-9)
       - Asignar especie (clic en la lista o tecla 1-0 con deteccion seleccionada)
       - Verificar automaticamente: se verifica al asignar especie
       - Eliminar detecciones falsas: boton de basura o tecla `d`
       - Dibujar nuevos cuadros: clic y arrastrar en la imagen
    2. **Atajos de teclado** — table from `SHORTCUTS` constant (expanded with new shortcuts)
    3. **Consejos:**
       - `Enter` verifica todas las detecciones pendientes y avanza a la siguiente imagen
       - Las detecciones verificadas se pueden re-corregir
       - Use la busqueda para filtrar especies, luego tecla `1` para asignar
  - **Collapse state** persisted in `localStorage` key `annotation-help-collapsed`
  - Starts expanded on first visit, collapsed on subsequent visits

#### Phase 6: Keyboard shortcuts overhaul

**Files:**
- `src/hooks/use-annotation-shortcuts.ts` — major update

**Tasks:**

- [x] Add context-dependent number key behavior
  - New option: `selectedDetectionId: number | null`
  - New option: `onAssignSpeciesByIndex: (index: number) => void`
  - When `selectedDetectionId === null`: `1-9` selects detection (existing behavior)
  - When `selectedDetectionId !== null`: `1-9` and `0` assign species by index (0 → index 10)
  - `0` key: only active when detection is selected (assigns species #10)

- [x] Add delete shortcut
  - `d` and `Delete` keys: call `onDeleteSelected()` if a detection is selected, no-op otherwise
  - Must not trigger when focused in the search input (handled by existing field-skip logic)

- [x] Update Escape behavior
  - If species search input is focused and has text → clear the search (don't call `onDeselect`)
  - If species search input is empty or not focused → deselect detection (existing behavior)
  - Implementation: pass a `searchInputRef` to the hook, check `document.activeElement`

- [x] Update `SHORTCUTS` constant with new shortcuts for help panel display

- [ ] Suppress keyboard shortcuts during bbox drawing
  - New option: `isDrawing: boolean` — when true, all shortcuts are disabled

#### Phase 7: Wire it all together

**Files:**
- `src/app/camera-trap/results/[id]/images/[imageId]/image-annotation-client.tsx` (renamed)
- `src/app/camera-trap/results/[id]/images/[imageId]/page.tsx`

**Tasks:**

- [ ] Orchestrate state in `ImageAnnotationClient`
  - `selectedBoxId` state (existing)
  - `deleteDialogDetectionId` state (new — which detection is pending delete confirmation)
  - `searchQuery` state (new — lifted from SpeciesSidebar for Escape handling)
  - `searchInputRef` ref (new — for Escape behavior)

- [ ] Wire `assignSpecies` action to species sidebar
  ```tsx
  const handleSelectSpecies = async (scientificName: string) => {
    if (!selectedDetection) return;
    const result = await assignSpecies(selectedDetection.identification.id, scientificName);
    if (result.success) {
      router.refresh();
    }
  };
  ```

- [ ] Wire `deleteDetection` action to detection card strip + confirmation dialog
  ```tsx
  const handleConfirmDelete = async () => {
    if (!deleteDialogDetectionId) return;
    const result = await deleteDetection(deleteDialogDetectionId);
    if (result.success) {
      setDeleteDialogDetectionId(null);
      setSelectedBoxId(null); // Deselect after deletion
      router.refresh();
    }
  };
  ```

- [ ] Wire number key species assignment
  - Compute `visibleSpecies` (filtered by search query) in the parent
  - Pass `onAssignSpeciesByIndex` to the hook: `(index) => handleSelectSpecies(visibleSpecies[index]?.scientificName)`

- [ ] Add `DeleteDetectionDialog` using existing `AlertDialog` pattern (same as `batch-delete-dialog.tsx`)
  - Show detection number, species, verification status in dialog body
  - "Eliminar" (destructive) and "Cancelar" buttons

- [ ] Update `page.tsx` to import renamed client component and pass `recentSpecies`

#### Phase 8: Cleanup

**Tasks:**

- [ ] Remove old `AnnotationToolbar` component (replaced by detection card strip + species sidebar)
  - Or keep it if it's referenced elsewhere — check with `grep`
- [ ] Remove `SpeciesCombobox` import from the annotation page (still used on species management page)
- [ ] Update the `BBoxOverlay` to deselect when clicking on image background (existing behavior, verify it still works)
- [ ] Test that drawing new bounding boxes still works with the new layout
- [ ] Verify `verifyAndAdvance` (Enter key) still works correctly with the new component structure
- [ ] Test with 0 detections, 1 detection, 10+ detections
- [ ] Test responsive behavior — annotation page is desktop-primary; ensure it doesn't break on narrower viewports (stack vertically below `lg`)

## Acceptance Criteria

### Functional Requirements

- [ ] Species can be assigned with 1 click (select box, click species) — no "Corregir..." step
- [ ] Species assignment auto-verifies (verified if same as ML, corrected if different)
- [ ] Verified/corrected detections can be re-assigned a different species
- [ ] Detections can be hard-deleted via trash button on card or `d`/`Delete` key
- [ ] Deletion shows confirmation dialog with detection details
- [ ] Species sidebar shows always-visible list with search filter
- [ ] First 10 visible species show hotkey numbers (1-0)
- [ ] Number keys are context-dependent: select detection (no selection) vs. assign species (detection selected)
- [ ] Help panel below image shows workflow, keyboard shortcuts, and tips
- [ ] Help panel collapse state persists in localStorage
- [ ] Recent species appear at top of sidebar list
- [ ] Detection cards appear as horizontal strip above image
- [ ] Drawing new bounding boxes still works
- [ ] `Enter` to verify all + advance still works
- [ ] Activity log records detection deletions

### Non-Functional Requirements

- [ ] All server actions call `requirePermission("camera-trap", "editor")`
- [ ] All actions use `ActionResult<T>` return type
- [ ] Layout uses `min-w-0` on flex children to prevent overflow
- [ ] No regressions in existing keyboard shortcuts (arrow nav, Enter, v, Escape)

## Files Changed

| File | Action | Description |
|------|--------|-------------|
| `src/app/camera-trap/actions.ts` | Edit | Add `deleteDetection`, `assignSpecies` actions; fix `getJobVerificationStats` |
| `src/app/camera-trap/results/[id]/images/[imageId]/page.tsx` | Edit | Wire `recentSpecies`, update import to new client component |
| `src/app/camera-trap/results/[id]/images/[imageId]/image-detail-client.tsx` | Rename+Edit | → `image-annotation-client.tsx`, full layout restructure |
| `src/components/species-sidebar.tsx` | Create | Always-visible species list with search and hotkeys |
| `src/components/detection-card-strip.tsx` | Create | Horizontal compact detection cards |
| `src/components/annotation-help-panel.tsx` | Create | Collapsible workflow guide and shortcuts reference |
| `src/hooks/use-annotation-shortcuts.ts` | Edit | Context-dependent keys, delete shortcut, Escape refinement |
| `src/components/annotation-toolbar.tsx` | Potentially remove | Replaced by detection-card-strip + species-sidebar |
| `src/components/bbox-overlay.tsx` | Minor edit | Ensure selection/deselection works with new parent |

## References

- Brainstorm: `docs/brainstorms/2026-02-15-annotation-ux-overhaul-brainstorm.md`
- Current annotation page: `src/app/camera-trap/results/[id]/images/[imageId]/page.tsx`
- Current client component: `src/app/camera-trap/results/[id]/images/[imageId]/image-detail-client.tsx`
- Server actions: `src/app/camera-trap/actions.ts` (lines 1589-1679 for verify/reject/correct, 2141-2203 for createManualDetection, 2110-2139 for getRecentSpecies, 2205-2276 for verifyAndAdvance)
- Schema: `src/db/schema.ts` (lines 242-312 for detections, identifications, species tables)
- Sidebar overflow fix learnings: `docs/solutions/ui-bugs/biochoco-overview-horizontal-scroll-map-overlap.md`
- Security patterns learnings: `docs/solutions/security-issues/phase2-code-review-12-findings.md`
