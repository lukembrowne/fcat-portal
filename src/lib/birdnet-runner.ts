/**
 * BirdNET Runner — Single-shot Python CLI Bridge
 *
 * Spawns birdnet-runner.py, parses NDJSON stdout, and inserts detection
 * results into the database. Unlike ml-runner.ts, this is a single-shot
 * process (no persistent server, no idle timer).
 *
 * Server-only module — never import in Client Components.
 */

import "server-only";

import { spawn } from "child_process";
import path from "path";
import os from "os";
import { createInterface } from "readline";
import { db } from "@/db";
import {
  processingJobs,
  audioDetections,
  audioIdentifications,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { log } from "@/lib/log";

const BIRDNET_SCRIPT = path.join(
  process.cwd(),
  "scripts",
  "birdnet-runner.py"
);

function getMlPython(): string {
  return (
    process.env.BIRDNET_PYTHON_PATH ||
    process.env.ML_PYTHON_PATH ||
    path.join(process.cwd(), "data", "ml-venv", "bin", "python3")
  );
}

export type BirdNETRunResult =
  | { success: true; totalProcessed: number; totalDetections: number }
  | { success: false; totalProcessed: number; totalDetections: number; error: string };

interface BirdNETConfig {
  audioDir: string;
  lat: number;
  lon: number;
  week: number;
  minConf: number;
  threads: number;
  totalFiles: number;
  sensitivity?: number;
  overlap?: number;
}

interface NDJSONProgress {
  type: "progress";
  index: number;
  total: number;
}

interface NDJSONResult {
  type: "result";
  file: string;
  detections: Array<{
    start: number;
    end: number;
    scientific_name: string;
    common_name: string;
    confidence: number;
  }>;
}

interface NDJSONInfo {
  type: "info";
  message: string;
}

interface NDJSONError {
  type: "error";
  message: string;
}

interface NDJSONComplete {
  type: "complete";
  total_processed: number;
  total_detections: number;
}

type NDJSONMessage = NDJSONProgress | NDJSONResult | NDJSONInfo | NDJSONError | NDJSONComplete;

export async function runBirdNETAnalysis(
  jobId: number,
  config: BirdNETConfig,
  filenameToFileId: Map<string, number>,
): Promise<BirdNETRunResult> {
  const pythonPath = getMlPython();
  const threads = Math.max(1, Math.min(config.threads, os.availableParallelism?.() ?? os.cpus().length) - 1);

  log.info(
    { jobId, audioDir: config.audioDir, totalFiles: config.totalFiles, threads },
    "[birdnet] Starting analysis"
  );

  return new Promise<BirdNETRunResult>((resolve) => {
    const proc = spawn(pythonPath, [BIRDNET_SCRIPT], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let totalProcessed = 0;
    let totalDetections = 0;
    let lastError: string | null = null;
    const startedAt = Date.now();
    let lastProgressLoggedAt = 0;

    // Store PID on job for cancellation
    if (proc.pid) {
      db.update(processingJobs)
        .set({ pid: proc.pid })
        .where(eq(processingJobs.id, jobId))
        .then(() => {})
        .catch(() => {});
    }

    // Send config to stdin
    const stdinConfig = JSON.stringify({
      audio_dir: config.audioDir,
      output_dir: "",
      lat: config.lat,
      lon: config.lon,
      week: config.week,
      min_conf: config.minConf,
      threads,
      total_files: config.totalFiles,
      sensitivity: config.sensitivity ?? 1.0,
      overlap: config.overlap ?? 1.0,
    });
    proc.stdin.write(stdinConfig + "\n");
    proc.stdin.end();

    // Parse NDJSON from stdout
    const rl = createInterface({ input: proc.stdout });

    rl.on("line", async (line) => {
      try {
        const msg: NDJSONMessage = JSON.parse(line);

        if (msg.type === "info") {
          log.info({ message: msg.message }, "[birdnet] info");
          await db
            .update(processingJobs)
            .set({ statusMessage: msg.message })
            .where(eq(processingJobs.id, jobId));
          return;
        }

        if (msg.type === "progress") {
          const now = Date.now();
          // Throttle log output to once every 5s, but always log at start/end
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
              "[birdnet] progress"
            );
            lastProgressLoggedAt = now;
          }
          await db
            .update(processingJobs)
            .set({
              processedImages: msg.index,
              statusMessage: `Analizando audio... (${msg.index} de ${msg.total})`,
            })
            .where(eq(processingJobs.id, jobId));
          return;
        }

        if (msg.type === "result") {
          totalProcessed++;

          // Find the audioFile ID for this filename
          // Try exact match first, then try without extension
          let audioFileId = filenameToFileId.get(msg.file);
          if (!audioFileId) {
            // BirdNET may strip extension — try matching with common extensions
            for (const [fname, fid] of filenameToFileId) {
              const base = fname.replace(/\.[^.]+$/, "");
              if (base === msg.file) {
                audioFileId = fid;
                break;
              }
            }
          }

          if (!audioFileId) {
            log.warn({ file: msg.file }, "[birdnet] No matching audio file ID found");
            return;
          }

          // Insert detections for this file
          for (const det of msg.detections) {
            const [detection] = await db
              .insert(audioDetections)
              .values({
                audioFileId,
                jobId,
                startTime: det.start,
                endTime: det.end,
                minFreq: 0,
                maxFreq: 15000,
                confidence: det.confidence,
                modelVersion: "birdnet-analyzer",
              })
              .returning();

            await db.insert(audioIdentifications).values({
              audioDetectionId: detection.id,
              species: det.scientific_name,
              confidence: det.confidence,
              modelVersion: "birdnet-analyzer",
              verificationStatus: "unverified",
            });

            totalDetections++;
          }

          await db
            .update(processingJobs)
            .set({
              processedImages: totalProcessed,
              statusMessage: `Analizando audio... (${totalProcessed} de ${config.totalFiles})`,
            })
            .where(eq(processingJobs.id, jobId));
          return;
        }

        if (msg.type === "error") {
          log.error({ message: msg.message }, "[birdnet] error");
          lastError = msg.message;
          return;
        }

        if (msg.type === "complete") {
          log.info(
            {
              jobId,
              totalProcessed: msg.total_processed,
              totalDetections: msg.total_detections,
              rssMB: +(process.memoryUsage().rss / 1024 / 1024).toFixed(0),
            },
            "[birdnet] Analysis complete"
          );
          return;
        }
      } catch {
        // Ignore JSON parse errors
      }
    });

    // Log stderr (Python errors / tracebacks — separate from BirdNET progress, which now comes via NDJSON info messages)
    const stderrChunks: string[] = [];
    const stderrRl = createInterface({ input: proc.stderr });
    stderrRl.on("line", (line) => {
      if (!line) return;
      stderrChunks.push(line + "\n");
      log.warn({ jobId, line: line.slice(0, 300) }, "[birdnet] stderr");
    });

    proc.on("close", (code) => {
      if (code !== 0 && code !== null) {
        const stderr = stderrChunks.join("").slice(-1000);
        log.error({ code, stderr }, "[birdnet] Process exited with error");
        resolve({
          success: false,
          totalProcessed,
          totalDetections,
          error: lastError || `BirdNET exited with code ${code}`,
        });
        return;
      }

      resolve({
        success: true,
        totalProcessed,
        totalDetections,
      });
    });

    proc.on("error", (err) => {
      log.error({ err }, "[birdnet] Failed to spawn process");
      resolve({
        success: false,
        totalProcessed,
        totalDetections,
        error: `Failed to spawn BirdNET: ${err.message}`,
      });
    });
  });
}
