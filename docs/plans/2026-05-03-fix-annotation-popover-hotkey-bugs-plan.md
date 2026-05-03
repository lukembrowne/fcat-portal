---
title: Annotation Popover — Esc, Last-Species Hotkey, Delete-then-Enter
type: fix
date: 2026-05-03
module: camera-trap
related_plan: docs/plans/2026-04-21-feat-annotation-contextual-picker-plan.md
---

# Annotation Popover — Esc, Last-Species Hotkey, Delete-then-Enter

## Overview

Three small UX fixes on the camera-trap species annotation page (`src/app/camera-trap/results/[id]/images/[imageId]/`) that all surfaced after the contextual picker shipped (`2026-04-21-feat-annotation-contextual-picker-plan.md`):

1. **Esc bug** — Esc inside the picker popover closes the popover **and** navigates back to the deployment gallery. User wants Esc to only close the popover so they can pick another bbox without leaving the image.
2. **Last-species hotkey** — Camera traps fire bursts of 3 photos, so the same species typically appears across all three. Today the user must press the same digit (or click the same row) every time. **Re-bind `0` to "repeat last assigned species"; reduce frecuentes from 10 slots (1-9, 0) to 9 slots (1-9).** Letters are off the table because the picker's typeahead would intercept them.
3. **Enter-after-delete bug** — After confirming "Eliminar" in the delete-bbox dialog, the same Enter keystroke also advances to the next image. User does not want that.

Bundling these three because they share the same files (`image-annotation-client.tsx`, `use-annotation-shortcuts.ts`, `annotation-picker-popover.tsx`, `annotation-help-panel.tsx`) and overlap in keydown-event handling logic — fixing them in one pass avoids two rounds of re-testing the keyboard model.

## Problem Analysis

### Bug 1 — Esc closes popover *and* leaves the page

**Wiring today:**

- `Popover` root (`image-annotation-client.tsx:491-499`) sets `onOpenChange={(next) => { if (!next) setSelectedBoxId(null); }}`. Radix's `<PopoverContent>` listens for Esc on `document` (via `@radix-ui/react-dismissable-layer`).
- `useAnnotationShortcuts` (`use-annotation-shortcuts.ts:74-81`) registers a global `keydown` listener on `window`:
  ```ts
  if (e.key === "Escape") {
    if (o.selectedDetectionId != null) { o.onDeselect?.(); return; }
    o.onEscapeBack?.(); return;   // <-- router.push back to results gallery
  }
  ```
- `optsRef.current` is refreshed in a no-deps `useEffect` (`use-annotation-shortcuts.ts:52-54`) so the global listener reads the latest props after every render.

**Mechanism of the bug:**

A single Esc dispatches one native `keydown` that bubbles `target → … → document → window`. Radix's `document` listener fires first and calls `onOpenChange(false)` → `setSelectedBoxId(null)`. State update is queued (React 18 batches even native handlers). Then the `window` listener fires, reads `optsRef.current.selectedDetectionId` — still the pre-update value — and calls `onDeselect()` (idempotent). React commits, popover unmounts.

Now press Esc **a second time** (or hold Esc through key-repeat — `e.repeat === true` at ~30 ms intervals). Radix is no longer mounted; only the `window` listener fires. `optsRef.current.selectedDetectionId` is now `null`, so the handler falls through to `onEscapeBack()` → `router.push(/camera-trap/results/${jobId})`. Goodbye image.

This is exactly what the user is hitting: an instinctive double-tap of Esc (or holding it slightly long) drops them back at the gallery.

### Bug 2 — No fast way to repeat the last-assigned species

The picker has 10 hotkey slots (1-9, 0) for project-wide most-frequent species (locked per page load). On a 3-photo burst the same species is assigned 3× in a row. With 10 frequent slots that's typically 1 keystroke per detection — fine — but for any species **outside** the top-10 the user has to type into the search every time, even when "the previous photo's species" is the obvious choice.

User considered re-binding `1` to "last species" and shifting frecuentes — push back on that, it sacrifices a stable, project-wide slot for a session-only convenience and breaks muscle memory.

User then proposed using a **letter hotkey** like `r`. That's also out — the picker's typeahead (`Command` from cmdk) auto-focuses on open and any letter you press lands in the search field. Intercepting `r` at the `Command`'s `onKeyDown` would prevent users from ever searching for species starting with R ("Rana", "Rhinoderma", etc.).

**Settled approach: re-bind `0` to "repeat last assigned species"; reduce frecuentes from top-10 to top-9.** Digits never collide with cmdk typeahead (the popover's `Command.onKeyDown` already intercepts all digits before they reach the input — see `annotation-picker-popover.tsx:182-200`). `0` is a logical choice because (a) it's already a one-key gesture, (b) it sits at the end of the row visually + on the keyboard, evoking "the special slot", (c) "repeat" fits the rhythm of the 3-photo burst better than the 10th-most-frequent-species ever did.

There is no existing `lastSpecies` state anywhere in `src/` (verified by grep). Per-image client (`ImageAnnotationClient`) unmounts on navigation, so anything stored only in component state would reset every arrow-key press. Need cross-image persistence within the session — `sessionStorage` keyed by jobId fits exactly.

### Bug 3 — Enter after Eliminar advances the image

**Wiring today:** The delete dialog at `image-annotation-client.tsx:619-665`:

```tsx
<DialogContent
  onOpenAutoFocus={(e) => { e.preventDefault(); deleteButtonRef.current?.focus(); }}
  onKeyDown={(e) => {
    if (e.key === "Delete" || e.key === "d" || e.key === "Enter") {
      e.preventDefault();   // ← only prevents default, NOT propagation
      handleConfirmDelete();
    }
  }}
>
```

The Eliminar `<Button>` also has `onClick={handleConfirmDelete}` (line 661).

**Mechanism:** When the dialog opens, focus jumps to the Eliminar button. The user presses Enter. Several things happen on the same native `keydown`:

1. The browser activates the focused button → `onClick` fires synchronously → `setDeleteDialogDetectionId(null)` queued.
2. React's synthetic `onKeyDown` on `<DialogContent>` matches Enter → `e.preventDefault()` + `handleConfirmDelete()` (no-op the second time, but no `stopPropagation()`).
3. The native event continues to bubble. `window`'s global keydown handler fires. Its guard reads `optsRef.current.isDialogOpen`. The ref is updated only **after** React commits the state change — so on this tick, `isDialogOpen` may still be `true` and the global Enter handler skips.

But two reproducible paths leak through:

- **Key repeat** — Holding Enter for ~500 ms produces a second keydown after React has committed. `isDialogOpen` is now `false`, the dialog has unmounted, and `onQuickVerifyAll()` fires → verify-and-advance.
- **Mouse-click confirm + immediate Enter** — User clicks Eliminar with the mouse, then taps Enter (e.g., while reading the next image). The dialog has already closed, `isDialogOpen` is `false`, and Enter is the global "verify all and advance" hotkey, so it advances. From the user's POV "Enter after confirming Eliminar advances" — both paths look the same.

Enter being the verify-and-advance hotkey is intended (see `SHORTCUTS` table at `use-annotation-shortcuts.ts:10`). The bug is that the *same* Enter keystroke serving as the dialog's confirm action also serves as the global advance hotkey.

## Proposed Solution

### Fix 1 — Esc only closes the popover; never navigates back

Two complementary changes:

**a) Global Esc handler skips when the popover is open.** Pass `isPickerOpen` into the shortcuts hook; when true, the global Esc handler returns early so Radix has sole ownership of the keystroke. This kills the "stale optsRef" race window for the closing keystroke.

**b) Drop `onEscapeBack` entirely.** No more router.push from Esc. The user already has a "Volver" link in the tools sidebar (`AnnotationToolsSidebar`); they don't need a keyboard escape hatch that surprises them. Spec-flow analysis (below) confirms there's no flow that *requires* Esc to leave the page.

After both changes, the Esc model becomes:
- Popover open → Esc closes popover (Radix). React commits, `selectedBoxId = null`. Done.
- Popover closed, bbox still selected (e.g. user toggled `h` to hide bboxes) → Esc deselects.
- Nothing selected → Esc is a no-op.

Update `SHORTCUTS` table and `annotation-help-panel.tsx` accordingly.

### Fix 2 — `0` hotkey + popover row for the last-assigned species

**Storage:** `sessionStorage` keyed `fcat:lastSpecies:{jobId}`. Read on `ImageAnnotationClient` mount, write on every successful `assignSpecies` (inside `handleSelectSpecies`). `sessionStorage` is per-tab and survives in-tab navigation, which is exactly the scope we want — opens in a new tab start fresh, hard reload starts fresh, but arrow-key-walking 200 photos keeps the value.

We also need the *species record* (not just the scientific name) so we can render the display label and pass it into `assignSpecies`. Look up via the `speciesMap` already built at `image-annotation-client.tsx:149-155`. Store only the scientific name in sessionStorage.

**Hotkey: `0`.** Free up by reducing frecuentes from top-10 to top-9. This requires:

- Change `getFrequentSpecies(null, 10)` to `getFrequentSpecies(null, 9)` at the page loader (`src/app/camera-trap/results/[id]/images/[imageId]/page.tsx`).
- Update `hotkeySlots` JSDoc on `ImageAnnotationClient` props (`image-annotation-client.tsx:55-59`) to reflect 9 slots.
- In `useAnnotationShortcuts`'s digit branch (`use-annotation-shortcuts.ts:177-191`), route `e.key === "0"` to `onAssignLastSpecies` (when a detection is selected) instead of `onAssignSpeciesByIndex(9)`.
- In the popover's `Command.onKeyDown` (`annotation-picker-popover.tsx:182-200`), same routing: digits 1-9 → `onAssignSpeciesByIndex`, digit 0 → `onAssignLastSpecies`.
- The popover's "Frecuentes" grid renders `hotkeySlots.map(...)` — naturally truncates to 9 since the array now has 9 items. Drop the `idx === 9 ? "0" : String(idx + 1)` ternary; the label is just `String(idx + 1)`.

**Popover affordance:** Add a "Última" row at the top of the popover (above "Frecuentes") when `lastSpecies` exists:

```
┌───────────────────────────────────────┐
│ Detección #2          [Sin verificar] │
├───────────────────────────────────────┤
│ Última                                │
│  [0]  Cuniculus paca                  │   ← click or `0` key
├───────────────────────────────────────┤
│ Frecuentes                            │
│  [1] Tapirus pinchaque  [2] Tayassu …│
│  ...                          [9] ...│
└───────────────────────────────────────┘
```

Hide the section if (a) no last species recorded yet, or (b) the last species is identical to the currently-assigned species for the selected bbox (showing it would be useless).

**Edge cases:**
- No last species yet → `0` is a no-op (silent, not an alert).
- Last species was deleted from the species table → fall back to no-op + `console.warn`. Re-fetch species list isn't needed; bad data clears next assignment.
- Image has no selected detection → `0` is a no-op (matches `1-9` behavior — global digit handler already requires `selectedDetectionId != null` to assign).
- User had been used to slot 10 (`0` = the 10th most-frequent species) → behavior changes. Document in commit message; the "10th frequent" was rarely the right choice anyway.

### Fix 3 — Enter to confirm Eliminar does not propagate

The minimal-blast-radius fix: in the delete-dialog's `onKeyDown`, after `handleConfirmDelete()`, also call `e.stopPropagation()` and `e.nativeEvent.stopImmediatePropagation()`. The first stops React's bubbling within the synthetic tree; the second stops the native event reaching the `window` listener, which is what triggers the unwanted advance.

That handles "user pressed Enter to confirm" correctly. It does **not** handle "user clicked Eliminar with the mouse and then pressed Enter" — but that scenario is Enter behaving as designed (global verify-and-advance hotkey). If the user wants to disable that too, the option is to tighten the global Enter to require a modifier (e.g., only `⌘+Enter` advances) — listed under Open Questions; not implementing by default.

Also add `e.repeat` guard at the global Enter branch to suppress key-repeat advances:

```ts
case "Enter":
  if (!hasModifier && !o.isDialogOpen && !e.repeat) {
    e.preventDefault();
    o.onQuickVerifyAll?.();
  }
  break;
```

This guards the secondary leak path (held-Enter through dialog close).

## Technical Approach

### Files Touched

| File | Change |
|------|--------|
| `src/hooks/use-annotation-shortcuts.ts` | Add `isPickerOpen` and `onAssignLastSpecies` opts; early-return Esc when picker open; remove `onEscapeBack`; route digit `0` to `onAssignLastSpecies` (was index 9); add `e.repeat` guard on Enter; update `SHORTCUTS`. |
| `src/hooks/use-annotation-picker.ts` | No change (re-uses existing `open` field). |
| `src/components/annotation-picker-popover.tsx` | Add "Última" row above "Frecuentes" when `lastSpecies` differs from current; route digit `0` in `Command.onKeyDown` to `onAssignLastSpecies`; render hotkey badges 1-9 only (no more `0` badge in the grid); new props `lastSpecies: Species \| null`, `onAssignLastSpecies: () => void`. |
| `src/app/camera-trap/results/[id]/images/[imageId]/image-annotation-client.tsx` | Add `lastSpeciesName` state with sessionStorage hydration; write inside `handleSelectSpecies` on success; pass `isPickerOpen={picker.open}` and the last-species props through; drop `onEscapeBack` argument; on the delete dialog's `onKeyDown` add `stopPropagation` + `stopImmediatePropagation` after `handleConfirmDelete`. |
| `src/app/camera-trap/results/[id]/images/[imageId]/page.tsx` | Change `getFrequentSpecies(null, 10)` to `getFrequentSpecies(null, 9)`. |
| `src/components/annotation-help-panel.tsx` | "1-9" instead of "1-0" for frecuentes; add row "0 — Repetir última especie"; remove "Esc → volver" wording; tweak workflow tip. |

### Sequence Diagrams

**Bug 1 fix — Esc with picker open**

```
keydown(Esc) ──► document listener (Radix dismissable layer)
                    └─► onOpenChange(false)
                          └─► setSelectedBoxId(null)
              ──► window listener (useAnnotationShortcuts)
                    └─► early return because isPickerOpen=true
React commits → picker.open = false → popover unmounts
(no onEscapeBack call anywhere)
```

**Bug 3 fix — Enter inside delete dialog**

```
keydown(Enter) ──► focused <Button> default activation
                       └─► onClick → handleConfirmDelete
                             └─► setDeleteDialogDetectionId(null)
                ──► React onKeyDown on <DialogContent>
                       ├─► e.preventDefault()
                       ├─► e.stopPropagation()
                       ├─► e.nativeEvent.stopImmediatePropagation()  ← stops window listener
                       └─► handleConfirmDelete (no-op via guard)
window listener never fires
```

### Pseudocode — `image-annotation-client.tsx`

```tsx
// Hydrate / persist last-assigned species, scoped per job in sessionStorage.
const STORAGE_KEY = `fcat:lastSpecies:${jobId}`;
const [lastSpeciesName, setLastSpeciesName] = useState<string | null>(() => {
  if (typeof window === "undefined") return null;
  try { return window.sessionStorage.getItem(STORAGE_KEY); } catch { return null; }
});

const lastSpecies = useMemo(
  () => (lastSpeciesName ? speciesMap.get(lastSpeciesName) ?? null : null),
  [lastSpeciesName, speciesMap]
);

const handleSelectSpecies = useCallback((scientificName: string) => {
  if (!selectedDetection) return;
  startTransition(async () => {
    const result = await assignSpecies(selectedDetection.id, scientificName);
    if (result.success) {
      setLastSpeciesName(scientificName);
      try { window.sessionStorage.setItem(STORAGE_KEY, scientificName); } catch {}
      refresh();
    } else {
      console.error("assignSpecies failed:", result.error);
      alert(result.error);
    }
  });
}, [selectedDetection, refresh, jobId]);

const handleAssignLastSpecies = useCallback(() => {
  if (!lastSpecies || !selectedDetection) return;
  const current = selectedDetection.identification?.correctedSpecies
    ?? selectedDetection.identification?.species;
  if (current === lastSpecies.scientificName) return;
  handleSelectSpecies(lastSpecies.scientificName);
}, [lastSpecies, selectedDetection, handleSelectSpecies]);

// Wire into shortcuts:
useAnnotationShortcuts({
  ...,
  isPickerOpen: picker.open,
  onAssignLastSpecies: canEdit ? handleAssignLastSpecies : undefined,
  // onEscapeBack removed
});

// Wire into popover:
<AnnotationPickerPopover
  ...
  lastSpecies={lastSpecies}
  onAssignLastSpecies={handleAssignLastSpecies}
/>

// Delete dialog onKeyDown:
onKeyDown={(e) => {
  if (e.key === "Delete" || e.key === "d" || e.key === "Enter") {
    e.preventDefault();
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();
    handleConfirmDelete();
  }
}}
```

### Pseudocode — `use-annotation-shortcuts.ts`

```ts
interface AnnotationShortcutOptions {
  // ... existing
  isPickerOpen?: boolean;
  onAssignLastSpecies?: () => void;
  // onEscapeBack removed
}

// New SHORTCUTS table entries:
{ key: "1-9", description: "Seleccionar detección / asignar especie frecuente", category: "annotation" },
{ key: "0", description: "Repetir última especie asignada", category: "annotation" },
{ key: "Esc", description: "Cerrar selector / deseleccionar", category: "navigation" },
// Enter row unchanged.

// In handler:
if (e.key === "Escape") {
  if (o.isPickerOpen) return;        // Radix owns it
  if (o.selectedDetectionId != null) { o.onDeselect?.(); return; }
  return;                             // no more onEscapeBack
}

case "Enter":
  if (!hasModifier && !o.isDialogOpen && !e.repeat) {
    e.preventDefault();
    o.onQuickVerifyAll?.();
  }
  break;

// Digit branch:
default:
  if (!hasModifier && /^[0-9]$/.test(e.key)) {
    if (o.selectedDetectionId != null) {
      e.preventDefault();
      if (e.key === "0") {
        o.onAssignLastSpecies?.();           // ← new
      } else {
        const index = parseInt(e.key, 10) - 1;  // 1-9 → 0-8
        o.onAssignSpeciesByIndex?.(index);
      }
    } else if (/^[1-9]$/.test(e.key)) {
      const index = parseInt(e.key, 10) - 1;
      if (o.detectionCount && index < o.detectionCount) {
        e.preventDefault();
        o.onSelectDetection?.(index);
      }
    }
  }
```

### Pseudocode — `annotation-picker-popover.tsx`

```tsx
interface AnnotationPickerPopoverProps {
  // ... existing
  lastSpecies: Species | null;
  onAssignLastSpecies: () => void;
}

// New section above "Frecuentes":
{lastSpecies && lastSpecies.scientificName !== currentSpecies && (
  <div className="px-2 py-2 border-b">
    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider px-1 pb-1">
      Última
    </p>
    <button
      type="button"
      disabled={!canEdit}
      onClick={onAssignLastSpecies}
      title={`${lastSpecies.scientificName} — Repetir (0)`}
      className="w-full text-left px-1.5 py-1 rounded text-xs flex items-center gap-1.5 min-w-0 transition-colors hover:bg-accent cursor-pointer"
    >
      <Badge variant="outline" className="text-[10px] font-mono w-4 h-4 p-0 flex items-center justify-center shrink-0">0</Badge>
      <span className="truncate">{displayName(lastSpecies, nameDisplay)}</span>
    </button>
  </div>
)}

// Frecuentes grid: keyLabel is just String(idx + 1) now.
// hotkeySlots will be length 9 from the server (page passes getFrequentSpecies(null, 9)).
{hotkeySlots.map((sp, idx) => {
  const keyLabel = String(idx + 1);  // 1..9
  ...
})}

// Command.onKeyDown — route 0 to last species:
onKeyDown={(e) => {
  if (canEdit && !e.metaKey && !e.ctrlKey && !e.altKey && /^[0-9]$/.test(e.key)) {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "0") {
      onAssignLastSpecies();
    } else {
      const index = parseInt(e.key, 10) - 1;
      if (index < hotkeySlots.length) onAssignSpeciesByIndex(index);
    }
  }
}}
```

## SpecFlow Analysis (manual)

User flow walk-through:

| Flow | Today | After fix |
|------|-------|-----------|
| Click bbox → press Esc | popover closes, bbox deselected, then if user taps again → router.push to gallery | popover closes, bbox deselected. Second Esc is a no-op. |
| Click bbox → click outside picker | popover closes (`onOpenChange(false)`), bbox deselected | unchanged |
| Click bbox → click another bbox | first deselected, second selected, popover anchor moves | unchanged |
| Burst of 3 photos, same species in all 3 | press digit 3× | press digit on 1st, then `0` on 2nd and 3rd; or click "Última" row |
| First image of session (no last species) | n/a | `0` does nothing; "Última" row hidden |
| Press `d` to open delete dialog → press Enter | dialog confirms + advances image | dialog confirms; image stays |
| Press `d` → click "Eliminar" with mouse → press Enter | image advances (Enter is global verify-and-advance hotkey) | image advances (still — same global hotkey behavior). See Open Questions. |
| Read-only viewer presses `0` | n/a | no-op (gated by `canEdit`) |
| `0` typed into search input with no detection selected (popover closed) | global digit handler returns (no detection → only 1-9 select detections) | unchanged — `0` requires a detection to be selected to do anything |
| Last species was deleted from species table | n/a | `0` is no-op + console.warn; row hidden |
| Last species was the 10th frequent species users were used to pressing `0` for | press `0` → assign that species | press `0` → assign last species (which on first press of session is... whatever was last assigned previously OR nothing). One-session retraining. |

Edge cases caught:
- Hydration mismatch on the sessionStorage read (use `useState(() => …)` initializer + `typeof window !== "undefined"` guard).
- Two windows of the same job stay in sync only via reload (acceptable — sessionStorage is per-tab by design).
- Switching between different jobs in the same tab → each job has its own STORAGE_KEY, so they don't collide.

## Acceptance Criteria

- [x] **Esc** with picker open closes only the picker; arrow-key navigation and a second Esc keystroke do **not** route back to the deployment gallery. *(global handler early-returns when `isPickerOpen`; `onEscapeBack` removed)*
- [x] **Esc** with no picker open and no detection selected is a no-op (no navigation, no console errors). *(handler returns without calling anything)*
- [x] Pressing **`0`** with a detection selected assigns the species most recently assigned in this session (any image of the same job). No-op when no last species exists.
- [x] The popover renders an "Última" row at the top showing the last-assigned species when one exists. Per user decision, the row shows even when the species matches the current bbox (with a check + disabled state). Clicking the row assigns the species.
- [x] The popover's "Frecuentes" grid renders 9 entries (slots 1-9). Hotkey badges read `1` through `9`; no `0` badge inside Frecuentes.
- [x] sessionStorage key `fcat:lastSpecies:{jobId}` is written on every successful assignment and read on `ImageAnnotationClient` mount; values survive arrow-key navigation, are cleared on tab close.
- [x] Page loader calls `getFrequentSpecies(null, 9)` (was 10). Two embedded callers in `actions.ts` updated as well.
- [x] Help panel reflects: "1-9 frecuente", "0 repetir última", and removes "Esc volver".
- [x] Pressing **Enter** to confirm the delete-bbox dialog deletes the detection but does **not** advance to the next image. *(`stopPropagation` + `nativeEvent.stopImmediatePropagation` in dialog onKeyDown)*
- [x] Holding **Enter** through the dialog's close (key repeat) does not advance. *(`!e.repeat` guard added on global Enter)*
- [x] Pressing Enter on an image with no open dialog still verifies-and-advances (existing global hotkey unchanged).
- [x] Read-only users see the "Última" row but `0` and clicks on it are no-ops. *(`canEdit` gate on hotkey + button disabled)*
- [x] All existing shortcuts (←/→, 1-9, d, b, s, i, t, h, z, Esc) still work.

## Quality Gates

- [x] `npm run test:run` passes (626/627 — sole failure is the pre-existing `updateSpecies cascades` regression already documented in the picker plan; unrelated to these changes).
- [x] `npm run lint` produces no new errors in touched files (5 pre-existing warnings, 0 errors).
- [ ] Manual smoke test in the browser:
  - Open an image with detections → click bbox → press Esc → popover closes, **stays on the image** (verify URL unchanged).
  - Press Esc again → no-op.
  - Burst of 3 photos: assign species on photo 1 → arrow-right → press `0` → species assigned. Repeat on photo 3.
  - Verify "Última" row appears at the top of the popover after the first assignment, and that `0` while in cmdk search field still routes to last-species (not "search 0").
  - Verify pressing digit `3` while typing in the search field still assigns frecuente #3 (existing digit interception behavior is preserved).
  - Delete a bbox via the dialog using Enter → image stays.
  - Click Eliminar with the mouse → image stays (no auto-advance from the click).
  - All previous hotkeys (1-9, d, b, s, i, t, h, z, ←/→) still behave as before.
- [ ] `docker compose build` succeeds (run before deploy).

## Dependencies & Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Removing `onEscapeBack` strands users who relied on Esc to leave the page | Low | "Volver" button in `AnnotationToolsSidebar` covers it; user explicitly asked for this. |
| Users who built muscle memory for "0 = 10th frequent species" get confused | Medium | The 10th slot was rarely the right answer (the most useful frequents are top-3 to top-5). Note the change in commit message + help panel. |
| sessionStorage write throws in private browsing | Low | Wrap in `try/catch`; in-memory `useState` still works for the session. |
| `e.nativeEvent.stopImmediatePropagation()` in the dialog onKeyDown breaks some other listener attached to document for keydown | Low | Only Radix's dismissable-layer listener is on document for the open dialog; it has already run by the time we propagate. Verified in dev tools. |
| Last-assigned species was a typo and the user re-uses it via `0` | Low | They'll see "Última: Wrong species" in the popover before pressing `0`; obvious to correct. |
| Two browser tabs open on different images of same job → "last species" diverges | Acceptable | sessionStorage is per-tab by design; users don't use multi-tab annotation workflows here. |
| `getFrequentSpecies(null, 9)` returns 9 rows; popover assumes index < 9 — but old hardcoded `idx === 9 ? "0"` ternary is now dead code | Low | Remove the ternary in the same diff. |

## Open Questions (defer to user decision)

1. **Should mouse-clicking "Eliminar" suppress the next Enter from advancing?** Today: clicking the button closes the dialog; if the user then taps Enter, it advances (Enter is the global verify-and-advance hotkey, working as designed). The proposed fix only addresses the Enter-to-confirm path. If the user wants the mouse-click path also "quiet for a beat," we could add a 200 ms post-dialog grace period that suppresses the global Enter — but that introduces lag for power users. **Recommendation: leave as-is; revisit if the user reports it.**
2. **Should "Última" show the species even if it matches the current identification?** The current proposal hides the row to avoid clutter, but some users might want a visual confirmation. Either is one line of code.
3. **Should `0` while no detection is selected do anything?** Currently it's a no-op (matches 1-9 behavior, which selects detection by index, but 0 has no index). Could pop-and-assign the last-detection-on-the-image — probably overreach; leave as no-op.

## Out of Scope

- Audio annotation page Esc/Enter behavior (different hook: `use-audio-annotation-shortcuts.ts`).
- Multi-bbox bulk assignment (paint-bucket mode).
- Persisting last species across browser sessions / users / tabs.
- Re-binding `1` to "last species" (rejected; conflicts with picker plan's intent).

## References

- Picker plan: `docs/plans/2026-04-21-feat-annotation-contextual-picker-plan.md`
- Annotation client: `src/app/camera-trap/results/[id]/images/[imageId]/image-annotation-client.tsx:125-200, :318-336, :458-476, :491-499, :619-665`
- Page loader: `src/app/camera-trap/results/[id]/images/[imageId]/page.tsx` (search for `getFrequentSpecies`)
- Shortcut hook: `src/hooks/use-annotation-shortcuts.ts:5-18, :52-54, :74-81, :117-192`
- Picker popover: `src/components/annotation-picker-popover.tsx:140-176, :178-200`
- Picker hook: `src/hooks/use-annotation-picker.ts:23-50`
- Help panel: `src/components/annotation-help-panel.tsx:46-100`
- Radix dismissable-layer (Esc on document): https://github.com/radix-ui/primitives/tree/main/packages/react/dismissable-layer

## Next Step

Run `/workflows:work` to begin implementation. Recommended order: Fix 1 (Esc) → Fix 3 (Enter+delete) → Fix 2 (last species + popover row + help). Each is a small, independently testable diff.
