/**
 * Annotation prefetching primitives.
 *
 * The annotation overlay walks the user through thousands of camera-trap
 * images one keystroke at a time. To make navigation feel instant we
 * speculatively load the *next* few images and their detection metadata
 * while the user is still looking at the current one.
 *
 * This module is the framework-free core: an LRU cache, an image byte
 * preloader, and a sliding-window helper. The React hook lives in
 * `src/hooks/use-annotation-prefetch.ts` and wires these together.
 *
 * The image proxy already returns
 *   Cache-Control: public, max-age=31536000, immutable
 * (see `src/app/api/ct-images/[id]/route.ts:101`), so once `preloadImage`
 * has fetched a URL the browser HTTP cache holds the bytes — the next
 * `<img src=…>` paint hits memory.
 */

/**
 * A small last-recently-used cache. Map already preserves insertion order
 * in JS, so an LRU is just "delete on read, re-set" + "trim from head".
 */
export class AnnotationPayloadCache<T> {
  private readonly store = new Map<number, T>();
  constructor(private readonly maxEntries: number = 10) {
    if (maxEntries < 1) {
      throw new Error("AnnotationPayloadCache: maxEntries must be >= 1");
    }
  }

  get(imageId: number): T | undefined {
    const value = this.store.get(imageId);
    if (value === undefined) return undefined;
    // Refresh recency: delete + re-insert moves the entry to the tail.
    this.store.delete(imageId);
    this.store.set(imageId, value);
    return value;
  }

  has(imageId: number): boolean {
    return this.store.has(imageId);
  }

  set(imageId: number, payload: T): void {
    if (this.store.has(imageId)) {
      this.store.delete(imageId);
    }
    this.store.set(imageId, payload);
    while (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) break;
      this.store.delete(oldestKey);
    }
  }

  delete(imageId: number): void {
    this.store.delete(imageId);
  }

  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

export interface PreloadHandle {
  cancel(): void;
}

/**
 * Kick off a low-priority browser fetch for an image URL. The returned
 * handle's `cancel()` is best-effort: setting `img.src = ""` aborts the
 * request in Chromium/Firefox, but we can't guarantee it across all
 * browsers — worst case the prefetch finishes anyway and lands in the
 * HTTP cache, which is harmless.
 *
 * Designed to run in browsers; SSR-safe (returns a no-op cancel).
 */
export function preloadImage(url: string): PreloadHandle {
  if (typeof window === "undefined" || typeof Image === "undefined") {
    return { cancel: () => {} };
  }

  const img = new Image();
  // `fetchpriority` is a relatively new attribute. Setting it via the
  // generic property setter avoids TS lib version mismatches and is a
  // no-op on browsers that don't support it.
  try {
    (img as unknown as { fetchPriority: string }).fetchPriority = "low";
  } catch {
    // ignore
  }
  img.decoding = "async";
  img.src = url;

  let cancelled = false;
  return {
    cancel() {
      if (cancelled) return;
      cancelled = true;
      // Drop the request: clearing src aborts in-flight network in most
      // engines and lets the GC collect the element.
      try {
        img.src = "";
      } catch {
        // ignore
      }
    },
  };
}

export type PrefetchDirection = "forward" | "backward";

/**
 * Compute the ordered list of image IDs to prefetch around the current
 * cursor. Bias is forward by default; flip when the user is walking
 * backward (last keypress was ←).
 *
 * The returned list excludes the current image ID and is ordered by
 * priority — caller should fetch them in order so the most likely "next"
 * image lands first.
 */
export function computePrefetchWindow(
  currentIndex: number,
  navigationIds: readonly number[],
  direction: PrefetchDirection = "forward",
  ahead: number = 3,
  behind: number = 1,
): number[] {
  if (currentIndex < 0 || currentIndex >= navigationIds.length) return [];

  // `ahead` is "in the direction of travel"; `behind` is "opposite".
  // The sign of the step changes with direction so the heavy side always
  // points where the user is walking.
  const step = direction === "forward" ? 1 : -1;
  const out: number[] = [];

  // Travel-direction neighbors first (highest priority).
  for (let i = 1; i <= ahead; i++) {
    const idx = currentIndex + i * step;
    if (idx >= 0 && idx < navigationIds.length) out.push(navigationIds[idx]);
  }
  // Then a few in the opposite direction (cheap insurance for arrow flips).
  for (let i = 1; i <= behind; i++) {
    const idx = currentIndex - i * step;
    if (idx >= 0 && idx < navigationIds.length) out.push(navigationIds[idx]);
  }

  return out;
}
