/**
 * A tiny module-level TTL cache, keyed by string.
 *
 * Lives outside `actions.ts` because a `"use server"` module may only export
 * async functions, and the cache needs a synchronous reset for tests.
 *
 * Used for `listCorrectionSpecies`' detected-species ranking: a GROUP BY over
 * every BirdNET identification (~2.5M rows) that the correction picker asked
 * for once per review session. The ranking only orders a picker list — a count
 * a few minutes stale changes which species sits higher, never what can be
 * chosen — so a short TTL is safe.
 */

export interface TtlCache<T> {
  /** Cached value for `key`, computing (and storing) it when absent or expired. */
  get(key: string, compute: () => T): T;
  /** Drop every entry. */
  clear(): void;
}

export function createTtlCache<T>(
  ttlMs: number,
  now: () => number = Date.now
): TtlCache<T> {
  const entries = new Map<string, { value: T; expiresAt: number }>();
  return {
    get(key, compute) {
      const hit = entries.get(key);
      const t = now();
      if (hit && hit.expiresAt > t) return hit.value;
      const value = compute();
      entries.set(key, { value, expiresAt: t + ttlMs });
      return value;
    },
    clear() {
      entries.clear();
    },
  };
}

/** Cache key for a camera-trap project scope: `'all'`, or the sorted ids. */
export function projectScopeKey(ctProjects: "all" | number[]): string {
  if (ctProjects === "all") return "all";
  return [...ctProjects].sort((a, b) => a - b).join(",") || "none";
}

/** How long the correction picker's detected-species ranking is reused. */
export const DETECTED_SPECIES_TTL_MS = 10 * 60 * 1000;

/** The detected-species counts behind the correction picker, by project scope. */
export const detectedSpeciesCache = createTtlCache<
  Array<{ species: string; n: number }>
>(DETECTED_SPECIES_TTL_MS);

/** Test hook. */
export function __resetDetectedSpeciesCache(): void {
  detectedSpeciesCache.clear();
}
