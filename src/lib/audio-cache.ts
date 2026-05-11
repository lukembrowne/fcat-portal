/**
 * Audio Cache — Downloads audio files from Drive with persistent caching.
 *
 * Downloads to data/cache/audio/{deploymentId}/{filename} with persistent caching.
 * LRU eviction at the deployment level keeps total cache under AUDIO_CACHE_MAX_GB.
 *
 * Server-only module — never import in Client Components.
 */

import "server-only";

import { promises as fs } from "fs";
import path from "path";
import { db } from "@/db";
import { audioFiles } from "@/db/schema";
import { eq, inArray } from "drizzle-orm";
import { downloadFile } from "./drive-client";
import { log } from "@/lib/log";

const CACHE_BASE = path.join(process.cwd(), "data", "cache", "audio");
const AUDIO_CACHE_MAX_BYTES =
  parseInt(process.env.AUDIO_CACHE_MAX_GB || "50", 10) * 1024 * 1024 * 1024;

// Inflight deduplication — prevents concurrent calls for the same file
// from spawning duplicate downloads.
const inflight = new Map<string, Promise<unknown>>();

function dedupe<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;

  const promise = fn().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

/**
 * Ensure an audio file is downloaded from Drive and cached locally.
 * Skips if already cached. Returns the local cache path.
 */
export function ensureAudioCached(
  audioFileId: number
): Promise<string> {
  return dedupe(`audio:${audioFileId}`, () => doEnsureAudioCached(audioFileId));
}

async function doEnsureAudioCached(
  audioFileId: number
): Promise<string> {
  const [file] = await db
    .select()
    .from(audioFiles)
    .where(eq(audioFiles.id, audioFileId));

  if (!file) throw new Error(`Audio file ${audioFileId} not found`);

  // Already cached?
  if (file.cachePath) {
    try {
      await fs.access(file.cachePath);
      return file.cachePath;
    } catch {
      // File was evicted from disk — re-download
    }
  }

  if (!file.driveFileId) {
    throw new Error(
      `Audio file ${audioFileId} has no Drive file ID (may have been removed from Drive)`
    );
  }

  // Evict oldest cached deployments if over size limit
  await evictIfOverLimit(file.deploymentId);

  const cacheDir = path.join(CACHE_BASE, String(file.deploymentId));
  await fs.mkdir(cacheDir, { recursive: true });

  const localPath = path.join(cacheDir, file.filename);

  // Check if file exists on disk (might be cached without DB knowing)
  try {
    await fs.access(localPath);
  } catch {
    await downloadFile(file.driveFileId, localPath);
  }

  // Update DB
  await db
    .update(audioFiles)
    .set({ cachePath: localPath })
    .where(eq(audioFiles.id, audioFileId));

  return localPath;
}

/**
 * Actively release a set of audio files from the cache.
 *
 * Used by the chunked audio_analysis orchestrator to free disk after each
 * chunk finishes (rather than waiting for cap-driven LRU). Best-effort: a
 * missing file on disk or a failed unlink does not throw.
 */
export async function releaseFiles(audioFileIds: number[]): Promise<void> {
  if (audioFileIds.length === 0) return;

  const rows = await db
    .select()
    .from(audioFiles)
    .where(inArray(audioFiles.id, audioFileIds));

  for (const row of rows) {
    if (row.cachePath) {
      try {
        await fs.unlink(row.cachePath);
      } catch {
        // file may already be gone; safe to ignore
      }
    }
  }

  await db
    .update(audioFiles)
    .set({ cachePath: null })
    .where(inArray(audioFiles.id, audioFileIds));
}

/**
 * Evict oldest cached audio deployment directories when total cache exceeds the limit.
 * Skips the deployment currently being processed.
 * Nulls cachePath on evicted files.
 */
async function evictIfOverLimit(currentDeploymentId: number): Promise<void> {
  try {
    let entries: string[];
    try {
      entries = await fs.readdir(CACHE_BASE);
    } catch {
      return; // Cache directory doesn't exist yet
    }

    const dirStats: Array<{ name: string; size: number; mtime: Date }> = [];

    for (const entry of entries) {
      const dirPath = path.join(CACHE_BASE, entry);
      const stat = await fs.stat(dirPath);
      if (!stat.isDirectory()) continue;

      let dirSize = 0;
      const files = await fs.readdir(dirPath);
      for (const file of files) {
        try {
          const fileStat = await fs.stat(path.join(dirPath, file));
          dirSize += fileStat.size;
        } catch {
          // File may have been removed
        }
      }

      dirStats.push({ name: entry, size: dirSize, mtime: stat.mtime });
    }

    let totalSize = dirStats.reduce((sum, d) => sum + d.size, 0);

    if (totalSize <= AUDIO_CACHE_MAX_BYTES) return;

    // Sort by mtime ascending (oldest first)
    dirStats.sort((a, b) => a.mtime.getTime() - b.mtime.getTime());

    for (const dir of dirStats) {
      if (totalSize <= AUDIO_CACHE_MAX_BYTES) break;
      if (dir.name === String(currentDeploymentId)) continue;

      const deploymentId = parseInt(dir.name, 10);
      if (isNaN(deploymentId)) continue;

      // Null out cache paths for this deployment
      const depFiles = await db
        .select()
        .from(audioFiles)
        .where(eq(audioFiles.deploymentId, deploymentId));

      for (const f of depFiles) {
        if (f.cachePath && f.cachePath.includes("/cache/audio/")) {
          await db
            .update(audioFiles)
            .set({ cachePath: null })
            .where(eq(audioFiles.id, f.id));
        }
      }

      // Delete the directory
      await fs.rm(path.join(CACHE_BASE, dir.name), {
        recursive: true,
        force: true,
      });
      totalSize -= dir.size;

      log.info(
        { deploymentId, sizeMb: +(dir.size / 1024 / 1024).toFixed(1) },
        "[audio-cache] Evicted cache for deployment"
      );
    }
  } catch {
    // Cache eviction is best-effort
  }
}
