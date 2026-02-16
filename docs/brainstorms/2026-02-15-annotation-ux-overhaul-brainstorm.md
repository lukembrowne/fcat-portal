# Annotation UX Overhaul — Brainstorm

**Date:** 2026-02-15
**Status:** Ready for planning

## What We're Building

A major UX overhaul of the camera trap annotation page (`/camera-trap/results/[jobId]/images/[imageId]`) to make species identification faster, add detection deletion, and improve the overall layout.

## Why This Approach

The current annotation workflow requires too many clicks to assign a species (click "Corregir..." → open popover → search → click species = 4 steps). The sidebar on the right wastes vertical space by mixing detection cards with the species selector. Verified items can't be re-edited in the UI despite the backend supporting it. There's no way to delete false/duplicate detections — rejection only hides the status but the bounding box remains.

## Key Decisions

### 1. Layout: Three-zone design

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

- **Left sidebar**: Always-visible species list with search filter and hotkeys
- **Detection cards**: Horizontal strip above the image, compact cards
- **Help panel**: Collapsible reference panel below the image
- **Image**: Center-right, with bounding box SVG overlay (keeps existing draw-new-box feature)

### 2. Species selection: Always-visible list with hotkeys

- Scrollable species list always shown in the left sidebar
- Search/filter box at the top
- Top 10 most-used species get number hotkeys (1-0)
- Grouped by type (mammals, birds, reptiles, etc.) like the current combobox
- Wire up the existing `getRecentSpecies()` backend to show recently-used species at top
- Clicking a species assigns it to the currently selected detection

### 3. Auto-verify on species assignment

- When you click a species (or press its hotkey), the detection is immediately:
  - **Corrected** (if ML species was different) with `correctedSpecies` set
  - **Verified** (if ML species matches) with status set to `verified`
- No separate "Corregir..." step — species assignment IS verification
- Already-verified or corrected items can be re-corrected (UI now exposes this)

### 4. Detection deletion: Hard delete

- Each detection card gets a trash icon button
- Keyboard shortcut: `d` or `Delete` key on selected detection
- Confirmation dialog before deletion (brief: "Delete detection #3?")
- Hard delete: removes both the `biochoco_detections` and `biochoco_identifications` rows
- New server action: `deleteDetection(detectionId)` with `requirePermission`

### 5. Detection cards: Compact, uniform

- Horizontal strip above image, one card per detection
- Each card shows: number badge, species name (or "Sin identificar"), confidence %, status dot, delete button
- Selected card gets a highlight border (matches the bounding box color)
- Clicking a card selects its corresponding bounding box on the image

### 6. Bounding box editing: Delete + redraw

- No resize or move handles — too complex for the value
- Wrong box? Delete it, draw a new one (drawing already exists)
- This keeps the SVG overlay simple

### 7. Help panel: Detailed, collapsible

- Below the image in a collapsible panel
- Contains: workflow description, keyboard shortcuts table, tips
- Starts collapsed after first visit (remember preference in localStorage)

### 8. No navigation warnings

- All actions save immediately (server actions write to DB on each click)
- No "unsaved changes" state to protect
- The results table shows verification status per image, so skipped images are easy to find

## Workflow (Happy Path)

1. Image loads with bounding boxes visible, detection cards above
2. Click a box or card (or press number key) to select a detection
3. **ML got it right?** → Press `v` to verify, or `Enter` to verify all + advance
4. **Wrong species?** → Click correct species in left sidebar (or press its hotkey). Auto-verifies as "corrected"
5. **False/duplicate detection?** → Click trash icon or press `d`. Hard-deletes from DB
6. **Missing detection?** → Draw a new box (existing feature), then assign species
7. **Need to fix a verified one?** → Select it, click correct species. Overrides previous
8. Arrow keys → next image

## Keyboard Shortcuts (updated)

| Key | Action |
|-----|--------|
| Left/Right arrows | Navigate to prev/next image |
| 1-9, 0 | Select detection by number / Assign species (context-dependent, see below) |
| Escape | Deselect current detection |
| Enter | Verify all unverified + advance to next unverified image |
| v | Verify selected detection |
| d / Delete | Delete selected detection |

**Note:** Number keys 1-9/0 serve double duty. When no detection is selected, they select a detection. When a detection IS selected, they assign a species from the hotkey list. Need to decide if this is confusing or if we want separate key ranges.

## Resolved Questions

1. **Number key conflict**: Context-dependent. No detection selected → 1-9 selects a detection. Detection IS selected → 1-9 assigns a species from the hotkey list. Press Escape to deselect and switch back to detection selection mode.

## Open Questions

1. **Species hotkey assignment**: How to determine the "top 10"? By frequency across all jobs? Per-job frequency? Manually pinned?

## What's NOT Changing

- Image serving and thumbnail caching
- Bulk verification by confidence threshold
- Image grid view and filtering
- ML pipeline and detection creation
- Manual box drawing (keep as-is)
- Navigation (prev/next with counter)
