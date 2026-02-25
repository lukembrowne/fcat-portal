/**
 * Audio Cache — Downloads audio files from Drive and generates spectrograms.
 *
 * Downloads to data/cache/audio/{deploymentId}/{filename} with persistent caching.
 * Spectrograms generated via Python/librosa, cached alongside audio files.
 * LRU eviction at the deployment level keeps total cache under AUDIO_CACHE_MAX_GB.
 *
 * Server-only module — never import in Client Components.
 */

import "server-only";

import { promises as fs } from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { db } from "@/db";
import { audioFiles } from "@/db/schema";
import { eq } from "drizzle-orm";
import { downloadFile } from "./drive-client";

const execFileAsync = promisify(execFile);

const CACHE_BASE = path.join(process.cwd(), "data", "cache", "audio");
const AUDIO_CACHE_MAX_BYTES =
  parseInt(process.env.AUDIO_CACHE_MAX_GB || "50", 10) * 1024 * 1024 * 1024;

const SPECTROGRAM_SCRIPT = path.join(
  process.cwd(),
  "scripts",
  "generate-spectrogram.py"
);

function getMlPython(): string {
  return (
    process.env.ML_PYTHON_PATH ||
    path.join(process.cwd(), "data", "ml-venv", "bin", "python3")
  );
}

export interface SpectrogramMetadata {
  duration: number;
  sampleRate: number;
  width: number;
  height: number;
  pixelsPerSecond: number;
  hzPerPixel: number;
  fmin: number;
  fmax: number;
  nFft: number;
  hopLength: number;
  nMels: number;
}

/**
 * Ensure an audio file is downloaded from Drive and cached locally.
 * Skips if already cached. Returns the local cache path.
 */
export async function ensureAudioCached(
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
 * Ensure spectrogram PNG is generated for an audio file.
 * Requires audio to be cached first. Returns metadata + path.
 */
export async function ensureSpectrogramGenerated(
  audioFileId: number
): Promise<{ spectrogramPath: string; metadata: SpectrogramMetadata }> {
  const [file] = await db
    .select()
    .from(audioFiles)
    .where(eq(audioFiles.id, audioFileId));

  if (!file) throw new Error(`Audio file ${audioFileId} not found`);

  // Already generated?
  if (file.spectrogramPath) {
    try {
      await fs.access(file.spectrogramPath);
      // Return cached metadata from DB
      return {
        spectrogramPath: file.spectrogramPath,
        metadata: buildMetadataFromDb(file),
      };
    } catch {
      // Spectrogram was evicted — regenerate
    }
  }

  if (!file.cachePath) {
    throw new Error(
      `Audio file ${audioFileId} is not cached — call ensureAudioCached first`
    );
  }

  // Verify the cached audio file exists
  await fs.access(file.cachePath);

  const spectrogramPath = file.cachePath.replace(
    /\.[^.]+$/,
    ".spec.png"
  );

  const pythonPath = getMlPython();

  // Verify Python is available
  try {
    await fs.access(pythonPath);
  } catch {
    throw new Error(
      "ML Python venv not available. Run scripts/ensure-ml-venv.sh first."
    );
  }

  const { stdout } = await execFileAsync(pythonPath, [
    SPECTROGRAM_SCRIPT,
    file.cachePath,
    spectrogramPath,
  ]);

  const metadata: SpectrogramMetadata = JSON.parse(stdout.trim());

  // Update DB with spectrogram path and audio metadata
  await db
    .update(audioFiles)
    .set({
      spectrogramPath,
      duration: metadata.duration,
      sampleRate: metadata.sampleRate,
    })
    .where(eq(audioFiles.id, audioFileId));

  return { spectrogramPath, metadata };
}

/**
 * Build spectrogram metadata from DB-stored values.
 * Used when spectrogram already exists and we don't need to re-run Python.
 */
function buildMetadataFromDb(file: {
  duration: number | null;
  sampleRate: number | null;
  spectrogramPath: string | null;
}): SpectrogramMetadata {
  const duration = file.duration ?? 0;
  const sampleRate = file.sampleRate ?? 48000;
  const fmin = 200;
  const fmax = 12000;
  const height = 512;
  // Reconstruct width from stored metadata
  const nMels = 128;
  const hop = 512;
  const nFrames = Math.ceil((duration * sampleRate) / hop);
  const rawW = nFrames;
  const rawH = nMels;
  const aspect = rawH > 0 ? rawW / rawH : 1;
  const width = Math.round(height * aspect);

  return {
    duration,
    sampleRate,
    width,
    height,
    pixelsPerSecond: duration > 0 ? width / duration : 0,
    hzPerPixel: (fmax - fmin) / height,
    fmin,
    fmax,
    nFft: 2048,
    hopLength: hop,
    nMels,
  };
}

/**
 * Evict oldest cached audio deployment directories when total cache exceeds the limit.
 * Skips the deployment currently being processed.
 * Nulls cachePath and spectrogramPath on evicted files.
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
            .set({ cachePath: null, spectrogramPath: null })
            .where(eq(audioFiles.id, f.id));
        }
      }

      // Delete the directory
      await fs.rm(path.join(CACHE_BASE, dir.name), {
        recursive: true,
        force: true,
      });
      totalSize -= dir.size;

      console.log(
        `[audio-cache] Evicted cache for deployment ${deploymentId} (${(dir.size / 1024 / 1024).toFixed(1)} MB)`
      );
    }
  } catch {
    // Cache eviction is best-effort
  }
}
