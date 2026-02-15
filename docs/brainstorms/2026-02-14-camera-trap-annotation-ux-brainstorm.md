# Camera Trap Annotation & Verification UX Improvements

**Date:** 2026-02-14
**Status:** Brainstorm Complete — Ready for Planning

## What We're Building

A comprehensive overhaul of the camera trap annotation and verification experience to make it faster, more intuitive, and field-team friendly. The core goal: reviewing 100s of model predictions per deployment should feel fast and natural, even for non-technical users.

### Feature Summary

1. **Interactive bbox ↔ annotation sync** — Clicking a bounding box on the image highlights the corresponding annotation card, and vice versa. Delete/Backspace rejects the selected annotation.
2. **Bbox editing & creation** — Simple click-drag to create new bounding boxes for missed detections. Drag corners/edges to resize existing boxes.
3. **Species/taxa database** — New SQLite table for species management with English common name, Spanish common name, scientific name, taxonomic rank, and type (mammal/bird/system/human).
4. **Species management UI** — Admin interface under `/camera-trap` for editors to add, edit, and remove species. Starting data imported from existing `western_ecuador.csv` (~64 entries). Spanish names added manually over time.
5. **Typeahead species picker** — Combobox replacing the flat dropdown for species correction. Shows recent species at top, then grouped by type (mammal/bird), searchable across all name variants (Spanish, English, scientific).
6. **Taxonomic rank tracking** — Each species entry has a rank tag (Species, Genus, Family, Order, Class) visible in the picker. The flat list includes entries at all levels (e.g., "Bird (unidentified)" at Class, "Rodentia" at Order, "Dasyprocta punctata" at Species).
7. **Name display toggle** — Cycle between scientific, English, and Spanish names on annotations. Sticky user preference (persists across sessions) plus a quick toggle on the detail page and keyboard shortcut (`n` to cycle).
8. **Quick verify hotkey** — Press Enter when there's only one detection and it looks correct → verifies and advances to next image.
9. **Floating shortcut card** — Toggleable with `?` key, shows all keyboard shortcuts and brief workflow guidance. Persistent in corner, unobtrusive.
10. **Table overflow fixes** — Fix formatting issues where annotation tables/cards extend beyond their containers.

## Why This Approach

**Phased Enhancement (4 phases, each independently shippable):**

- **Phase 1 — Species Foundation:** New `species` DB table, CSV import, management UI under `/camera-trap`, typeahead species picker replacing flat dropdown
- **Phase 2 — Bbox Interaction:** Click-to-highlight sync between image and annotation panel, simple draw/resize for new and existing boxes, Delete/Backspace to reject selected annotation
- **Phase 3 — Workflow Speed:** Enter to quick-verify single detections, floating shortcut card (`?`), name display toggle with sticky preference + quick toggle
- **Phase 4 — Polish:** Fix table overflow issues, responsive layout, rank tags in species picker, recent species tracking per deployment

Each phase delivers standalone value. Field team can start using improvements immediately rather than waiting for everything.

## Key Decisions

| Decision | Choice | Reasoning |
|----------|--------|-----------|
| Bbox editing precision | Simple draw/resize (click-drag corners/edges) | Field team doesn't need pixel-perfect tools; camera trap boxes are approximate |
| Species picker UX | Combo: recent species + grouped by type + typeahead across all name variants | Optimizes for both common cases (recent species) and discovery (search/browse) |
| Taxonomic hierarchy | Flat list with rank label tags | Simpler than drill-down, sufficient for mixed-resolution IDs |
| Spanish name population | Manual entry via admin UI over time | Pragmatic — team adds names as needed rather than pre-populating from uncertain sources |
| Species management location | Under `/camera-trap` for editors | Accessible to the field team who uses it daily, not buried in global admin |
| Help guide format | Floating shortcut card toggled with `?` | Always available, unobtrusive, simpler than walkthrough tutorials |
| Name display toggle | Sticky user preference + quick toggle on page | Best of both — set once and forget, or switch quickly when needed |
| Approach | Phased Enhancement (4 phases) | Each phase is independently shippable and testable; lower risk than big bang |

## Current State

**What exists today:**
- SVG-based bbox overlay with click-to-select and color coding by species
- Annotation toolbar with verify/reject/correct buttons per detection
- Keyboard shortcuts: `v` verify, `r` reject, arrows for image navigation
- Flat species dropdown for corrections (no search, no grouping)
- Verification statuses: unverified, verified, rejected, corrected
- Bulk verify by confidence threshold

**What's missing:**
- No bbox drawing or editing (display only)
- No annotation ↔ bbox highlight sync (partially works — selection exists but no visual emphasis in annotation cards)
- No species database (species come directly from ML model output strings)
- No Spanish names, no taxonomic rank tracking
- No quick-verify shortcut for single detections
- No help guide or shortcut reference
- Table overflow issues on some screen sizes

## Species Data Source

Starting CSV: `western_ecuador.csv` with ~64 entries
- Fields: `species_id`, `common_name`, `scientific_name`, `type`
- Types: mammal, bird, system (unknown/blank/vehicle), human
- Mixed taxonomic levels: some at species, some at genus/family/order/class
- No Spanish names yet (to be added manually via admin UI)
- No explicit taxonomic rank field (to be added in DB table)

## Open Questions

1. **Undo/revision history** — Should verification changes be undoable? Currently there's no undo. Could add later if needed.
2. **Multi-image batch operations** — Currently single-image verification only. Batch operations could come after core UX is solid.
3. **Species list versioning** — When the species list changes, how does that affect existing identifications? Probably fine since corrections store species name as string.
4. **Offline considerations** — Field team connectivity may vary. Worth considering if any of this needs offline support (probably not for v1).

## Keyboard Shortcuts (Planned)

| Key | Action |
|-----|--------|
| `←` / `→` | Previous / Next image |
| `v` | Verify selected detection |
| `r` | Reject selected detection |
| `Enter` | Quick verify (single detection only) + advance |
| `Delete` / `Backspace` | Reject selected detection |
| `?` | Toggle shortcut help card |
| `n` | Cycle name display (Scientific → English → Spanish) |
| `Escape` | Deselect / cancel current action |
| `1-9` | Select detection by number (if multiple) |

## Next Steps

Run `/workflows:plan` to create detailed implementation plan for Phase 1 (Species Foundation).
