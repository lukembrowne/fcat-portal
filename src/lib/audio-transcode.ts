/**
 * Audio transcode cache — on-demand AAC (`.m4a`) transcodes of a single curated
 * clip, for browser-universal playback.
 *
 * WHY: compressed audio is FLAC (`audio/flac`), which iOS Safari cannot decode
 * in `<audio>`. The token-gated site-audio route serves an AAC/`audio/mp4`
 * transcode of the featured clip instead. AAC in an MP4 container plays in every
 * mobile + desktop browser.
 *
 * GUARDRAILS (all load-bearing — see KTD-7 of the farmer-sharing refinement plan):
 *  - **Single-flight.** iOS fires several concurrent Range requests on `<audio>`
 *    load. Without coordination each cache-miss would independently download +
 *    spawn ffmpeg and race to write the same path. An in-process map keyed by
 *    `audioId` collapses concurrent callers onto ONE transcode promise.
 *  - **Atomic write.** ffmpeg writes to a temp file; we `rename()` it into the
 *    cache path only once complete, so a concurrent reader never sees a
 *    half-written `.m4a` (which would re-trigger the very playback error we fix).
 *  - **Cache key = `audioId` alone.** Compression pins Drive revisions and the
 *    featured id changes when the team swaps the clip, so the id is a sufficient
 *    key — no extra per-request Drive `revisions` call.
 *  - **Bounded cache with LRU eviction.** The cache dir has a hard byte budget;
 *    the oldest files (by mtime) are evicted when over budget, before each write.
 *
 * Server-only module — never import in a Client Component.
 */

import "server-only";

import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { downloadFile } from "./drive-client";
import { log } from "@/lib/log";

const CACHE_BASE = path.join(process.cwd(), "data", "cache", "audio-transcode");

/** Hard byte budget for the transcode cache dir. Clips are a few MB each, so a
 *  couple of GB holds hundreds of distinct featured clips. */
const CACHE_MAX_BYTES =
  parseInt(process.env.AUDIO_TRANSCODE_CACHE_MAX_GB || "2", 10) *
  1024 *
  1024 *
  1024;

/** Per-transcode wall-clock ceiling. A wedged ffmpeg fails only this request. */
const TRANSCODE_TIMEOUT_MS = 120_000;

function ffmpegBin(): string {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

/** In-process single-flight: one transcode per audioId; concurrent callers await it. */
const inflight = new Map<number, Promise<string>>();

export interface TranscodeSource {
  audioId: number;
  driveFileId: string;
}

/**
 * Ensure an AAC `.m4a` transcode of the given clip exists on disk and return its
 * local path. Single-flighted per `audioId`; safe to call concurrently.
 */
export function ensureAacTranscode(source: TranscodeSource): Promise<string> {
  const existing = inflight.get(source.audioId);
  if (existing) return existing;

  const promise = doEnsureAacTranscode(source).finally(() => {
    inflight.delete(source.audioId);
  });
  inflight.set(source.audioId, promise);
  return promise;
}

function cachePathFor(audioId: number): string {
  return path.join(CACHE_BASE, `${audioId}.m4a`);
}

async function doEnsureAacTranscode(source: TranscodeSource): Promise<string> {
  const { audioId, driveFileId } = source;
  const cachePath = cachePathFor(audioId);

  // Cache hit — bump mtime so LRU tracks recency of use, then serve.
  try {
    await fs.access(cachePath);
    const now = new Date();
    await fs.utimes(cachePath, now, now).catch(() => {});
    return cachePath;
  } catch {
    // miss — transcode below
  }

  await fs.mkdir(CACHE_BASE, { recursive: true });

  // Evict oldest entries before adding a new one (bounded cache).
  await evictIfOverLimit();

  const nonce = randomBytes(6).toString("hex");
  const srcTmp = path.join(CACHE_BASE, `.src-${audioId}-${nonce}`);
  const outTmp = path.join(CACHE_BASE, `.out-${audioId}-${nonce}.m4a`);

  try {
    // 1. Download the source (FLAC/WAV) from Drive to a temp file.
    await downloadFile(driveFileId, srcTmp);

    // 2. Transcode to AAC in an MP4 container. `+faststart` moves the moov atom
    //    to the front so browsers can start playback before the full download.
    await runFfmpegTranscode(srcTmp, outTmp);

    // 3. Atomic publish: rename the finished temp file into the cache path. A
    //    concurrent reader sees the file appear whole or not at all.
    await fs.rename(outTmp, cachePath);

    return cachePath;
  } catch (err) {
    // Best-effort cleanup of the failed output temp file.
    await fs.unlink(outTmp).catch(() => {});
    throw err;
  } finally {
    // Source temp is never needed after transcode (success or failure).
    await fs.unlink(srcTmp).catch(() => {});
  }
}

/**
 * Spawn ffmpeg to transcode `srcPath` → `outPath` (AAC / MP4). Resolves on a
 * clean exit, rejects on non-zero exit, spawn error, or timeout.
 */
function runFfmpegTranscode(srcPath: string, outPath: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const args = [
      "-y",
      "-i",
      srcPath,
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-movflags",
      "+faststart",
      outPath,
    ];

    const proc = spawn(ffmpegBin(), args, { stdio: ["ignore", "ignore", "pipe"] });

    const stderrChunks: string[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill("SIGKILL");
      } catch {
        // process may already be gone
      }
      reject(new Error(`ffmpeg transcode timed out after ${TRANSCODE_TIMEOUT_MS}ms`));
    }, TRANSCODE_TIMEOUT_MS);

    if (proc.stderr) {
      proc.stderr.on("data", (d: Buffer) => {
        stderrChunks.push(d.toString());
      });
    }

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Failed to spawn ffmpeg: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      const tail = stderrChunks.join("").slice(-800);
      reject(new Error(`ffmpeg exited with code ${code}${tail ? `\n${tail}` : ""}`));
    });
  });
}

/**
 * Evict oldest `.m4a` cache files (by mtime) until the cache dir is under the
 * byte budget. Best-effort — a failure never blocks a transcode. Ignores temp
 * (`.src-*` / `.out-*`) files, which are short-lived.
 */
async function evictIfOverLimit(): Promise<void> {
  try {
    let entries: string[];
    try {
      entries = await fs.readdir(CACHE_BASE);
    } catch {
      return; // dir not created yet
    }

    const files: Array<{ name: string; size: number; mtimeMs: number }> = [];
    for (const name of entries) {
      if (!name.endsWith(".m4a") || name.startsWith(".out-")) continue;
      try {
        const stat = await fs.stat(path.join(CACHE_BASE, name));
        if (!stat.isFile()) continue;
        files.push({ name, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // file may have been removed underneath us
      }
    }

    let total = files.reduce((sum, f) => sum + f.size, 0);
    if (total <= CACHE_MAX_BYTES) return;

    // Oldest first.
    files.sort((a, b) => a.mtimeMs - b.mtimeMs);

    for (const f of files) {
      if (total <= CACHE_MAX_BYTES) break;
      try {
        await fs.unlink(path.join(CACHE_BASE, f.name));
        total -= f.size;
        log.info(
          { file: f.name, sizeKb: +(f.size / 1024).toFixed(1) },
          "[audio-transcode] evicted cache entry",
        );
      } catch {
        // ignore — best-effort
      }
    }
  } catch {
    // Eviction is best-effort.
  }
}
