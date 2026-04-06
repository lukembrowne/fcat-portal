---
title: Annotation navigation must respect active gallery filters
type: fix
date: 2026-04-06
---

# Annotation navigation must respect active gallery filters

## Overview

When a user filters the deployment gallery (by species, verification status, starred, blanks, confidence, etc.) and then clicks an image to open the annotation overlay, the **Anterior/Siguiente** buttons and the keyboard navigation shortcuts cycle through **all** images in the job, not just the filtered subset. The same is true for the "verify and advance" flow — it jumps to the next unverified image across the whole job.

This makes the filter useless for actual review workflows ("show me all images of *Cuniculus paca* and let me walk through them"). The user expects: filter narrows the working set; navigation stays inside that set.

## Problem Statement

### Reproduction steps

1. Open a processed deployment, e.g. `/camera-trap/<id>`.
2. In the **Filtros** sidebar, click a species (e.g. *Dasyprocta punctata*) so the grid shows only ~12 images of that species.
3. Click any one of those images. Annotation overlay opens.
4. Press the **Siguiente** button (or `→` / `n` keyboard shortcut, or click *Verificar* which calls `verifyAndAdvance`).
5. **Bug:** the next image shown is the next image in the **full** job order, almost always something with no *Dasyprocta* in it.
6. **Expected:** the next image is the next *Dasyprocta* image in the filtered grid.

The header counter (`X de Y`) also shows totals over the unfiltered job (e.g. `47 de 1830`) instead of the filtered position (e.g. `3 de 12`).

### Root cause

Filter state lives client-only inside `ResultsClient` and is never propagated to the navigation layer:

- `src/app/camera-trap/results/[id]/results-client.tsx:72` — `filteredImages = useMemo(...)` derives the visible grid from `selectedSpecies`, `confidenceRange`, `verificationFilter`, `showEmpty`, `showStarredOnly`, `showBlanksOnly`. State is local; nothing is lifted.
- `src/app/camera-trap/[id]/deployment-gallery-client.tsx:39` — `loadImage(imageId)` simply calls `getImageAnnotationData(imageId, jobId)` with no awareness of the active filter.
- `src/app/camera-trap/actions.ts:3075` — `getImageAnnotationData` calls `getJobImageIds(jobId)` (line 3078), which selects **every** image in the job ordered by timestamp/filename. `prevImageId`, `nextImageId`, `currentIndex`, `totalImages` are computed against that unfiltered list.
- `src/app/camera-trap/actions.ts:4026` — `verifyAndAdvance` SQL-walks all images in the job (`forward` query at line 4059, `wrapped` at line 4080) looking for the next unverified record. It never sees the client-side filter.
- `src/app/camera-trap/results/[id]/images/[imageId]/image-annotation-client.tsx:397` — keyboard `onNext` / `onPrev` and the `verifyAndAdvance` call (line 207) all consume those stale IDs.

## Proposed Solution

Make the **filtered, ordered image-ID list** the single source of truth for navigation while the annotation overlay is open. Snapshot it at the moment the user clicks an image and reuse it for every prev/next/verify-and-advance call until they close the overlay.

This fix automatically covers **every** filter in the sidebar (species, confidence range, verification status, show-empty toggle, starred-only, blanks-only) and any combination of them, because all filters flow through the same `filteredImages` useMemo. Any future filter added to that same memo inherits the fix.

### High-level approach

1. **Lift filtered IDs out of `ResultsClient`** via a new `onFilteredIdsChange?: (ids: number[]) => void` callback prop. `ResultsClient` keeps owning filter state (no rewrite of the filter UI), but emits the current ordered ID list whenever `filteredImages` changes.
2. **`DeploymentGalleryClient` holds a ref** to the latest filtered ID list. When `loadImage` is called, it snapshots the current list into a piece of state (`navigationIds`). The snapshot is frozen for the duration of the overlay session.
3. **`getImageAnnotationData` accepts an optional `navigationIds: number[]`** parameter. When provided, it uses those for `prevImageId` / `nextImageId` / `currentIndex` / `totalImages` instead of `getJobImageIds(jobId)`. This keeps the function backwards compatible for any other callers (e.g. the standalone results route).
4. **`verifyAndAdvance` accepts optional `candidateImageIds: number[]`**. When provided, the SQL queries are constrained to that set via `inArray(images.id, candidateImageIds)`, and the "wrap around" search also stays inside the set. When omitted, behavior is unchanged.
5. **Edge cases handled in the snapshot model** (see below).

### Why a snapshot, not live filter state

- Stable navigation: a user verifying images won't have the next image yanked out from under them when the verification filter "Sin verificar" reclassifies the image they're currently looking at.
- Simple model: snapshot at click time, drop on close. No reactive coupling between filter state and the open overlay.
- Matches user mental model: "I picked these N images, let me walk through them."

The snapshot is rebuilt on every `loadImage(imageId)` only if the user re-enters the overlay from the grid. While inside the overlay, the navigation list does not change.

### Edge cases

- **Snapshot doesn't include current image** (shouldn't happen — they clicked it from the filtered grid — but defensive). Fall back to: `currentIndex = 0`, no prev/next.
- **Verify-and-advance reaches end of snapshot.** Wrap-around stays inside the snapshot. If wrap-around finds no unverified image inside the snapshot, return `nextImageId: null`. Critically, **`maybeAutoCompleteDeployment` is only called when no filter is in effect** — finishing a filtered subset must not mark the whole deployment done.
- **Filter cleared while overlay open.** The snapshot is unaffected; the user keeps walking the original filtered set. When they close, the grid reflects current (cleared) filters.
- **User mutates an image in a way that would remove it from the filter** (e.g. verifies a "Sin verificar" image while that filter is active). The snapshot still includes it; navigation works. The grid behind will reflow once they close.
- **Filter changes mid-overlay.** The ref tracks live updates from `onFilteredIdsChange`, but the **snapshot in state is not replaced** until the next `loadImage` call. Intentional.
- **Empty filter result** (0 images). The grid renders nothing, so no click is possible — no overlay state to manage.

## Technical Considerations

### Files to change

| File | Change |
|---|---|
| `src/app/camera-trap/results/[id]/results-client.tsx` | Add optional `onFilteredIdsChange` prop. Add `useEffect` that calls it whenever `filteredImages` changes, passing `filteredImages.map(i => i.id)`. |
| `src/app/camera-trap/[id]/deployment-gallery-client.tsx` | Add `filteredIdsRef` (ref). Pass `onFilteredIdsChange={(ids) => { filteredIdsRef.current = ids; }}` to `ResultsClient`. Add `navigationIds` state. In `loadImage`, snapshot `filteredIdsRef.current` into `navigationIds` before calling the action. Pass `navigationIds` into `getImageAnnotationData` and into the `ImageAnnotationClient` so it can forward to `verifyAndAdvance`. Clear `navigationIds` in `handleBack`. |
| `src/app/camera-trap/actions.ts` (`getImageAnnotationData`, ~line 3075) | Add optional `navigationIds?: number[]` param. When provided and non-empty, skip `getJobImageIds(jobId)` and compute `currentIndex` / `prevImageId` / `nextImageId` / `totalImages` from it. |
| `src/app/camera-trap/actions.ts` (`verifyAndAdvance`, ~line 4026) | Add optional `candidateImageIds?: number[]` param. Constrain both the `forward` and `wrapped` queries with `inArray(images.id, candidateImageIds)` when provided. Skip `maybeAutoCompleteDeployment` when filtered (because finishing the filtered subset ≠ finishing the deployment). |
| `src/app/camera-trap/results/[id]/images/[imageId]/image-annotation-client.tsx` | Accept new optional prop `navigationIds?: number[]`. Forward it to `verifyAndAdvance(unverifiedIds, jobId, imageId, navigationIds)` at line 207. (Prev/Next buttons already use `prevImageId`/`nextImageId` from props, which are now correctly computed server-side, so no change needed there.) |
| `tests/integration/camera-trap-jobs.test.ts` (or new test file) | Add tests for `getImageAnnotationData` with `navigationIds` and `verifyAndAdvance` with `candidateImageIds`. |

### Pseudo-code sketches

**`results-client.tsx`** — emit filtered IDs upward:

```tsx
// results-client.tsx
interface ResultsClientProps {
  // ...existing
  onFilteredIdsChange?: (ids: number[]) => void;
}

// inside ResultsClientInner, after filteredImages useMemo:
useEffect(() => {
  onFilteredIdsChange?.(filteredImages.map((i) => i.id));
}, [filteredImages, onFilteredIdsChange]);
```

**`deployment-gallery-client.tsx`** — snapshot at open:

```tsx
// deployment-gallery-client.tsx
const filteredIdsRef = useRef<number[]>(images.map((i) => i.id));
const [navigationIds, setNavigationIds] = useState<number[] | null>(null);

const loadImage = useCallback((imageId: number) => {
  const snapshot = filteredIdsRef.current.length > 0
    ? [...filteredIdsRef.current]
    : null;
  setNavigationIds(snapshot);
  startLoading(async () => {
    const data = await getImageAnnotationData(imageId, jobId, snapshot ?? undefined);
    if (data) setAnnotationData(data);
  });
}, [jobId]);

const handleBack = useCallback(() => {
  setAnnotationData(null);
  setNavigationIds(null);
  router.refresh();
}, [router]);

// ResultsClient usage:
<ResultsClient
  images={images}
  jobId={jobId}
  speciesList={speciesList}
  onImageClick={loadImage}
  onFilteredIdsChange={(ids) => { filteredIdsRef.current = ids; }}
/>

// ImageAnnotationClient usage — pass navigationIds through:
<ImageAnnotationClient
  /* ...existing props */
  navigationIds={navigationIds ?? undefined}
/>
```

**`actions.ts`** — `getImageAnnotationData`:

```ts
export async function getImageAnnotationData(
  imageId: number,
  jobId: number,
  navigationIds?: number[],
) {
  const imageIds = navigationIds && navigationIds.length > 0
    ? navigationIds
    : await getJobImageIds(jobId);

  // ...rest unchanged
  const currentIndex = imageIds.indexOf(imageId);
  const prevImageId = currentIndex > 0 ? imageIds[currentIndex - 1] : null;
  const nextImageId = currentIndex >= 0 && currentIndex < imageIds.length - 1
    ? imageIds[currentIndex + 1]
    : null;
  // ...
}
```

**`actions.ts`** — `verifyAndAdvance`:

```ts
export async function verifyAndAdvance(
  identificationIds: number[],
  jobId: number,
  currentImageId: number,
  candidateImageIds?: number[],
): Promise<ActionResult<{ nextImageId: number | null; deploymentCompleted?: boolean }>> {
  // ...auth, verification update unchanged

  const filtered = !!(candidateImageIds && candidateImageIds.length > 0);

  const baseConditions = [
    eq(images.jobId, jobId),
    eq(identifications.verificationStatus, "unverified"),
  ];
  if (filtered) baseConditions.push(inArray(images.id, candidateImageIds!));

  // FORWARD
  const forward = await db
    .select({ id: images.id })
    .from(images)
    .innerJoin(detections, eq(detections.imageId, images.id))
    .innerJoin(identifications, eq(identifications.detectionId, detections.id))
    .where(and(...baseConditions, sql`${images.id} > ${currentImageId}`))
    .orderBy(images.id)
    .limit(1);

  // WRAPPED — same conditions sans the > currentImageId clause
  // ...

  // Only auto-complete when navigating the full deployment, not a filtered subset.
  let deploymentCompleted = false;
  if (nextId === null && !filtered) {
    deploymentCompleted = await maybeAutoCompleteDeployment(job.deploymentId);
  }
  // ...
}
```

**`image-annotation-client.tsx`** — forward navigation IDs:

```tsx
// add prop
navigationIds?: number[];

// in handleVerifySelected etc., line ~207:
const result = await verifyAndAdvance(unverifiedIds, jobId, imageId, navigationIds);
```

### Notes

- `navigationIds` should be ordered the same way the grid orders them (timestamp ASC, then filename) — `ResultsClient` already renders `filteredImages` in input order, which comes from the server already sorted, so `filteredImages.map(i => i.id)` preserves that order. No client-side re-sort needed.
- The snapshot can grow to a few thousand IDs in big deployments. Numeric IDs over JSON are cheap (~6 bytes each). For a 5,000-image job that's ~30 KB per call, well within server-action limits.
- `inArray` with thousands of integers is fine in SQLite (parameter limit is high, and we already use similar patterns in bulk operations — see the patterns mentioned in CLAUDE.md).
- Keep the existing `ResultsClient` props/behavior backwards compatible — `onFilteredIdsChange` is optional. The legacy `/camera-trap/results/[id]` page (if still used directly) keeps working unchanged.

### What NOT to do (out of scope)

- Don't move filter state into URL search params or server state. That's a bigger refactor for a separate "deep linkable filtered results" feature.
- Don't refactor how `ResultsClient` builds its filter sidebar. This fix touches data flow, not UI.
- Don't change the order of images in the job. Existing ordering is correct.
- Don't try to "live update" the snapshot when filters change mid-overlay. Snapshot semantics are intentional.

## Acceptance Criteria

- [x] With a species filter active, clicking an image and pressing **Siguiente** loads the next image **of that species in grid order**, not the next image in the job.
- [x] With a species filter active, the header counter shows `X de N` where `N` is the filtered count (e.g. `3 de 12`), not the total job count.
- [x] Same applies to the **Anterior** button.
- [x] Same applies to the `n` / `p` (or arrow) keyboard shortcuts in `useAnnotationShortcuts`.
- [x] **Verificar** (which calls `verifyAndAdvance`) advances to the next unverified image **inside the filtered set**. When the filtered set is exhausted, it stops with `nextImageId: null` (no jumping to a different species).
- [x] All filter types are covered: species, confidence range, verification status, show-empty, starred-only, blanks-only, and any combination thereof.
- [x] When the entire deployment is reviewed via an unfiltered walk, `maybeAutoCompleteDeployment` still fires (regression guard).
- [x] When a filtered subset is fully verified, `maybeAutoCompleteDeployment` does **not** fire just because the subset finished.
- [x] Clearing all filters while the overlay is open does not break navigation — the user keeps walking the snapshot. Closing and reopening from the cleared grid uses the new (full) snapshot.
- [x] Filtering by **Verificación = Sin verificar**, then verifying images one by one, the user can keep stepping through every originally-pending image without the current image disappearing mid-session.
- [x] No regression on `/camera-trap/results/[id]/images/[imageId]` direct route (which doesn't pass `navigationIds`) — falls back to the full-job behavior.
- [x] All existing camera-trap tests still pass; new tests cover the filtered navigation paths.

## Test Plan

**Unit / integration (Vitest)** — `tests/integration/camera-trap-jobs.test.ts` (or a new file):

- `getImageAnnotationData(imageId, jobId, [a, b, c])` returns `currentIndex`, `prevImageId`, `nextImageId`, `totalImages` derived from `[a, b, c]`, not from the job's full image list.
- `getImageAnnotationData(imageId, jobId)` (no `navigationIds`) preserves current behavior.
- `getImageAnnotationData(imageId, jobId, [])` falls back to full-job behavior (treat empty as "no filter").
- `verifyAndAdvance(ids, jobId, currentImageId, [a, b, c])`:
  - Returns the next unverified image **within** `[a, b, c]`.
  - Wrap-around stays inside `[a, b, c]`.
  - Does NOT call `maybeAutoCompleteDeployment` when finishing a filtered subset.
- `verifyAndAdvance(ids, jobId, currentImageId)` (no candidates) preserves existing behavior including auto-complete.

**Manual (browser):**

- Filter by species → click → Siguiente cycles only that species.
- Filter by `Sin verificar` → verify images one at a time → keep advancing inside the unverified subset until exhausted.
- Filter by `Solo destacadas` → walk through starred-only.
- Filter by `Solo vacías` → walk through blank-only.
- Slide confidence minimum to 70% → walk through high-confidence subset.
- Combine species + verification + confidence filters → walk through intersection.
- Clear filters mid-overlay → confirm navigation continues on the snapshot, no UI glitch.
- Open overlay with no filter active → confirm full-job navigation still works (regression).
- Process a brand-new deployment → verify all unverified images via the shortcut → confirm `maybeAutoCompleteDeployment` still marks deployment complete.

## Dependencies & Risks

- **Risk:** server actions accepting large arrays (`number[]` of a few thousand IDs) — verified safe with `inArray` in SQLite. Mitigate by capping the snapshot size if needed (e.g. 10k); current grids don't exceed this.
- **Risk:** breaking the standalone `/camera-trap/results/[id]/images/[imageId]` route. Mitigate by keeping `navigationIds` optional with full-job fallback.
- **Risk:** stale snapshots if user keeps the overlay open across long verify sessions. Acceptable — snapshot semantics are documented above.
- **No new dependencies.** No schema changes. No migration.

## References

### Internal

- `src/app/camera-trap/results/[id]/results-client.tsx:72` — filter `useMemo`, source of truth for filtered images
- `src/app/camera-trap/[id]/deployment-gallery-client.tsx:39` — `loadImage` callback chain
- `src/app/camera-trap/actions.ts:3075` — `getImageAnnotationData`, where `prevImageId`/`nextImageId` are computed
- `src/app/camera-trap/actions.ts:3050` — `getJobImageIds` (the unfiltered query the bug currently consumes)
- `src/app/camera-trap/actions.ts:4026` — `verifyAndAdvance`, currently scans entire job
- `src/app/camera-trap/results/[id]/images/[imageId]/image-annotation-client.tsx:207` — `verifyAndAdvance` invocation site
- `src/app/camera-trap/results/[id]/images/[imageId]/image-annotation-client.tsx:397` — keyboard `onNext` / `onPrev` handlers

### Related work

- Brainstorm: `docs/brainstorms/2026-03-05-annotation-workflow-improvements-brainstorm.md` (general annotation UX context)
- Brainstorm: `docs/brainstorms/2026-04-03-camera-trap-module-redesign-brainstorm.md` (broader module redesign context)
