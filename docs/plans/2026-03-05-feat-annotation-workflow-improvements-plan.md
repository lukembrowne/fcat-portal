---
title: "feat: Annotation Workflow Improvements"
type: feat
date: 2026-03-05
---

# feat: Annotation Workflow Improvements

## Overview

Three targeted improvements to the camera trap (and audio) annotation workflow: auto-focus species search on detection selection, frequency-based stable hotkeys ("Frecuentes"), and visual group separators in the species sidebar.

**Brainstorm:** `docs/brainstorms/2026-03-05-annotation-workflow-improvements-brainstorm.md`

## Problem Statement

1. After drawing a bbox or clicking a detection, users must manually click the "Buscar especie..." search bar before typing — a friction point repeated hundreds of times per annotation session.
2. The "Recientes" hotkeys shift constantly (ordered by most-recently-verified), so users never build muscle memory for key assignments.
3. Species groups (Mamiferos, Aves, etc.) blend together visually — the headers are the same size/weight as surrounding text with no dividers.

## Proposed Solution

### 1. Auto-focus species search on detection selection

Add a `useEffect` in `ImageAnnotationClient` that watches `selectedBoxId`:
- When `selectedBoxId` transitions to a non-null value → `searchInputRef.current?.focus()`
- When `selectedBoxId` transitions to `null` → `searchInputRef.current?.blur()`

This automatically covers all selection paths (bbox click, card click, number key, draw complete) without touching individual handlers. The `searchInputRef` is already created and threaded through to `SpeciesSidebar`.

**Edge case — switching detections:** When clicking detection B while detection A is selected, `selectedBoxId` changes from A to B (never null). The search query should be **preserved** (not cleared) so users can apply the same species filter across multiple detections. Only a full deselect (Escape or toggle-off) clears the search.

**Edge case — mobile/touch:** Auto-focus would trigger virtual keyboards on tablets. For now, accept this behavior. If it becomes a problem in the field, a future PR can detect touch devices via `'ontouchstart' in window` and skip the focus.

### 2. Frequency-based "Frecuentes" species list

Replace `getRecentSpecies()` with `getFrequentSpecies()` — a single query that JOINs identifications → detections → images → species, groups by `correctedSpecies`, and orders by `COUNT(*) DESC`.

**Key change:** The current two-query pattern (first get names, then fetch species rows) has an existing bug where the second query loses ordering. The new implementation uses a single query with JOIN to return full `Species` rows already in frequency order.

Rename throughout:
- Function: `getRecentSpecies` → `getFrequentSpecies`
- Props: `recentSpecies` → `frequentSpecies` in `ImageAnnotationClientProps`, `SpeciesSidebarProps`
- UI label: "Recientes" → "Frecuentes"

**Cold start:** Empty deployments show no "Frecuentes" section. Once annotations begin, the section appears. Hotkey assignments shift once at that point — acceptable since frequency ordering is stable thereafter.

### 3. Bold group headers with divider lines

Upgrade group headers in the species sidebar:
- Current: `text-xs font-medium text-muted-foreground px-2 py-1`
- New: `text-xs font-semibold text-muted-foreground uppercase tracking-wider px-2 py-1`
- Add `border-t border-border mt-2 pt-2` to each group wrapper `<div>` (skip border on first group when no Frecuentes section is visible; always show border on first group when Frecuentes is above it)

## Acceptance Criteria

- [ ] Selecting a detection (any method) auto-focuses the species search input
- [ ] Deselecting a detection blurs the search input (search text cleared only on full deselect, preserved on detection switch)
- [ ] Species hotkeys 1-9/0 map to frequency-ordered "Frecuentes" list (most identified species first)
- [ ] "Frecuentes" ordering is stable within a session (doesn't shift on each assignment)
- [ ] Sidebar header reads "Frecuentes" instead of "Recientes"
- [ ] Species groups have bold uppercase headers with divider lines between them
- [ ] Returned species from `getFrequentSpecies` are in correct descending count order (fixes existing ordering bug)
- [ ] Audio annotation workflow updated consistently (same rename, same behavior)
- [ ] Existing keyboard shortcuts continue to work (number keys, Escape levels, arrow keys, etc.)

## Implementation Plan

### Phase 1: Frequency query (backend)

**File: `src/app/camera-trap/actions.ts`**

Replace `getRecentSpecies` (lines ~3234-3263) with `getFrequentSpecies`:

```typescript
export async function getFrequentSpecies(
  deploymentId: number,
  limit = 8
): Promise<ActionResult<Species[]>> {
  await requirePermission("camera-trap", "viewer");

  // Single query: JOIN to species table, GROUP BY, ORDER BY count
  const rows = await db
    .select({
      id: species.id,
      scientificName: species.scientificName,
      commonName: species.commonName,
      spanishName: species.spanishName,
      type: species.type,
      taxonomicRank: species.taxonomicRank,
      count: sql<number>`count(*)`.as("count"),
    })
    .from(identifications)
    .innerJoin(detections, eq(detections.id, identifications.detectionId))
    .innerJoin(images, eq(images.id, detections.imageId))
    .innerJoin(species, eq(species.scientificName, identifications.correctedSpecies))
    .where(
      and(
        eq(images.deploymentId, deploymentId),
        isNotNull(identifications.correctedSpecies)
      )
    )
    .groupBy(identifications.correctedSpecies)
    .orderBy(desc(sql`count(*)`))
    .limit(limit);

  // Map to Species type (drop the count field)
  const result: Species[] = rows.map(({ count, ...s }) => s);
  return { success: true, data: result };
}
```

Keep the old `getRecentSpecies` as a deprecated alias pointing to `getFrequentSpecies` if the audio module needs a separate migration timeline (check below).

### Phase 2: Update callers

**File: `src/app/camera-trap/results/[id]/images/[imageId]/page.tsx`**
- Import `getFrequentSpecies` instead of `getRecentSpecies`
- Call `getFrequentSpecies(image.deploymentId)`
- Pass as `frequentSpecies={...}` prop

**File: `src/app/audio/[id]/annotate/[fileId]/page.tsx`**
- Same rename: import and call `getFrequentSpecies`
- Pass as `frequentSpecies={...}` prop

**File: `src/app/camera-trap/results/[id]/images/[imageId]/image-annotation-client.tsx`**
- Rename prop in `ImageAnnotationClientProps`: `recentSpecies` → `frequentSpecies`
- Update all references

**File: `src/app/audio/[id]/annotate/[fileId]/annotation-client.tsx`**
- Same prop rename

### Phase 3: Auto-focus (frontend)

**File: `src/app/camera-trap/results/[id]/images/[imageId]/image-annotation-client.tsx`**

Add after the `selectedDetection` derivation (~line 160):

```typescript
// Auto-focus species search when a detection is selected
useEffect(() => {
  if (selectedBoxId !== null) {
    searchInputRef.current?.focus();
  } else {
    searchInputRef.current?.blur();
  }
}, [selectedBoxId]);
```

**File: `src/app/audio/[id]/annotate/[fileId]/annotation-client.tsx`**
- Add the same `useEffect` if it has a `searchInputRef` (verify during implementation)

### Phase 4: Sidebar UI updates

**File: `src/components/species-sidebar.tsx`**

1. **Rename prop and references:** `recentSpecies` → `frequentSpecies` in props interface, component body, and `getVisibleSpecies` export.

2. **Rename section header:** "Recientes" → "Frecuentes" (line ~154)

3. **Bold group headers with dividers:** Update the `grouped.map()` rendering:

```tsx
{grouped.map(([type, items], index) => (
  <div key={type} className={cn(
    "mb-1",
    (index > 0 || showFrequent) && "border-t border-border mt-2 pt-2"
  )}>
    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-2 py-1">
      {TYPE_LABELS[type] || type}
    </p>
    {/* species rows unchanged */}
  </div>
))}
```

Where `showFrequent` replaces `showRecent` (the boolean for whether the Frecuentes section is visible).

4. **Frecuentes section header:** Update to match new styling but without `border-t` (it's the first section):

```tsx
<p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-2 py-1">
  Frecuentes
</p>
```

### Phase 5: Verify & test

- [ ] Manual test: draw bbox → search auto-focuses → type species name → hotkey assigns
- [ ] Manual test: click existing detection → search focuses → Escape clears and blurs
- [ ] Manual test: switch detection A → B → search stays focused, query preserved
- [ ] Manual test: verify hotkey order matches frequency (most-used species = key 1)
- [ ] Manual test: visual check of group headers and dividers with/without Frecuentes section
- [ ] Manual test: audio annotation view has same behavior
- [ ] Run `npm run test:run` — ensure no regressions
- [ ] Run `npm run build` — ensure no type errors from renames

## Files Modified

| File | Changes |
|------|---------|
| `src/app/camera-trap/actions.ts` | Replace `getRecentSpecies` with `getFrequentSpecies` (single JOIN query, frequency ordering) |
| `src/app/camera-trap/results/[id]/images/[imageId]/page.tsx` | Update import, call, and prop name |
| `src/app/camera-trap/results/[id]/images/[imageId]/image-annotation-client.tsx` | Rename prop, add auto-focus `useEffect` |
| `src/app/audio/[id]/annotate/[fileId]/page.tsx` | Update import, call, and prop name |
| `src/app/audio/[id]/annotate/[fileId]/annotation-client.tsx` | Rename prop, add auto-focus `useEffect` |
| `src/components/species-sidebar.tsx` | Rename prop/label, bold headers + dividers |
| `src/components/species-combobox.tsx` | Rename if it references `recentSpecies` (check) |
| `src/components/annotation-toolbar.tsx` | Rename if it references `recentSpecies` (check) |

## References

- Brainstorm: `docs/brainstorms/2026-03-05-annotation-workflow-improvements-brainstorm.md`
- Current `getRecentSpecies`: `src/app/camera-trap/actions.ts:3234`
- Species sidebar: `src/components/species-sidebar.tsx`
- Annotation shortcuts: `src/hooks/use-annotation-shortcuts.ts`
- Main annotation client: `src/app/camera-trap/results/[id]/images/[imageId]/image-annotation-client.tsx`
