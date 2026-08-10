/**
 * Server-side audio → PCM decode.
 *
 * Downloads a clip from Drive and decodes it to mono float32 PCM via ffmpeg,
 * so server code can run the spectrogram FFT (which the browser does with the
 * Web Audio `AudioContext`, unavailable in Node). Modeled on the ffmpeg spawn
 * pattern in `audio-transcode.ts` — same `FFMPEG_PATH`, same timeout guard.
 *
 * The sample rate is forced to a known value so callers don't have to probe it;
 * for spectrogram display (max 12 kHz) 48 kHz is ample.
 *
 * Server-only module — never import in a Client Component.
 */

import "server-only";

import { spawn } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { downloadFile } from "./drive-client";

/** Forced decode sample rate. Nyquist (24 kHz) comfortably covers the 12 kHz display ceiling. */
const PCM_SAMPLE_RATE = 48000;

/** Per-decode wall-clock ceiling. A wedged ffmpeg fails only this call. */
const DECODE_TIMEOUT_MS = 120_000;

const TMP_BASE = path.join(process.cwd(), "data", "cache", "audio-pcm");

function ffmpegBin(): string {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

export interface PcmResult {
  samples: Float32Array;
  sampleRate: number;
}

/**
 * Download `driveFileId` and decode it to mono float32 PCM. Resolves with the
 * samples and the (forced) sample rate; rejects on download or ffmpeg failure.
 */
export async function decodeAudioToPcmMono(driveFileId: string): Promise<PcmResult> {
  await fs.mkdir(TMP_BASE, { recursive: true });
  const nonce = randomBytes(6).toString("hex");
  const srcTmp = path.join(TMP_BASE, `.src-${nonce}`);

  try {
    await downloadFile(driveFileId, srcTmp);
    return await decodeLocalAudioToPcmMono(srcTmp);
  } finally {
    await fs.unlink(srcTmp).catch(() => {});
  }
}

/**
 * Decode an audio file already on disk to mono float32 PCM.
 *
 * Split out of the Drive path so callers that have produced a local file — the
 * BirdNET validation clip cache cuts one with ffmpeg — can render its
 * spectrogram without a redundant download.
 */
export async function decodeLocalAudioToPcmMono(
  localPath: string
): Promise<PcmResult> {
  const raw = await runFfmpegPcm(localPath);
  // f32le little-endian → Float32Array. Copy out of the pooled Buffer so the
  // result owns its memory. Guard against a non-4-aligned byte length.
  const usable = raw.byteLength - (raw.byteLength % 4);
  const view = new Float32Array(raw.buffer, raw.byteOffset, usable / 4);
  return { samples: Float32Array.from(view), sampleRate: PCM_SAMPLE_RATE };
}

/** Spawn ffmpeg to decode `srcPath` → mono f32le PCM on stdout. */
function runFfmpegPcm(srcPath: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const args = [
      "-y",
      "-i",
      srcPath,
      "-ac",
      "1",
      "-ar",
      String(PCM_SAMPLE_RATE),
      "-f",
      "f32le",
      "-acodec",
      "pcm_f32le",
      "-",
    ];

    const proc = spawn(ffmpegBin(), args, { stdio: ["ignore", "pipe", "pipe"] });

    const stdoutChunks: Buffer[] = [];
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
      reject(new Error(`ffmpeg pcm decode timed out after ${DECODE_TIMEOUT_MS}ms`));
    }, DECODE_TIMEOUT_MS);

    proc.stdout?.on("data", (d: Buffer) => stdoutChunks.push(d));
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
        resolve(Buffer.concat(stdoutChunks));
        return;
      }
      const tail = stderrChunks.join("").slice(-800);
      reject(new Error(`ffmpeg exited with code ${code}${tail ? `\n${tail}` : ""}`));
    });
  });
}
