import { describe, it, expect } from "vitest";
import {
  AnnotationPayloadCache,
  computePrefetchWindow,
  preloadImage,
} from "@/lib/annotation-prefetch";

describe("AnnotationPayloadCache", () => {
  it("stores and retrieves payloads by image ID", () => {
    const cache = new AnnotationPayloadCache<string>(5);
    cache.set(1, "one");
    cache.set(2, "two");
    expect(cache.get(1)).toBe("one");
    expect(cache.get(2)).toBe("two");
    expect(cache.get(99)).toBeUndefined();
  });

  it("evicts least-recently-used entries when capacity is exceeded", () => {
    const cache = new AnnotationPayloadCache<string>(3);
    cache.set(1, "a");
    cache.set(2, "b");
    cache.set(3, "c");
    cache.set(4, "d"); // evicts 1
    expect(cache.has(1)).toBe(false);
    expect(cache.has(2)).toBe(true);
    expect(cache.has(3)).toBe(true);
    expect(cache.has(4)).toBe(true);
    expect(cache.size).toBe(3);
  });

  it("treats get() as a recency bump (true LRU)", () => {
    const cache = new AnnotationPayloadCache<string>(3);
    cache.set(1, "a");
    cache.set(2, "b");
    cache.set(3, "c");
    // Touching 1 makes it the most-recently-used; the next insertion
    // should evict 2 (now the oldest), not 1.
    cache.get(1);
    cache.set(4, "d");
    expect(cache.has(1)).toBe(true);
    expect(cache.has(2)).toBe(false);
    expect(cache.has(3)).toBe(true);
    expect(cache.has(4)).toBe(true);
  });

  it("re-setting an existing key updates its recency", () => {
    const cache = new AnnotationPayloadCache<string>(3);
    cache.set(1, "a");
    cache.set(2, "b");
    cache.set(3, "c");
    cache.set(1, "a-updated");
    cache.set(4, "d"); // should evict 2
    expect(cache.has(2)).toBe(false);
    expect(cache.get(1)).toBe("a-updated");
  });

  it("clear() empties the cache", () => {
    const cache = new AnnotationPayloadCache<number>(5);
    cache.set(1, 1);
    cache.set(2, 2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.has(1)).toBe(false);
  });

  it("delete() removes a single entry", () => {
    const cache = new AnnotationPayloadCache<number>(5);
    cache.set(1, 1);
    cache.set(2, 2);
    cache.delete(1);
    expect(cache.has(1)).toBe(false);
    expect(cache.has(2)).toBe(true);
  });

  it("rejects an invalid maxEntries", () => {
    expect(() => new AnnotationPayloadCache<number>(0)).toThrow();
    expect(() => new AnnotationPayloadCache<number>(-1)).toThrow();
  });
});

describe("computePrefetchWindow", () => {
  const ids = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

  it("returns ahead-biased neighbors when walking forward", () => {
    // currentIndex=4 (id=50), forward, ahead=3, behind=1
    const window = computePrefetchWindow(4, ids, "forward", 3, 1);
    // forward neighbors first (60, 70, 80), then the one behind (40)
    expect(window).toEqual([60, 70, 80, 40]);
  });

  it("returns behind-biased neighbors when walking backward", () => {
    const window = computePrefetchWindow(4, ids, "backward", 3, 1);
    // backward neighbors first (40, 30, 20), then the one ahead (60)
    expect(window).toEqual([40, 30, 20, 60]);
  });

  it("clamps at the start of the list", () => {
    const window = computePrefetchWindow(0, ids, "forward", 3, 1);
    expect(window).toEqual([20, 30, 40]);
  });

  it("clamps at the end of the list", () => {
    const window = computePrefetchWindow(ids.length - 1, ids, "forward", 3, 1);
    expect(window).toEqual([90]);
  });

  it("returns an empty window when index is out of bounds", () => {
    expect(computePrefetchWindow(-1, ids)).toEqual([]);
    expect(computePrefetchWindow(99, ids)).toEqual([]);
  });

  it("returns an empty window for an empty navigation list", () => {
    expect(computePrefetchWindow(0, [], "forward")).toEqual([]);
  });

  it("respects custom ahead/behind sizes", () => {
    const window = computePrefetchWindow(5, ids, "forward", 1, 2);
    // ahead=1 → [70], behind=2 → [50, 40]
    expect(window).toEqual([70, 50, 40]);
  });
});

describe("preloadImage", () => {
  it("returns a no-op cancel handle in non-browser environments", () => {
    // jsdom provides a window+Image, so the safest check is that
    // calling cancel() never throws. (Real cancellation is hard to
    // assert without a real network stack.)
    const handle = preloadImage("/api/ct-images/1?size=full");
    expect(typeof handle.cancel).toBe("function");
    expect(() => handle.cancel()).not.toThrow();
    // Calling cancel() twice is also a no-op.
    expect(() => handle.cancel()).not.toThrow();
  });
});
