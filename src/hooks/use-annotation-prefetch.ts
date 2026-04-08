"use client";

import { useEffect, useRef, useCallback } from "react";
import {
  type AnnotationPayloadCache,
  type PreloadHandle,
  type PrefetchDirection,
  computePrefetchWindow,
  preloadImage,
} from "@/lib/annotation-prefetch";

export interface UseAnnotationPrefetchOptions<T> {
  /** Currently displayed image ID. */
  currentImageId: number | null;
  /** Ordered list of image IDs the user is walking. */
  navigationIds: readonly number[];
  /** Shared client-side cache. */
  cache: AnnotationPayloadCache<T>;
  /** Async fetcher for an image's metadata payload. */
  fetchPayload: (imageId: number) => Promise<T | null>;
  /** Build the full-image URL for a given image ID. */
  buildImageUrl: (imageId: number) => string;
  /** Last navigation direction; flips prefetch bias. Defaults to "forward". */
  direction?: PrefetchDirection;
  /** How many images ahead in the bias direction. Defaults to 3. */
  ahead?: number;
  /** How many images behind the bias direction. Defaults to 1. */
  behind?: number;
  /** Maximum concurrent in-flight metadata fetches. Defaults to 3. */
  concurrency?: number;
  /** Disable prefetching entirely (e.g. on slow connections). */
  enabled?: boolean;
}

/**
 * React hook that maintains a sliding prefetch window around the current
 * image. On every change to the cursor it:
 *
 *   1. computes the next [ahead] images (and a few behind) the user is
 *      likely to visit next,
 *   2. cancels prefetches that fell outside the window,
 *   3. kicks off image-byte preloads for any window entry not yet warmed,
 *   4. enqueues metadata fetches (capped at `concurrency` in flight) for
 *      any window entry not yet in the cache.
 *
 * The cache is owned by the caller so it survives across renders and can
 * be cleared when the user changes filter / closes the overlay.
 */
export function useAnnotationPrefetch<T>({
  currentImageId,
  navigationIds,
  cache,
  fetchPayload,
  buildImageUrl,
  direction = "forward",
  ahead = 3,
  behind = 1,
  concurrency = 3,
  enabled = true,
}: UseAnnotationPrefetchOptions<T>): {
  getCached: (imageId: number) => T | undefined;
} {
  // Currently in-flight metadata fetches keyed by imageId. We track them
  // so we don't fire duplicates and so we can cancel via AbortController.
  const inFlightMetaRef = useRef<Map<number, AbortController>>(new Map());
  // Image byte preload handles keyed by imageId. cancel() drops the
  // request when the entry leaves the window.
  const inFlightImgRef = useRef<Map<number, PreloadHandle>>(new Map());
  // FIFO queue of imageIds waiting for a metadata fetch slot.
  const queueRef = useRef<number[]>([]);
  // Current count of in-flight metadata fetches (== inFlightMetaRef.size,
  // but kept as a ref so the queue runner doesn't have to iterate).
  const activeCountRef = useRef(0);

  // Stable getter the consumer uses on synchronous keypress.
  const getCached = useCallback((id: number) => cache.get(id), [cache]);

  // Drain the queue while we have capacity.
  const pump = useCallback(() => {
    const queue = queueRef.current;
    while (activeCountRef.current < concurrency && queue.length > 0) {
      const id = queue.shift()!;
      // Skip work the consumer no longer cares about.
      if (cache.has(id)) continue;
      if (inFlightMetaRef.current.has(id)) continue;

      const ctrl = new AbortController();
      inFlightMetaRef.current.set(id, ctrl);
      activeCountRef.current += 1;

      fetchPayload(id)
        .then((payload) => {
          if (ctrl.signal.aborted) return;
          if (payload != null) cache.set(id, payload);
        })
        .catch(() => {
          // Swallow prefetch errors — they're speculative work, the user
          // will trigger a real fetch when they navigate to the image.
        })
        .finally(() => {
          inFlightMetaRef.current.delete(id);
          activeCountRef.current -= 1;
          // Try to drain more work now that a slot opened up.
          pump();
        });
    }
  }, [cache, concurrency, fetchPayload]);

  useEffect(() => {
    if (!enabled) return;
    if (currentImageId == null) return;
    if (navigationIds.length === 0) return;

    const currentIndex = navigationIds.indexOf(currentImageId);
    if (currentIndex === -1) return;

    const window = computePrefetchWindow(
      currentIndex,
      navigationIds,
      direction,
      ahead,
      behind,
    );
    const windowSet = new Set(window);

    // 1) Cancel any prefetches that fell outside the window.
    for (const [id, ctrl] of inFlightMetaRef.current) {
      if (!windowSet.has(id)) {
        ctrl.abort();
        inFlightMetaRef.current.delete(id);
        activeCountRef.current = Math.max(0, activeCountRef.current - 1);
      }
    }
    for (const [id, handle] of inFlightImgRef.current) {
      if (!windowSet.has(id)) {
        handle.cancel();
        inFlightImgRef.current.delete(id);
      }
    }
    // Drop pending queue entries that are no longer in the window.
    queueRef.current = queueRef.current.filter((id) => windowSet.has(id));

    // 2) Kick off image byte preloads + enqueue metadata fetches.
    for (const id of window) {
      if (!inFlightImgRef.current.has(id)) {
        inFlightImgRef.current.set(id, preloadImage(buildImageUrl(id)));
      }
      if (
        !cache.has(id) &&
        !inFlightMetaRef.current.has(id) &&
        !queueRef.current.includes(id)
      ) {
        queueRef.current.push(id);
      }
    }

    pump();
    // We intentionally exclude `cache` and `pump` from deps — `cache` is a
    // stable instance owned by the caller, and `pump`'s identity already
    // covers everything it captures. Including them would cause the effect
    // to re-run on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentImageId, navigationIds, direction, ahead, behind, enabled, buildImageUrl]);

  // Cleanup on unmount: cancel everything in flight and drop pending work.
  // Capture the refs into locals so the cleanup closure references the
  // same objects we observed at mount time (the ref boxes never change,
  // only their `.current` does).
  useEffect(() => {
    const metaRef = inFlightMetaRef;
    const imgRef = inFlightImgRef;
    const queue = queueRef;
    const active = activeCountRef;
    return () => {
      for (const ctrl of metaRef.current.values()) ctrl.abort();
      metaRef.current.clear();
      for (const handle of imgRef.current.values()) handle.cancel();
      imgRef.current.clear();
      queue.current = [];
      active.current = 0;
    };
  }, []);

  return { getCached };
}
