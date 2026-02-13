/**
 * ML Runner — Persistent Model Server Bridge
 *
 * Manages a singleton Python model server process that loads ML models once
 * and reuses them across jobs. First job pays the model loading cost (~30-60s);
 * subsequent jobs start analyzing immediately.
 *
 * The server auto-shuts down after 10 minutes idle to free memory (~200-300MB).
 *
 * Server-only module — never import in Client Components.
 */

import "server-only";

import { ChildProcess, spawn, execFile } from "child_process";
import { promisify } from "util";
import path from "path";
import { createInterface } from "readline";
import { db } from "@/db";
import {
  processingJobs,
  images,
  detections,
  identifications,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { ML_DEFAULTS } from "@/lib/ml-defaults";

const execFileAsync = promisify(execFile);

export interface MLConfig {
  imagePaths: string[];
  detectorModel: string;
  classifierModel: string;
  device: string;
  confidenceThreshold: number;
  batchSize: number;
}

export interface MLRunResult {
  success: boolean;
  totalProcessed: number;
  totalDetections: number;
  error?: string;
}

interface DetectionResult {
  bbox: { x: number; y: number; width: number; height: number };
  detection_confidence: number;
  detection_class: number;
  classification: { species: string; confidence: number } | null;
}

interface NDJSONMessage {
  type: "progress" | "result" | "error" | "complete" | "info" | "server_ready";
  image?: string;
  index?: number;
  total?: number;
  detections?: DetectionResult[];
  message?: string;
  total_processed?: number;
  total_detections?: number;
  cancelled?: boolean;
  device?: string;
  detector?: string;
  classifier?: string;
}

interface JobContext {
  jobId: number;
  imagePathToId: Map<string, number>;
  config: MLConfig;
  processedCount: number;
  failedCount: number;
  totalDetections: number;
  resolve: (result: MLRunResult) => void;
}

// ---------------------------------------------------------------------------
// Singleton Model Server State
// ---------------------------------------------------------------------------

let serverProc: ChildProcess | null = null;
let serverStatus: "starting" | "ready" | "busy" | "dead" = "dead";
let serverReadyResolve: (() => void) | null = null;
let serverReadyReject: ((err: Error) => void) | null = null;
let currentJob: JobContext | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// Python Discovery
// ---------------------------------------------------------------------------

async function findPython(): Promise<string | null> {
  const envPython = process.env.ML_PYTHON_PATH;
  const candidates = envPython
    ? [envPython, "python3", "python"]
    : ["python3", "python"];

  console.log(`[ml-runner] findPython: ML_PYTHON_PATH=${envPython}, candidates=${candidates.join(", ")}`);

  for (const candidate of candidates) {
    try {
      const { stdout } = await execFileAsync(candidate, ["--version"]);
      console.log(`[ml-runner] findPython: ${candidate} → ${stdout.trim()}`);
      return candidate;
    } catch (err) {
      console.log(`[ml-runner] findPython: ${candidate} failed: ${err instanceof Error ? err.message : err}`);
      continue;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// ML Availability Check
// ---------------------------------------------------------------------------

export async function checkPytorchWildlife(): Promise<{
  available: boolean;
  python: string | null;
  message: string;
}> {
  const python = await findPython();
  if (!python) {
    return {
      available: false,
      python: null,
      message: "Python 3 no encontrado. Instale Python 3.10+ para usar ML.",
    };
  }

  try {
    const { stdout } = await execFileAsync(python, [
      "-c",
      "import PytorchWildlife; print(PytorchWildlife.__version__)",
    ]);
    const version = stdout.trim().split("\n").pop();

    // Pre-warm: fire-and-forget start the model server so it's ready
    // by the time the user clicks "Procesar"
    ensureModelServer().catch(() => {});

    return {
      available: true,
      python,
      message: `pytorch-wildlife ${version} disponible (usando ${python})`,
    };
  } catch (err: unknown) {
    const stderr = (err as { stderr?: string })?.stderr || "";
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ml-runner] PytorchWildlife import failed:\n  error: ${msg}\n  stderr: ${stderr}`);
    return {
      available: false,
      python,
      message: `pytorch-wildlife no encontrado vía ${python}. Configure ML_PYTHON_PATH o ejecute: pip install -r scripts/requirements-inference.txt`,
    };
  }
}

// ---------------------------------------------------------------------------
// Model Server Lifecycle
// ---------------------------------------------------------------------------

function resetIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  idleTimer = setTimeout(() => {
    console.log("[ml-runner] Idle timeout reached, shutting down model server");
    shutdownModelServer();
  }, IDLE_TIMEOUT_MS);
}

function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

export function shutdownModelServer(): void {
  clearIdleTimer();
  if (serverProc) {
    console.log("[ml-runner] Shutting down model server");
    try {
      serverProc.kill("SIGTERM");
    } catch {
      // Already dead
    }
    serverProc = null;
    serverStatus = "dead";
  }
}

function spawnModelServer(): void {
  const scriptPath = path.join(process.cwd(), "scripts", "model-server.py");
  const cwd = path.join(process.cwd(), "data");

  // findPython is async but we already validated it in ensureModelServer,
  // so use the env var or known path directly
  const pythonPath = process.env.ML_PYTHON_PATH || "python3";
  const absolutePython = path.resolve(pythonPath);

  console.log(`[ml-runner] Spawning model server: ${absolutePython} ${scriptPath}`);

  const proc = spawn(absolutePython, [scriptPath], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    env: {
      ...process.env,
      HOME: "/tmp/ml-home",
      MPLCONFIGDIR: "/tmp/matplotlib-config",
      YOLO_CONFIG_DIR: "/tmp/Ultralytics",
      DETECTOR_MODEL: ML_DEFAULTS.detectorModel,
      CLASSIFIER_MODEL: ML_DEFAULTS.classifierModel,
    },
  });

  serverProc = proc;
  serverStatus = "starting";

  // Route all stdout NDJSON through a single line handler
  const rl = createInterface({ input: proc.stdout! });

  rl.on("line", async (line) => {
    try {
      const msg: NDJSONMessage = JSON.parse(line);

      if (msg.type === "server_ready") {
        console.log(`[ml-runner] Model server ready (device=${msg.device})`);
        serverStatus = "ready";
        if (serverReadyResolve) {
          serverReadyResolve();
          serverReadyResolve = null;
          serverReadyReject = null;
        }
        return;
      }

      if (msg.type === "info") {
        console.log(`[ml-runner] ${msg.message}`);
        // Forward model-loading info as status messages if a job is active
        if (currentJob) {
          const infoMsg = msg.message || "";
          let statusMessage: string | undefined;
          if (infoMsg.toLowerCase().includes("loading detector") || infoMsg.toLowerCase().includes("load detector")) {
            statusMessage = "Cargando modelo detector...";
          } else if (infoMsg.toLowerCase().includes("loading classifier") || infoMsg.toLowerCase().includes("load classifier")) {
            statusMessage = "Cargando modelo clasificador...";
          }
          if (statusMessage) {
            await db
              .update(processingJobs)
              .set({ statusMessage })
              .where(eq(processingJobs.id, currentJob.jobId));
          }
        }
        return;
      }

      // Remaining message types require an active job
      if (!currentJob) return;
      const job = currentJob;

      if (msg.type === "progress") {
        await db
          .update(processingJobs)
          .set({ processedImages: job.processedCount })
          .where(eq(processingJobs.id, job.jobId));
      } else if (msg.type === "result" && msg.image) {
        const imageId = job.imagePathToId.get(msg.image);
        if (!imageId) return;

        const resultDetections = msg.detections || [];

        if (resultDetections.length > 0) {
          for (const det of resultDetections) {
            const [detection] = await db
              .insert(detections)
              .values({
                imageId,
                jobId: job.jobId,
                bboxX: det.bbox.x,
                bboxY: det.bbox.y,
                bboxWidth: det.bbox.width,
                bboxHeight: det.bbox.height,
                detectionConfidence: det.detection_confidence,
                detectionClass: det.detection_class,
                modelVersion: job.config.detectorModel,
              })
              .returning();

            if (det.classification) {
              await db.insert(identifications).values({
                detectionId: detection.id,
                species: det.classification.species,
                confidence: det.classification.confidence,
                modelVersion: job.config.classifierModel,
                verificationStatus: "unverified",
              });
            }

            job.totalDetections++;
          }
        }

        await db
          .update(images)
          .set({ status: "processed" })
          .where(eq(images.id, imageId));

        job.processedCount++;

        await db
          .update(processingJobs)
          .set({
            processedImages: job.processedCount,
            statusMessage: `Analizando imágenes... (${job.processedCount} de ${job.config.imagePaths.length})`,
          })
          .where(eq(processingJobs.id, job.jobId));
      } else if (msg.type === "error" && msg.image) {
        const imageId = job.imagePathToId.get(msg.image);
        if (imageId) {
          await db
            .update(images)
            .set({
              status: "failed",
              errorMessage: msg.message || "ML prediction failed",
            })
            .where(eq(images.id, imageId));
          job.failedCount++;
          await db
            .update(processingJobs)
            .set({ failedImages: job.failedCount })
            .where(eq(processingJobs.id, job.jobId));
        }
      } else if (msg.type === "error" && !msg.image) {
        console.error(`[ml-runner] ${msg.message}`);
      } else if (msg.type === "complete") {
        const result: MLRunResult = {
          success: !msg.cancelled,
          totalProcessed: job.processedCount,
          totalDetections: job.totalDetections,
        };
        if (msg.cancelled) {
          result.error = "Cancelled";
        }
        const resolve = job.resolve;
        currentJob = null;
        serverStatus = "ready";
        resetIdleTimer();
        resolve(result);
      }
    } catch {
      // Skip malformed JSON lines
    }
  });

  // Capture stderr for diagnostics
  let stderr = "";
  proc.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
    // Log stderr lines as they come
    const lines = stderr.split("\n");
    // Keep the last (possibly incomplete) line in the buffer
    stderr = lines.pop() || "";
    for (const l of lines) {
      if (l.trim()) console.error(`[model-server stderr] ${l}`);
    }
  });

  proc.on("close", (code) => {
    console.log(`[ml-runner] Model server exited with code ${code}`);
    serverProc = null;
    serverStatus = "dead";

    // Reject pending ready promise
    if (serverReadyReject) {
      serverReadyReject(new Error(`Model server exited during startup (code ${code})`));
      serverReadyResolve = null;
      serverReadyReject = null;
    }

    // Resolve current job with failure
    if (currentJob) {
      const job = currentJob;
      currentJob = null;
      job.resolve({
        success: false,
        totalProcessed: job.processedCount,
        totalDetections: job.totalDetections,
        error: `Model server crashed (exit code ${code})`,
      });
    }

    clearIdleTimer();
  });

  proc.on("error", (err) => {
    console.error(`[ml-runner] Model server spawn error: ${err.message}`);
    serverProc = null;
    serverStatus = "dead";

    if (serverReadyReject) {
      serverReadyReject(err);
      serverReadyResolve = null;
      serverReadyReject = null;
    }

    if (currentJob) {
      const job = currentJob;
      currentJob = null;
      job.resolve({
        success: false,
        totalProcessed: job.processedCount,
        totalDetections: job.totalDetections,
        error: err.message,
      });
    }
  });
}

async function ensureModelServer(): Promise<void> {
  // Already ready — just clear idle timer
  if (serverStatus === "ready" && serverProc) {
    clearIdleTimer();
    return;
  }

  // Already starting — wait for it
  if (serverStatus === "starting" && serverProc) {
    return new Promise<void>((resolve, reject) => {
      // Chain onto existing promise
      const prevResolve = serverReadyResolve;
      const prevReject = serverReadyReject;
      serverReadyResolve = () => {
        prevResolve?.();
        resolve();
      };
      serverReadyReject = (err) => {
        prevReject?.(err);
        reject(err);
      };
    });
  }

  // Busy — can't start another job
  if (serverStatus === "busy") {
    throw new Error("Model server is busy with another job");
  }

  // Dead — validate Python and spawn
  const python = await findPython();
  if (!python) {
    throw new Error("Python 3 no encontrado");
  }

  return new Promise<void>((resolve, reject) => {
    serverReadyResolve = resolve;
    serverReadyReject = reject;
    spawnModelServer();
  });
}

// ---------------------------------------------------------------------------
// Job Cancellation
// ---------------------------------------------------------------------------

export function cancelModelServerJob(): void {
  if (serverStatus !== "busy" || !serverProc?.stdin?.writable) {
    return;
  }

  console.log("[ml-runner] Sending cancel to model server");
  try {
    serverProc.stdin.write(JSON.stringify({ cancel: true }) + "\n");
  } catch {
    // stdin may be closed
  }

  // Fallback: if job doesn't complete within 5s, kill server
  setTimeout(() => {
    if (currentJob) {
      console.log("[ml-runner] Cancel timeout — killing model server");
      shutdownModelServer();
    }
  }, 5000);
}

// ---------------------------------------------------------------------------
// Run ML Predictions (main entry point)
// ---------------------------------------------------------------------------

export async function runMLPredictions(
  jobId: number,
  config: MLConfig
): Promise<MLRunResult> {
  // Build path → image ID lookup BEFORE starting
  const jobImages = await db
    .select()
    .from(images)
    .where(eq(images.jobId, jobId));

  const imagePathToId = new Map<string, number>();
  for (const img of jobImages) {
    if (img.path) {
      imagePathToId.set(img.path, img.id);
    }
  }

  // Ensure model server is running (starts if dead, waits if starting)
  try {
    await ensureModelServer();
  } catch (err) {
    return {
      success: false,
      totalProcessed: 0,
      totalDetections: 0,
      error: err instanceof Error ? err.message : "Failed to start model server",
    };
  }

  if (!serverProc?.stdin?.writable) {
    return {
      success: false,
      totalProcessed: 0,
      totalDetections: 0,
      error: "Model server stdin not writable",
    };
  }

  // Store PID for external process management
  if (serverProc.pid) {
    await db.update(processingJobs)
      .set({ pid: serverProc.pid })
      .where(eq(processingJobs.id, jobId));
  }

  // Set up job context and send config to server
  return new Promise<MLRunResult>((resolve) => {
    currentJob = {
      jobId,
      imagePathToId,
      config,
      processedCount: 0,
      failedCount: 0,
      totalDetections: 0,
      resolve,
    };

    serverStatus = "busy";
    clearIdleTimer();

    const jobConfig = JSON.stringify({
      image_paths: config.imagePaths,
      confidence_threshold: config.confidenceThreshold,
      batch_size: config.batchSize,
    });

    serverProc!.stdin!.write(jobConfig + "\n");
  });
}

// ---------------------------------------------------------------------------
// Graceful Shutdown
// ---------------------------------------------------------------------------

process.on("SIGTERM", () => shutdownModelServer());
process.on("SIGINT", () => shutdownModelServer());
