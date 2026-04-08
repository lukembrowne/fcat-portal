---
title: Pre-load neighbor images & metadata during annotation for instant arrow-key navigation
type: perf
date: 2026-04-08
---

# Pre-load neighbor images & metadata during annotation for instant arrow-key navigation

## Overview

When an annotator flips through thousands of camera-trap images with the arrow keys, even a ~0.5 s delay per image is crippling. Today each arrow press pays the full cost of:

1. A server action (`getImageAnnotationData`) that runs 5–6 DB queries — most of which return data that is identical between neighbor images in the same deployment.
2. A cold image request to `/api/ct-images/{id}?size=full` (multi-MB JPEG, disk read, HTTP round trip, decode).
3. A React re-render and an `<img>` that can't paint until its bytes arrive.

This plan adds client-side **pre-loading of the next few images and their annotation metadata** during the annotation session, plus a small server-side refactor that makes per-navigation queries much cheaper. The goal is that pressing → feels instant — the next image is already sitting in the browser's HTTP cache and its bounding boxes are already in memory.

## Problem Statement / Motivation

Annotation is a hot path. The BIOCHOCO team burns down thousands of images by arrow-key walking through a filtered grid and verifying/rejecting/correcting detections as fast as they can read them. Anything that adds perceptible latency per step compounds — at 0.5 s per image × 2 000 images that's 17 wasted minutes per pass.

The architecture already has everything we need to fix this cheaply:

- The image proxy already returns immutable cache headers (`public, max-age=31536000, immutable`), so browser HTTP cache will hold preloaded bytes indefinitely with no extra work.
- The annotation overlay already knows the full ordered list of images the user will walk (`navigationIds` / `filteredIdsRef` in `deployment-gallery-client.tsx:36`), so we know exactly which images to prefetch.
- The persistent disk cache from the Feb 2026 image-caching brainstorm (`docs/brainstorms/2026-02-14-camera-trap-image-caching-brainstorm.md`) means most full images are already on local disk — the only remaining latency is disk read + HTTP body streaming to the browser, which is exactly what a prefetch into the HTTP cache eliminates.

We're not solving "Drive is slow" (already handled by the persistent cache). We're solving "even a local hit takes a network round trip the user has to wait for."

## Proposed Solution

Three coordinated changes:

### 1. Client-side **image byte prefetch** (primary win)

Maintain a sliding window of upcoming image IDs relative to the current image. For each ID in the window, kick off a low-priority fetch using `new Image()` (or `<link rel="preload" as="image" fetchpriority="low">`). The browser writes the bytes into its HTTP cache; when the user navigates, the `<img src>` hits the cache and paints immediately — no network round trip.

Window policy:
- Prefetch **next 3** and **previous 1** images by default (biased forward because the user almost always walks forward).
- Detect navigation direction from the last key press (→ vs. ←) and flip the bias if the user is walking backward.
- Hard cap of **3 in-flight** prefetches so the current image's fetch (the one the user is actually staring at) is never starved.
- On unmount / `deploymentChanged` / `navigationIds` changed → abort in-flight prefetches (`new Image().src = ""` drops the browser request in most engines; also use `AbortController` for any `fetch()`-based prefetches).

### 2. Client-side **metadata prefetch + in-memory LRU cache**

Maintain a `Map<imageId, AnnotationPayload>` keyed by image ID. Prefetch the server action `getImageAnnotationData` (or the lighter per-image variant from change 3 below) for the same window as images, and populate the map. On navigation:

- **Cache hit** → swap `annotationData` state synchronously from the map. User sees the new image + boxes in the same frame as the keypress.
- **Cache miss** (cold start, fast-scrolling past the window) → fall back to the current `await getImageAnnotationData(...)` path, and show the existing spinner after a small delay (only if the fetch actually takes > 150 ms — avoid flashing the spinner when the response races the keypress).

LRU eviction at ~10 entries so memory stays bounded.

### 3. Server-side: split `getImageAnnotationData` into "session context" + "per-image payload"

Today `getImageAnnotationData` re-fetches this every single navigation:

| Query | Changes per image? |
|-------|--------------------|
| `getImageWithDetections(imageId)` | ✅ yes |
| `getJobImageIds(jobId)` (when not filtered) | ❌ job-scoped, stable |
| `getSpeciesList()` | ❌ global, stable |
| `getDeploymentVerificationStats(deploymentId)` | ⚠️ deployment-scoped, drifts by ±1 on verify but UI only displays `reviewed/total` |
| `getFrequentSpecies(deploymentId)` | ❌ deployment-scoped, stable during a session |
| `deploymentName` (join in `getImageWithDetections`) | ❌ deployment-scoped, stable |

Split into two actions:

- `getAnnotationSessionContext(jobId, deploymentId)` — fetched **once** when the overlay opens. Returns `speciesList`, `frequentSpecies`, `deploymentName`, `jobImageIds`, `verificationStats` (baseline).
- `getImagePayload(imageId)` — fetched **per image**, only queries `images` + `detections` + `identifications`. ~1-2 queries total.

The overlay keeps `sessionContext` in state; prefetches (change 2 above) now fetch the much cheaper `getImagePayload` per neighbor. `verificationStats` is updated client-side: start from the baseline and apply a `+1` whenever the user verifies on the current image, then occasionally rehydrate on overlay open or when mutations happen.

This turns a 5–6 query per-navigation fan-out into a 1–2 query one, which also makes the metadata prefetches much cheaper to run speculatively.

## Technical Considerations

### Consistency & mutation invalidation

- **Verifying / rejecting / species assignment** only affects the current image. Neighbor payloads in the cache are still valid.
- **Adding a new species** (`createSpecies`) affects `speciesList` in session context. Bump a `sessionContextVersion` and refetch session context lazily after a successful `createSpecies` (does not need to invalidate per-image cache).
- **Deletion of current image** (`deleteImagesFromDrive`, bulk blank delete) — currently triggers `router.refresh()`. Clear the entire metadata cache on any mutation that changes the image set, and re-snapshot `navigationIds` from the parent.
- **Navigation ID snapshot**: prefetch queue is keyed off the frozen `navigationIds` snapshot captured when the overlay opens (`deployment-gallery-client.tsx:56-58`), matching existing behavior. If the user backs out and re-enters with different filters, the cache and queue reset.

### Network / bandwidth

- Images are typically 1–3 MB each. Prefetching 4 neighbors ≈ 4–12 MB of speculative fetch. On a reasonable office connection this completes in under a second and does not compete meaningfully with the in-flight request.
- Use `fetchpriority="low"` on prefetch `<img>` elements so the browser prioritizes the user's current fetch.
- Cap in-flight prefetches to 3 (simple counting queue).

### Race conditions

- If the user arrow-spams faster than prefetches complete, cache misses will occur past the window. That's acceptable — they'll fall through to the current `await` path, which is no worse than today.
- When a prefetch completes for an image the user has already moved past, just put it in the cache anyway — it might be useful on the way back.
- `AbortController` on metadata fetches; for image prefetches, setting `img.src = ""` cancels pending requests in Chromium/Firefox. Always clear listeners before zeroing `src`.

### Stale verificationStats

The deployment-wide `X/Y revisadas` counter drifts by at most the number of verifications performed during the current session. Approach:

1. Fetch baseline once (in session context).
2. Maintain a client-side delta counter bumped on successful verify/reject.
3. Display `baseline.reviewed + sessionDelta` / `baseline.total` in the header.
4. Re-sync from the server on overlay close or when mutations touch the image set.

This is simpler than trying to keep prefetched payloads' stats up-to-date.

### Feature flag / rollout

No flag needed — this is a pure client-side optimization with a safe fallback (cache miss → existing behavior). Ship behind a constant if we want to disable it quickly.

### Scope: overlay first, standalone page later

The primary workflow is the `DeploymentGalleryClient` overlay (called from `/camera-trap/[id]` pages). The standalone route `/camera-trap/results/[id]/images/[imageId]/page.tsx` is still used but less frequently. This plan focuses the full prefetching implementation on the overlay. For the standalone page we add a lighter optimization: `router.prefetch(nextUrl)` on mount, which pre-warms the Next.js RSC payload so a forward arrow is faster even if not truly instant.

## Acceptance Criteria

- [ ] Pressing → in the annotation overlay for a neighbor already in the prefetch window paints the new image in the **same frame** as the keypress on a local dev environment (verify with DevTools Performance panel — no network request on navigate; `<img>` is served from memory/disk cache).
- [ ] `getImageAnnotationData` is split into `getAnnotationSessionContext` and `getImagePayload`; the overlay loads session context once per open and calls `getImagePayload` per navigation.
- [ ] A client-side LRU cache holds up to 10 recent image payloads; cache is cleared when `navigationIds` changes or on any image-set mutation.
- [ ] A sliding prefetch window of **next 3 + previous 1** is maintained as the user navigates; concurrent prefetches capped at 3; prefetches use `fetchpriority="low"` (images) and run in the background (metadata).
- [ ] Prefetch direction flips when the user walks backward (last key press was ←).
- [ ] Mutations that change the current image (verify, reject, assign species, delete detection) do **not** invalidate neighbor payloads in the cache.
- [ ] Adding a new species (`createSpecies`) triggers a lazy session-context refetch.
- [ ] `X/Y revisadas` counter in the overlay header stays accurate during a session via client-side delta counting.
- [ ] On cache miss the existing loading behavior is preserved; spinner only appears if the fetch takes > 150 ms.
- [ ] Unit tests cover: LRU eviction, direction biasing, concurrency cap, cancellation on `navigationIds` change, and the new `getImagePayload` action.
- [ ] Manual test plan passes (below).

## Success Metrics

- **Subjective**: annotator can walk through a filtered grid of ≥500 images at roughly the speed of keyboard auto-repeat with no visible lag.
- **Objective**: median time from → keypress to `<img>` paint event drops from ~300–500 ms (current) to **< 60 ms** for neighbor images in the window (measured via Performance.mark / Performance.measure).
- **Server load**: `getImagePayload` runs ~4× more often than today's `getImageAnnotationData` (because of prefetching), but each call does ~⅓ the work, so net DB time per session drops.

## Dependencies & Risks

- **Memory**: 10 payloads × ~10 KB each ≈ 100 KB. Images in HTTP cache are out-of-process (browser managed). Negligible.
- **Wasted bandwidth**: users who never walk forward (e.g. open an image, fix one detection, close overlay) will pay for prefetches that never get used. This is acceptable because most neighbors are served from the disk cache already, so the server cost is low, and this is the minority workflow.
- **Risk of introducing a regression in mutation flows**: mitigated by cache clearing on any image-set mutation and keeping `router.refresh()` in the existing mutation handlers.
- **Browser variability in image cancellation**: setting `img.src = ""` behavior differs slightly across engines. Acceptable — worst case the browser finishes a prefetch we no longer need.

## Implementation Plan

### Phase 1 — Server-side split (pure refactor, no behavior change)

- [x] Add `getAnnotationSessionContext(jobId, deploymentId, navigationIds?)` in `src/app/camera-trap/actions.ts`:
  - Returns `{ speciesList, frequentSpecies, deploymentName, jobImageIds, verificationStatsBaseline }`.
- [x] Add `getImagePayload(imageId)` in the same file:
  - Returns `{ image, boxes, detections, timestamp }` — only queries `images` + `detections` + `identifications` + one deployment name lookup (or skip it since it's in session context).
- [x] Keep `getImageAnnotationData` untouched for now so the standalone page and any other callers continue to work.

### Phase 2 — Client cache + prefetch primitives

- [x] New file `src/lib/annotation-prefetch.ts`:
  ```ts
  // src/lib/annotation-prefetch.ts
  export class AnnotationPayloadCache {
    constructor(maxEntries = 10) { /* LRU */ }
    get(imageId: number): ImagePayload | undefined
    set(imageId: number, payload: ImagePayload): void
    clear(): void
  }

  export function preloadImage(url: string): { cancel(): void }
  // Uses new Image(); sets fetchpriority, loading='eager'. Returns cancel handle.

  export function computePrefetchWindow(
    currentIndex: number,
    navigationIds: number[],
    direction: 'forward' | 'backward',
    ahead: number = 3,
    behind: number = 1,
  ): number[]
  ```

- [x] New file `src/hooks/use-annotation-prefetch.ts`:
  ```ts
  // src/hooks/use-annotation-prefetch.ts
  export function useAnnotationPrefetch(opts: {
    currentImageId: number;
    navigationIds: number[];
    cache: AnnotationPayloadCache;
    fetchPayload: (id: number) => Promise<ImagePayload>;
    concurrency?: number; // default 3
    enabled?: boolean;
  }): { getCached(id: number): ImagePayload | undefined }
  ```
  - Tracks last navigation direction (exposed via imperative setter or inferred from index delta).
  - On `currentImageId` change: compute window, kick off image preloads + metadata fetches for uncached entries, cancel prefetches outside the window.
  - Honors concurrency cap via a simple promise queue.

- [x] New file `tests/unit/annotation-prefetch.test.ts`:
  - LRU eviction order.
  - `computePrefetchWindow` edge cases (start of list, end of list, backward direction).
  - Concurrency cap respects maximum in-flight. *(deferred — covered in hook integration testing instead)*
  - Cancellation clears the queue. *(deferred — covered in hook integration testing instead)*

### Phase 3 — Wire into the overlay

- [x] Update `src/app/camera-trap/[id]/deployment-gallery-client.tsx`:
  - On overlay open, fetch `sessionContext` once via `getAnnotationSessionContext(...)` and hold it in state.
  - Replace per-navigation `getImageAnnotationData` call with `getImagePayload` + merge with session context.
  - Instantiate `AnnotationPayloadCache` and `useAnnotationPrefetch` keyed on `navigationIds`.
  - `loadImage(imageId)`: first check cache, swap synchronously if hit, otherwise await fetch with 150 ms spinner delay.
  - `handleMutate`: keep per-image refetch, clear cache entry for current image only; session context unaffected unless it was a species create.
  - Track a client-side verification delta; inject `verificationStats.reviewed + delta` into the header.
  - On `navigationIds` change, unmount, or deployment change: clear cache and cancel in-flight prefetches.

- [x] Update `src/app/camera-trap/actions.ts` `createSpecies` return or add a companion signal so the overlay knows to refetch session context on success. (Implemented as: `handleMutate` unconditionally refetches session context, which covers `createSpecies` because that path triggers `refresh` → `onMutate` → `handleMutate`.)

### Phase 4 — Standalone page lightweight prefetch

- [x] In `src/app/camera-trap/results/[id]/images/[imageId]/image-annotation-client.tsx`, on mount and on `nextImageId` change: call `router.prefetch(\`/camera-trap/results/${jobId}/images/${nextImageId}\`)` to warm the Next.js RSC payload. Also kick off `preloadImage(\`/api/ct-images/${nextImageId}?size=full\`)` for the next image.
- [x] Same treatment for `prevImageId`.

### Phase 5 — Instrumentation & manual verification

- [ ] Add a `console.timeLog`-style marker (behind `NEXT_PUBLIC_DEBUG_PREFETCH=1`) that logs cache hit/miss and image decode latency. Remove or silence before merge. *(deferred — add only if perf needs measuring after manual smoke test)*
- [ ] Manual test plan (below). *(awaiting user smoke test)*

## Files to Touch

| File | Change |
|------|--------|
| `src/app/camera-trap/actions.ts` | Add `getAnnotationSessionContext` + `getImagePayload`; keep existing `getImageAnnotationData` |
| `src/lib/annotation-prefetch.ts` | **New** — LRU cache, `preloadImage`, window computation |
| `src/hooks/use-annotation-prefetch.ts` | **New** — prefetch hook |
| `src/app/camera-trap/[id]/deployment-gallery-client.tsx` | Wire in session context, per-image cache, prefetch hook, verification delta |
| `src/app/camera-trap/results/[id]/images/[imageId]/image-annotation-client.tsx` | Add `router.prefetch(nextUrl)` + `preloadImage(nextFullUrl)` for standalone page |
| `tests/unit/annotation-prefetch.test.ts` | **New** — cache + window + concurrency tests |

## Manual Test Plan

1. **Baseline**: in a ≥500-image deployment, open the annotation overlay and walk → through ~30 images. Note current delay (should feel like 200–500 ms per step).
2. **Warm prefetch**: after the change, repeat — first arrow press loads the current image normally; subsequent arrows should paint within one frame. Verify in DevTools Network tab that the image request is served from `(memory cache)` or `(disk cache)`.
3. **Forward run**: hold → for 2 seconds. Verify most images paint without lag; a cache miss beyond the window falls back to the existing behavior gracefully.
4. **Backward walk**: press ← a few times. Verify direction bias flips and previous images prefetch.
5. **Filter change**: apply a species filter in the grid, open overlay, walk forward. Verify prefetches only cover filtered images (not the full deployment).
6. **Mutation**: verify current detection, advance via quick-verify-all. Verify the new image paints instantly and the `X/Y revisadas` counter increments correctly.
7. **Add new species**: in the species sidebar, add a new species. Verify it appears in the list for the next image (session context refetched).
8. **Delete image**: delete current image via the detection delete flow. Verify cache is cleared and navigation still works.
9. **Open/close rapidly**: open overlay, close, open again with a different filter. Verify no stale cached data leaks across sessions.
10. **DevTools Performance trace**: record a 5-second trace while walking forward. Confirm no image network request on cache-hit navigations; keypress-to-paint < 60 ms.

## Alternative Approaches Considered

- **Service Worker precache** — gives us full control over caching but is overkill. The browser's HTTP cache already does the job for free because our image proxy returns immutable cache headers. Rejected.
- **Lower-resolution preview during scroll + upgrade when settled** — would work but requires a new thumbnail size endpoint and a more complex UI (swap sources on settle). Full-image prefetch achieves the same perceived speed without the complexity. Rejected.
- **Server-side "batch image payload" endpoint** returning N payloads at once — tempting but more complex to cancel and window. Per-image fetch with client-side parallelism is simpler and composes with the cache. Deferred.
- **Next.js `router.prefetch` only** — works for the standalone page but not the overlay (the overlay doesn't use Next.js routing). Covered for the standalone page in Phase 4, but insufficient as the main solution.
- **`<link rel="preload" as="image">` injected into `<head>`** — equivalent to `new Image()` for our purposes. Slightly more DOM churn. Stick with `new Image()` for simplicity.

## References & Research

### Internal

- `src/app/camera-trap/[id]/deployment-gallery-client.tsx:51-92` — current per-navigation `getImageAnnotationData` call and `handleMutate` pattern.
- `src/app/camera-trap/results/[id]/images/[imageId]/image-annotation-client.tsx:415-434` — current arrow-key navigation handlers.
- `src/app/camera-trap/actions.ts:3589-3700` — `getImageAnnotationData` (to be split).
- `src/app/api/ct-images/[id]/route.ts:100-145` — image proxy, already sends `Cache-Control: public, max-age=31536000, immutable` and serves from disk cache when `images.path` is set.
- `docs/brainstorms/2026-02-14-camera-trap-image-caching-brainstorm.md` — the persistent disk cache this plan builds on.
- `docs/plans/2026-03-03-feat-annotation-image-zoom-pan-plan.md` and `docs/plans/2026-03-05-feat-annotation-workflow-improvements-plan.md` — prior annotation UX work that established the overlay pattern and keyboard shortcut conventions this plan must not break.

### External

- [MDN: `HTMLImageElement.fetchPriority`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/fetchPriority) — for low-priority prefetch.
- [web.dev: Preload critical assets](https://web.dev/articles/preload-critical-assets) — `<link rel="preload">` semantics.
- [MDN: `HTMLImageElement.decode()`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLImageElement/decode) — can be used to pre-decode images off the main thread before swapping, further reducing paint jank if we see it in profiling.
