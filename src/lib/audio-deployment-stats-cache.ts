/**
 * Process-wide cache for the /audio page's per-deployment BirdNET totals
 * (detections, species, verified, pending).
 *
 * WHY. Those four numbers come from one GROUP BY over every BirdNET
 * identification joined to its detection and file — ~2.5M rows, 2.0–2.5 s on
 * the dev DB — and the page recomputed them on every load and every change of
 * the confidence slider. No index fixes it: the query is a sum over the whole
 * table, not a lookup (a covering index only reached 1.46 s for +100 MB). The
 * totals only move when detections are written, verified or deleted, so they
 * are computed once per (threshold, applied per-species thresholds) and
 * dropped by `invalidateAudioDeploymentStats()` at every such write.
 *
 * WHY globalThis AND NOT A MODULE VARIABLE. The writers are spread across
 * bundles: annotation and job actions run in the app graph, but a BirdNET job
 * resumed after a restart runs from `instrumentation.ts`, which Next compiles
 * separately and so gets its own copy of every module. A module-level cache
 * would leave that copy invalidating a map the page never reads.
 *
 * The TTL is a safety net for writers outside this process — maintenance
 * scripts such as `scripts/remove-stray-audio.mjs` — not the freshness
 * mechanism. In-process writes are visible on the next load.
 */

export interface DeploymentDetectionStats {
  totalDetections: number;
  totalSpecies: number;
  verifiedCount: number;
  unverifiedCount: number;
}

export type DeploymentStatsMap = Map<number, DeploymentDetectionStats>;

/** How long a computed set of totals is reused if nothing invalidates it. */
export const AUDIO_DEPLOYMENT_STATS_TTL_MS = 10 * 60 * 1000;

interface Entry {
  promise: Promise<DeploymentStatsMap>;
  expiresAt: number;
}

const STORE_KEY = Symbol.for("fcat-portal.audioDeploymentStats");

function entries(): Map<string, Entry> {
  const g = globalThis as { [STORE_KEY]?: Map<string, Entry> };
  return (g[STORE_KEY] ??= new Map());
}

/**
 * Cache key: the global threshold plus every applied per-species threshold,
 * since both change which detections count as visible. Applying or reverting a
 * fitted threshold therefore yields a new key rather than needing an
 * invalidation call.
 */
export function deploymentStatsKey(
  threshold: number,
  speciesThresholds: ReadonlyMap<string, number>
): string {
  const species = [...speciesThresholds.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  return JSON.stringify([threshold, species]);
}

/**
 * The cached totals for `key`, computing them when absent or expired.
 *
 * Concurrent callers share one in-flight computation. A failed computation is
 * evicted so the next load retries instead of replaying the error for the TTL.
 */
export function cachedDeploymentStats(
  key: string,
  compute: () => Promise<DeploymentStatsMap>,
  now: () => number = Date.now
): Promise<DeploymentStatsMap> {
  const store = entries();
  const t = now();
  const hit = store.get(key);
  if (hit && hit.expiresAt > t) return hit.promise;

  const entry: Entry = { promise: compute(), expiresAt: t + AUDIO_DEPLOYMENT_STATS_TTL_MS };
  store.set(key, entry);
  entry.promise.catch(() => {
    if (store.get(key) === entry) store.delete(key);
  });
  return entry.promise;
}

/**
 * Drop every cached total. Call after any write that changes BirdNET
 * detections or their verification status. Cheap — clears a map — so call it
 * per write rather than batching.
 */
export function invalidateAudioDeploymentStats(): void {
  entries().clear();
}
