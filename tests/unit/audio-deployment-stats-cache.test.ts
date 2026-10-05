import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUDIO_DEPLOYMENT_STATS_TTL_MS,
  cachedDeploymentStats,
  deploymentStatsKey,
  invalidateAudioDeploymentStats,
  type DeploymentStatsMap,
} from "@/lib/audio-deployment-stats-cache";

function stats(totalDetections: number): DeploymentStatsMap {
  return new Map([[1, { totalDetections, totalSpecies: 1, verifiedCount: 0, unverifiedCount: 0 }]]);
}

afterEach(() => invalidateAudioDeploymentStats());

describe("cachedDeploymentStats", () => {
  it("computes once and serves later loads from the cache", async () => {
    const compute = vi.fn(async () => stats(5));
    await cachedDeploymentStats("k", compute);
    const second = await cachedDeploymentStats("k", compute);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(second.get(1)?.totalDetections).toBe(5);
  });

  it("shares one in-flight computation between concurrent loads", async () => {
    let resolve!: (v: DeploymentStatsMap) => void;
    const compute = vi.fn(() => new Promise<DeploymentStatsMap>((r) => (resolve = r)));
    const a = cachedDeploymentStats("k", compute);
    const b = cachedDeploymentStats("k", compute);
    resolve(stats(3));
    expect(await a).toBe(await b);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("recomputes after invalidation", async () => {
    const compute = vi.fn().mockResolvedValueOnce(stats(5)).mockResolvedValueOnce(stats(6));
    await cachedDeploymentStats("k", compute);
    invalidateAudioDeploymentStats();
    const fresh = await cachedDeploymentStats("k", compute);
    expect(fresh.get(1)?.totalDetections).toBe(6);
  });

  it("recomputes once the TTL lapses", async () => {
    let t = 0;
    const now = () => t;
    const compute = vi.fn(async () => stats(1));
    await cachedDeploymentStats("k", compute, now);
    t = AUDIO_DEPLOYMENT_STATS_TTL_MS - 1;
    await cachedDeploymentStats("k", compute, now);
    expect(compute).toHaveBeenCalledTimes(1);
    t = AUDIO_DEPLOYMENT_STATS_TTL_MS;
    await cachedDeploymentStats("k", compute, now);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("does not keep a failed computation", async () => {
    const compute = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(stats(2));
    await expect(cachedDeploymentStats("k", compute)).rejects.toThrow("boom");
    const retry = await cachedDeploymentStats("k", compute);
    expect(retry.get(1)?.totalDetections).toBe(2);
  });

  it("is shared through globalThis, so a second copy of the module sees invalidations", async () => {
    vi.resetModules();
    const copy = await import("@/lib/audio-deployment-stats-cache");
    const compute = vi.fn().mockResolvedValueOnce(stats(5)).mockResolvedValueOnce(stats(7));
    await cachedDeploymentStats("k", compute);
    copy.invalidateAudioDeploymentStats();
    expect((await cachedDeploymentStats("k", compute)).get(1)?.totalDetections).toBe(7);
  });
});

describe("deploymentStatsKey", () => {
  it("ignores the order per-species thresholds were loaded in", () => {
    const a = new Map([["B b", 0.4], ["A a", 0.3]]);
    const b = new Map([["A a", 0.3], ["B b", 0.4]]);
    expect(deploymentStatsKey(0.7, a)).toBe(deploymentStatsKey(0.7, b));
  });

  it("changes with the global threshold and with any applied species threshold", () => {
    const none = new Map<string, number>();
    expect(deploymentStatsKey(0.7, none)).not.toBe(deploymentStatsKey(0.5, none));
    expect(deploymentStatsKey(0.7, none)).not.toBe(
      deploymentStatsKey(0.7, new Map([["A a", 0.3]]))
    );
  });
});
