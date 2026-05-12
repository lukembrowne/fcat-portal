/**
 * FLAC encoder Node bridge — spawns `scripts/flac-encode-runner.py`, sends a
 * batch of files to encode, and emits parsed NDJSON results back through
 * callbacks. Mirrors the shape of acoustic-indices-runner.ts.
 *
 * Server-only — never import from a Client Component.
 */

import "server-only";

import { spawn } from "child_process";
import path from "path";
import { createInterface } from "readline";
import { db } from "@/db";
import { processingJobs } from "@/db/schema";
import { eq } from "drizzle-orm";
import { log } from "@/lib/log";

const RUNNER_SCRIPT = path.join(
  process.cwd(),
  "scripts",
  "flac-encode-runner.py",
);

function getMlPython(): string {
  return (
    process.env.FLAC_ENCODE_PYTHON_PATH ||
    process.env.ACOUSTIC_INDICES_PYTHON_PATH ||
    process.env.ML_PYTHON_PATH ||
    path.join(process.cwd(), "data", "ml-venv", "bin", "python3")
  );
}

export interface FlacEncodeInputFile {
  id: number;
  wavPath: string;
}

export interface FlacEncodeResult {
  audioFileId: number;
  verdict: "compressed" | "non_compressible";
  wavSize: number;
  flacSize: number;
  flacPath: string | null; // null when verdict=non_compressible
}

export interface FlacEncodeSkip {
  audioFileId: number;
  reason: string;
}

export type FlacEncodeRunResult =
  | { success: true; totalProcessed: number; totalSkipped: number }
  | {
      success: false;
      totalProcessed: number;
      totalSkipped: number;
      error: string;
    };

interface RunOptions {
  jobId: number;
  files: FlacEncodeInputFile[];
  workers?: number;
  compressionLevel?: number;
  subtype?: string;
  onResult: (r: FlacEncodeResult) => Promise<void> | void;
  onSkip?: (s: FlacEncodeSkip) => Promise<void> | void;
  onProgress?: (index: number, total: number) => Promise<void> | void;
  onInfo?: (message: string) => Promise<void> | void;
}

interface NDJSONInfo {
  type: "info";
  message: string;
}
interface NDJSONProgress {
  type: "progress";
  index: number;
  total: number;
}
interface NDJSONResultCompressed {
  type: "result";
  audio_file_id: number;
  verdict: "compressed";
  wav_size: number;
  flac_size: number;
  flac_path: string;
}
interface NDJSONResultNonCompressible {
  type: "result";
  audio_file_id: number;
  verdict: "non_compressible";
  wav_size: number;
  flac_size: number;
}
type NDJSONResult = NDJSONResultCompressed | NDJSONResultNonCompressible;
interface NDJSONSkip {
  type: "skip";
  audio_file_id: number;
  reason: string;
}
interface NDJSONError {
  type: "error";
  message: string;
}
interface NDJSONComplete {
  type: "complete";
  total_processed: number;
  total_skipped: number;
}
type NDJSONMessage =
  | NDJSONInfo
  | NDJSONProgress
  | NDJSONResult
  | NDJSONSkip
  | NDJSONError
  | NDJSONComplete;

export async function runFlacEncoding(
  opts: RunOptions,
): Promise<FlacEncodeRunResult> {
  const {
    jobId,
    files,
    workers = 3,
    compressionLevel = 0.8,
    subtype = "PCM_16",
    onResult,
    onSkip,
    onProgress,
    onInfo,
  } = opts;
  const pythonPath = getMlPython();
  const total = files.length;

  log.info(
    { jobId, total, pythonPath, workers },
    "[flac-encode] Starting batch",
  );

  return new Promise<FlacEncodeRunResult>((resolve) => {
    const proc = spawn(pythonPath, [RUNNER_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let totalProcessed = 0;
    let totalSkipped = 0;
    let lastError: string | null = null;
    const startedAt = Date.now();
    let lastProgressLoggedAt = 0;

    if (proc.pid) {
      db.update(processingJobs)
        .set({ pid: proc.pid })
        .where(eq(processingJobs.id, jobId))
        .then(() => {})
        .catch(() => {});
    }

    const payload = {
      files: files.map((f) => ({ id: f.id, wav_path: f.wavPath })),
      config: { compression_level: compressionLevel, subtype, workers },
    };
    proc.stdin.write(JSON.stringify(payload) + "\n");
    proc.stdin.end();

    const rl = createInterface({ input: proc.stdout });
    rl.on("line", async (line) => {
      let msg: NDJSONMessage;
      try {
        msg = JSON.parse(line) as NDJSONMessage;
      } catch {
        return;
      }

      try {
        if (msg.type === "info") {
          log.info({ jobId, message: msg.message }, "[flac-encode] info");
          if (onInfo) await onInfo(msg.message);
          return;
        }
        if (msg.type === "progress") {
          const now = Date.now();
          if (now - lastProgressLoggedAt > 5000 || msg.index === msg.total) {
            const elapsedSec = (now - startedAt) / 1000;
            const rate = msg.index > 0 ? msg.index / elapsedSec : 0;
            const etaSec = rate > 0 ? (msg.total - msg.index) / rate : 0;
            log.info(
              {
                jobId,
                processed: msg.index,
                total: msg.total,
                rate: +rate.toFixed(2),
                etaSec: +etaSec.toFixed(0),
                elapsedSec: +elapsedSec.toFixed(0),
                rssMB: +(process.memoryUsage().rss / 1024 / 1024).toFixed(0),
              },
              "[flac-encode] progress",
            );
            lastProgressLoggedAt = now;
          }
          if (onProgress) await onProgress(msg.index, msg.total);
          return;
        }
        if (msg.type === "result") {
          totalProcessed++;
          await onResult({
            audioFileId: msg.audio_file_id,
            verdict: msg.verdict,
            wavSize: msg.wav_size,
            flacSize: msg.flac_size,
            flacPath: msg.verdict === "compressed" ? msg.flac_path : null,
          });
          return;
        }
        if (msg.type === "skip") {
          totalSkipped++;
          log.warn(
            { jobId, audioFileId: msg.audio_file_id, reason: msg.reason },
            "[flac-encode] file skipped",
          );
          if (onSkip)
            await onSkip({ audioFileId: msg.audio_file_id, reason: msg.reason });
          return;
        }
        if (msg.type === "error") {
          lastError = msg.message;
          log.error({ jobId, message: msg.message }, "[flac-encode] runner error");
          return;
        }
        if (msg.type === "complete") {
          log.info(
            {
              jobId,
              totalProcessed: msg.total_processed,
              totalSkipped: msg.total_skipped,
            },
            "[flac-encode] batch complete",
          );
          return;
        }
      } catch (err) {
        log.error({ err, line }, "[flac-encode] Failed handling NDJSON line");
      }
    });

    const stderrChunks: string[] = [];
    const stderrRl = createInterface({ input: proc.stderr });
    stderrRl.on("line", (line) => {
      if (!line) return;
      stderrChunks.push(line + "\n");
      log.warn({ jobId, line: line.slice(0, 300) }, "[flac-encode] stderr");
    });

    proc.on("close", (code, signal) => {
      if (code !== 0 && code !== null) {
        const stderr = stderrChunks.join("").slice(-1500);
        const exitInfo = signal ? `signal ${signal}` : `exit code ${code}`;
        log.error(
          { code, signal, stderr },
          "[flac-encode] process exited with error",
        );
        resolve({
          success: false,
          totalProcessed,
          totalSkipped,
          error:
            lastError ||
            `FLAC encoder exited with ${exitInfo}${
              stderr ? `\n${stderr.split("\n").slice(-8).join("\n")}` : ""
            }`,
        });
        return;
      }
      resolve({ success: true, totalProcessed, totalSkipped });
    });

    proc.on("error", (err) => {
      log.error({ err }, "[flac-encode] failed to spawn process");
      resolve({
        success: false,
        totalProcessed,
        totalSkipped,
        error: `Failed to spawn FLAC encoder: ${err.message}`,
      });
    });
  });
}
