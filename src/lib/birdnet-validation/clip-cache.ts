/**
 * Per-sample clip cache for the validation review queue.
 *
 * WHY NOT `/api/audio/stream`: that route streams the whole 60-second source
 * file (~4 MB of FLAC) and relies on the client seeking into it. At 200 clips
 * per species across ~200 species that is roughly 160 GB of Drive egress, and
 * `audio-detection-card.tsx` documents that seeking into a streamed FLAC
 * silently fails in Chrome when the file carries no seek table. A reviewer
 * working at 5-10 species an hour cannot absorb either cost.
 *
 * Instead each sampled detection gets a ~9-second AAC cut (detection window
 * +/- 3s) at roughly 100 KB, which starts at the right offset with no seek and
 * plays on iOS Safari — which cannot decode FLAC at all. A matching spectrogram
 * image is rendered server-side so the reviewer can read the call's shape
 * before pressing play, something the live-painting Web Audio canvas cannot do.
 *
 * Guardrails carried over verbatim from `src/lib/audio-transcode.ts`, all
 * load-bearing for the same reasons: single-flight so concurrent Range requests
 * collapse onto one ffmpeg run, atomic rename so no reader sees a partial file,
 * and LRU eviction against a byte budget so the cache cannot fill the disk (the
 * 2026-05-25 outage started exactly that way).
 */

import "server-only";

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { downloadFile } from "@/lib/drive-client";
import { log } from "@/lib/log";
import { renderSpectrogramPng } from "@/lib/spectrogram-image";
import { decodeLocalAudioToPcmMono } from "@/lib/audio-pcm";
import { CLIP_PADDING_SECONDS, clipWindow, type ClipWindow } from "./clip-geometry";

const CACHE_BASE = path.join(process.cwd(), "data", "cache", "birdnet-clips");

/** Clips are ~100 KB, so a few GB holds tens of thousands of reviewed clips. */
const CACHE_MAX_BYTES =
  parseInt(process.env.BIRDNET_CLIP_CACHE_MAX_GB || "5", 10) * 1024 * 1024 * 1024;

const FFMPEG_TIMEOUT_MS = 60_000;

// The window clamp lives in `clip-geometry.ts` so the audio cut and the review
// page's spectrogram overlay cannot drift apart. Re-exported here because
// callers of this module have always imported it from here.
export { CLIP_PADDING_SECONDS, clipWindow, type ClipWindow };

function ffmpegBin(): string {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

export interface ClipSource {
  /** birdnet_validation_samples.id — the cache key. */
  sampleId: number;
  driveFileId: string;
  startTime: number;
  endTime: number;
  /** Source duration in seconds, when known, so the window can be clamped. */
  duration: number | null;
}

const inflightAudio = new Map<number, Promise<string>>();
const inflightSpectrogram = new Map<number, Promise<string>>();

function audioPath(sampleId: number): string {
  return path.join(CACHE_BASE, `${sampleId}.m4a`);
}

function spectrogramPath(sampleId: number): string {
  return path.join(CACHE_BASE, `${sampleId}.webp`);
}

/** Cache hit check that also bumps mtime, so LRU tracks recency of use. */
async function touchIfPresent(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    const now = new Date();
    await fs.utimes(filePath, now, now).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** Ensure the AAC clip exists on disk; returns its path. Single-flighted. */
export function ensureClipAudio(source: ClipSource): Promise<string> {
  const existing = inflightAudio.get(source.sampleId);
  if (existing) return existing;

  const promise = doEnsureClipAudio(source).finally(() => {
    inflightAudio.delete(source.sampleId);
  });
  inflightAudio.set(source.sampleId, promise);
  return promise;
}

async function doEnsureClipAudio(source: ClipSource): Promise<string> {
  const outPath = audioPath(source.sampleId);
  if (await touchIfPresent(outPath)) return outPath;

  await fs.mkdir(CACHE_BASE, { recursive: true });
  await evictIfOverLimit();

  const nonce = randomBytes(6).toString("hex");
  const srcTmp = path.join(CACHE_BASE, `.src-${source.sampleId}-${nonce}`);
  const outTmp = path.join(CACHE_BASE, `.out-${source.sampleId}-${nonce}.m4a`);
  const win = clipWindow(source);

  try {
    await downloadFile(source.driveFileId, srcTmp);
    await runFfmpegCut(srcTmp, outTmp, win);
    await fs.rename(outTmp, outPath);
    return outPath;
  } catch (err) {
    await fs.unlink(outTmp).catch(() => {});
    throw err;
  } finally {
    await fs.unlink(srcTmp).catch(() => {});
  }
}

/** Ensure the clip's spectrogram image exists on disk; returns its path. */
export function ensureClipSpectrogram(source: ClipSource): Promise<string> {
  const existing = inflightSpectrogram.get(source.sampleId);
  if (existing) return existing;

  const promise = doEnsureClipSpectrogram(source).finally(() => {
    inflightSpectrogram.delete(source.sampleId);
  });
  inflightSpectrogram.set(source.sampleId, promise);
  return promise;
}

async function doEnsureClipSpectrogram(source: ClipSource): Promise<string> {
  const outPath = spectrogramPath(source.sampleId);
  if (await touchIfPresent(outPath)) return outPath;

  await fs.mkdir(CACHE_BASE, { recursive: true });
  await evictIfOverLimit();

  // Render from the already-cut clip rather than the full source: it is small,
  // usually already cached for playback, and guarantees the image and the audio
  // cover exactly the same window.
  const clipPath = await ensureClipAudio(source);
  const nonce = randomBytes(6).toString("hex");
  const outTmp = path.join(CACHE_BASE, `.spec-${source.sampleId}-${nonce}.webp`);

  try {
    const { samples, sampleRate } = await decodeLocalAudioToPcmMono(clipPath);
    const image = await renderSpectrogramPng(samples, sampleRate);
    await fs.writeFile(outTmp, image);
    await fs.rename(outTmp, outPath);
    return outPath;
  } catch (err) {
    await fs.unlink(outTmp).catch(() => {});
    throw err;
  }
}

/** Cut `[win.start, win.end]` out of `srcPath` into AAC/MP4 at `outPath`. */
function runFfmpegCut(srcPath: string, outPath: string, win: ClipWindow): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const args = [
      "-y",
      // -ss BEFORE -i seeks the input, which is far faster than decoding the
      // whole file and discarding the front.
      "-ss",
      win.start.toFixed(3),
      "-t",
      (win.end - win.start).toFixed(3),
      "-i",
      srcPath,
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ac",
      "1",
      // Move the moov atom to the front so playback can start before the whole
      // file arrives — the difference between a snappy queue and a stuttering one.
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
        // already gone
      }
      reject(new Error(`ffmpeg clip cut timed out after ${FFMPEG_TIMEOUT_MS}ms`));
    }, FFMPEG_TIMEOUT_MS);

    proc.stderr?.on("data", (d: Buffer) => stderrChunks.push(d.toString()));

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
      reject(
        new Error(
          `ffmpeg exited with code ${code}${
            stderrChunks.length ? `\n${stderrChunks.join("").slice(-800)}` : ""
          }`
        )
      );
    });
  });
}

/**
 * Evict oldest cache entries until the directory is under budget.
 *
 * Best-effort: a failure here never blocks serving a clip. Temp files
 * (`.src-*`, `.out-*`, `.spec-*`) are skipped — they are short-lived and
 * removing one underneath its writer would corrupt an in-flight cut.
 */
async function evictIfOverLimit(): Promise<void> {
  try {
    let entries: string[];
    try {
      entries = await fs.readdir(CACHE_BASE);
    } catch {
      return;
    }

    const files: Array<{ name: string; size: number; mtimeMs: number }> = [];
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      if (!name.endsWith(".m4a") && !name.endsWith(".webp")) continue;
      try {
        const stat = await fs.stat(path.join(CACHE_BASE, name));
        if (stat.isFile()) files.push({ name, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // removed underneath us
      }
    }

    let total = files.reduce((sum, f) => sum + f.size, 0);
    if (total <= CACHE_MAX_BYTES) return;

    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const f of files) {
      if (total <= CACHE_MAX_BYTES) break;
      try {
        await fs.unlink(path.join(CACHE_BASE, f.name));
        total -= f.size;
        log.info({ file: f.name }, "[birdnet-clips] evicted cache entry");
      } catch {
        // best-effort
      }
    }
  } catch {
    // best-effort
  }
}
