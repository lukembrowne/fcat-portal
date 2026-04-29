# Annotation Contextual Picker & Stable Hotkeys — Brainstorm

**Date:** 2026-04-21
**Status:** Ready for planning
**Scope:** Camera-trap annotation page (`src/app/camera-trap/results/[id]/images/[imageId]/`). Audio annotation may follow the same pattern later but is out of scope here.

## Problem

The current annotation flow has two compounding frictions:

1. **Hotkey drift.** Number keys (1–9, 0) are bound to the first 10 species in the sidebar's "Frequent" section (`species-sidebar.tsx:110-116`). As the user annotates, those frequencies shift, so a species you just learned is "3" may become "2" minutes later. Muscle memory breaks and the user second-guesses every keystroke.
2. **Eye travel to the sidebar.** After clicking a bounding box, the user's gaze has to move from the bbox on the image to the species list on the far left, find the target, and click or type. Small cost per box, but it adds up over hundreds of annotations.

User confirmed the hotkey-drift pain is the bigger of the two, and that a typical session cycles through only ~5–10 species.

## What We're Building

Two tightly related UX changes:

### 1. Stable per-page-load hotkey slots

- Compute the **top 10 species for the project** (across all annotated images in the project) once when the annotation page loads.
- Lock those species to hotkey slots 1–9 and 0 for the entire session — they do not reshuffle as the user annotates.
- Re-computed on each page load, so the slot assignments drift slowly across sessions as the project's totals accumulate. A species that becomes popular over weeks will eventually earn a slot; none of this reshuffles mid-session.
- **Fallback when the project has no annotations yet:** fall back to a deterministic order (taxonomic group then alphabetical) so slots still exist on day one.
- The "Frequent" sidebar section's hotkey-numbering logic (`species-sidebar.tsx:92-116`) is replaced by this stable set. The sidebar remains for reference and long-tail species.

### 2. Compact popover picker anchored to the selected bounding box

- When the user clicks a bbox (or selects it via a number key), a small popover appears positioned near the bbox.
- **Hard constraint: the popover must never cover the selected bounding box itself.** It may cover other parts of the image. Auto-flip around all four sides of the bbox to find space.
- Popover contents:
  - The 10 hotkey-slot species as labeled buttons showing name + slot number (1–0).
  - A search/typeahead field (reuse `SpeciesCombobox`) for the long tail.
  - Verify / Reject / Delete action buttons for the selected detection.
- Keyboard-first: number keys assign species, `v`/`r` verify/reject, typing focuses the search field, `Esc` dismisses.
- Closing behavior: closes on Esc, on bbox deselect, on navigation, or when the user clicks outside.
- The left sidebar stays in place for reference and for rare species not in the top 10 — clicking a sidebar row still works.

## Why This Approach

- **Directly targets the named pains.** Stable hotkeys kill the drift; the popover collapses the eye-travel distance to zero.
- **Low disruption.** Existing keyboard shortcuts (`use-annotation-shortcuts.ts`) keep working. The sidebar stays. The popover is additive.
- **No new settings UI.** Per-page-load recomputation means no pinning, no "refresh slots" button, no user management burden. The drift across sessions is gradual because it's a project-wide aggregate.
- **Scales to the stated workload.** With 5–10 species in rotation, the 10 slots cover the common case completely. The long tail is always reachable via search.

## Key Decisions

- **Hotkey source of truth:** top 10 by count across all annotated images in the **project** (not the deployment, not global). Covers brand-new deployments; most stable across a user's work in one project.
- **Recompute cadence:** once per annotation page load. No caching, no TTL, no manual refresh.
- **Empty-state fallback:** taxonomic group order then alphabetical, so slots are always defined.
- **Picker form:** popover (Radix or equivalent), anchored to the bbox with auto-flip to avoid covering the bbox.
- **Sidebar fate:** retained as a reference view for the long tail; still clickable; no longer drives hotkey numbering.
- **Scope:** camera-trap annotation first. Audio annotation has a similar setup but is deferred until the camera-trap pattern is validated.

## Open Questions (for planning phase)

- Should the popover also surface the "empty image" (`b`) and "star" (`s`) toggles, or keep those off-popover to avoid clutter?
- When a detection is already verified/corrected, should clicking it open the popover in a read-only state, or re-enable editing?
- Does "project-wide top 10" need to exclude rejected or deleted identifications? (Probably yes.)
- What happens for users viewing in a read-only role — popover should not show mutation actions at all.
- Does the popover interfere with the existing `h` "hide/show boxes" toggle — should it auto-dismiss on hide?
- Should the hotkey slot list be visible somewhere persistent (small legend in the toolbar) so users learn the mapping?

## Out of Scope

- User-pinned hotkey slots (considered and rejected for now — adds UI overhead).
- Changing the fundamental click-bbox-then-assign flow. "Paint-bucket" mode (select species first, click many boxes) is interesting but a separate initiative.
- Audio annotation UX.
- Mobile/touch optimization of the popover.

## Next Step

Run `/workflows:plan` to turn this into an implementation plan.
