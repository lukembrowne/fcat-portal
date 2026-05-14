/**
 * Acoustic Indices Runner — Single-shot Python CLI bridge.
 *
 * Spawns `scripts/acoustic-indices-runner.py`, parses NDJSON stdout, and
 * delegates each `result` / `skip` message to the caller via callbacks
 * (so the caller controls DB writes and revalidation).
 *
 * Server-only — never import in Client Components.
 */

import "server-only";

import { spawn } from "child_process";
import path from "path";
import { createInterface } from "readline";
import { db } from "@/db";
import { processingJobs } from "@/db/schema";
import { eq } from "drizzle-orm";
import { log } from "@/lib/log";
import {
  CONFIG_VERSION,
  DIEL_PERIODS,
  DIEL_PERIOD_RANGES,
  INDEX_CONFIG,
  type DielPeriod,
} from "@/lib/acoustic-indices";

const RUNNER_SCRIPT = path.join(
  process.cwd(),
  "scripts",
  "acoustic-indices-runner.py"
);

function getMlPython(): string {
  return (
    process.env.ACOUSTIC_INDICES_PYTHON_PATH ||
    process.env.ML_PYTHON_PATH ||
    path.join(process.cwd(), "data", "ml-venv", "bin", "python3")
  );
}

export interface AcousticIndicesInputFile {
  id: number;
  path: string;
  filename: string;
}

export interface AcousticIndicesResult {
  audioFileId: number;
  configHash: string;
  recordedDate: string | null;
  dielPeriod: DielPeriod;
  soundscapeSaturation: number | null;
  acousticComplexityIndex: number | null;
  frequencyEntropy: number | null;
  temporalEntropy: number | null;
  eventsPerSecond: number | null;
}

export interface AcousticIndicesSkip {
  audioFileId: number;
  reason: string;
}

export type AcousticIndicesRunResult =
  | {
      success: true;
      totalProcessed: number;
      totalSkipped: number;
      configHash: string | null;
    }
  | {
      success: false;
      totalProcessed: number;
      totalSkipped: number;
      configHash: string | null;
      error: string;
    };

interface RunOptions {
  jobId: number;
  files: AcousticIndicesInputFile[];
  onResult: (result: AcousticIndicesResult) => Promise<void> | void;
  onSkip?: (skip: AcousticIndicesSkip) => Promise<void> | void;
  onProgress?: (index: number, total: number) => Promise<void> | void;
  /**
   * Global progress offset for chunked runs. The runner writes
   * `processedImages = offset + chunkLocalIdx` and surfaces `statusMessage`
   * using `(offset + idx) de grandTotal`, so the UI bar ticks smoothly
   * across all chunks.
   */
  offset?: number;
  grandTotal?: number;
}

interface NDJSONInfo {
  type: "info";
  message: string;
  config_hash?: string;
}
interface NDJSONProgress {
  type: "progress";
  index: number;
  total: number;
}
interface NDJSONResult {
  type: "result";
  audio_file_id: number;
  config_hash: string;
  recorded_date: string | null;
  diel_period: DielPeriod;
  soundscape_saturation: number;
  acoustic_complexity_index: number;
  frequency_entropy: number;
  temporal_entropy: number;
  events_per_second: number;
}
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

export async function runAcousticIndicesAnalysis(
  opts: RunOptions
): Promise<AcousticIndicesRunResult> {
  const { jobId, files, onResult, onSkip, onProgress } = opts;
  const pythonPath = getMlPython();
  const total = files.length;
  const globalOffset = opts.offset ?? 0;
  const globalTotal = opts.grandTotal ?? total;

  log.info(
    { jobId, total, pythonPath },
    "[acoustic-indices] Starting analysis"
  );

  return new Promise<AcousticIndicesRunResult>((resolve) => {
    const proc = spawn(pythonPath, [RUNNER_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let totalProcessed = 0;
    let totalSkipped = 0;
    let configHash: string | null = null;
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

    // Build stdin payload — drives Python from the single TS source of truth.
    const payload = {
      files: files.map((f) => ({
        id: f.id,
        path: f.path,
        filename: f.filename,
      })),
      config: INDEX_CONFIG,
      config_version: CONFIG_VERSION,
      diel_periods: DIEL_PERIODS,
      diel_period_ranges: DIEL_PERIOD_RANGES,
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
          if (msg.config_hash) configHash = msg.config_hash;
          // Skip Python's chunk-local "Progreso: X/Y" message — overwrites
          // the global statusMessage written by the progress handler below.
          if (msg.message.startsWith("Progreso:")) {
            log.info(
              { jobId, message: msg.message },
              "[acoustic-indices] info (chunk-local)",
            );
            return;
          }
          log.info({ jobId, message: msg.message }, "[acoustic-indices] info");
          await db
            .update(processingJobs)
            .set({ statusMessage: msg.message })
            .where(eq(processingJobs.id, jobId));
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
              "[acoustic-indices] progress"
            );
            lastProgressLoggedAt = now;
          }
          const globalIdx = globalOffset + msg.index;
          await db
            .update(processingJobs)
            .set({
              processedImages: globalIdx,
              statusMessage: `Calculando índices acústicos... (${globalIdx} de ${globalTotal})`,
            })
            .where(eq(processingJobs.id, jobId));
          if (onProgress) await onProgress(msg.index, msg.total);
          return;
        }

        if (msg.type === "result") {
          totalProcessed++;
          await onResult({
            audioFileId: msg.audio_file_id,
            configHash: msg.config_hash,
            recordedDate: msg.recorded_date,
            dielPeriod: msg.diel_period,
            soundscapeSaturation: msg.soundscape_saturation,
            acousticComplexityIndex: msg.acoustic_complexity_index,
            frequencyEntropy: msg.frequency_entropy,
            temporalEntropy: msg.temporal_entropy,
            eventsPerSecond: msg.events_per_second,
          });
          return;
        }

        if (msg.type === "skip") {
          totalSkipped++;
          log.warn(
            { jobId, audioFileId: msg.audio_file_id, reason: msg.reason },
            "[acoustic-indices] file skipped"
          );
          if (onSkip) await onSkip({ audioFileId: msg.audio_file_id, reason: msg.reason });
          return;
        }

        if (msg.type === "error") {
          lastError = msg.message;
          log.error({ jobId, message: msg.message }, "[acoustic-indices] error");
          return;
        }

        if (msg.type === "complete") {
          log.info(
            {
              jobId,
              totalProcessed: msg.total_processed,
              totalSkipped: msg.total_skipped,
            },
            "[acoustic-indices] Analysis complete"
          );
          return;
        }
      } catch (err) {
        log.error({ err, line }, "[acoustic-indices] Failed handling NDJSON line");
      }
    });

    const stderrChunks: string[] = [];
    const stderrRl = createInterface({ input: proc.stderr });
    stderrRl.on("line", (line) => {
      if (!line) return;
      stderrChunks.push(line + "\n");
      log.warn({ jobId, line: line.slice(0, 300) }, "[acoustic-indices] stderr");
    });

    proc.on("close", (code, signal) => {
      if (code !== 0 && code !== null) {
        const stderr = stderrChunks.join("").slice(-1500);
        const exitInfo = signal ? `signal ${signal}` : `exit code ${code}`;
        log.error(
          { code, signal, stderr },
          "[acoustic-indices] Process exited with error"
        );
        resolve({
          success: false,
          totalProcessed,
          totalSkipped,
          configHash,
          error:
            lastError ||
            `Acoustic indices runner exited with ${exitInfo}${
              stderr ? `\n${stderr.split("\n").slice(-8).join("\n")}` : ""
            }`,
        });
        return;
      }

      resolve({
        success: true,
        totalProcessed,
        totalSkipped,
        configHash,
      });
    });

    proc.on("error", (err) => {
      log.error({ err }, "[acoustic-indices] Failed to spawn process");
      resolve({
        success: false,
        totalProcessed,
        totalSkipped,
        configHash,
        error: `Failed to spawn acoustic indices runner: ${err.message}`,
      });
    });
  });
}
