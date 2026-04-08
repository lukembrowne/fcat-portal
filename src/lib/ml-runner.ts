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
import fs from "fs";
import os from "os";
import { createInterface } from "readline";
import { db } from "@/db";
import {
  processingJobs,
  images,
  detections,
  identifications,
  cameraTrapModels,
} from "@/db/schema";
import { eq } from "drizzle-orm";
import { ML_DEFAULTS } from "@/lib/ml-defaults";
import { buildClassifierEnv, type ActiveModelForEnv } from "@/lib/ml-runner-env";

const execFileAsync = promisify(execFile);

// Compute the ML thread cap once at module load. Used for OMP_NUM_THREADS,
// MKL_NUM_THREADS, OPENBLAS_NUM_THREADS, NUMEXPR_NUM_THREADS in spawnModelServer().
// availableParallelism() respects cgroup CPU limits inside containers.
const ML_THREAD_CAP = String(Math.max(1, os.availableParallelism() - 1));
console.log(
  `[ml-runner] Thread cap: ${ML_THREAD_CAP} (availableParallelism=${os.availableParallelism()})`
);

export interface MLConfig {
  imagePaths: string[];
  detectorModel: string;
  classifierModel: string;
  device: string;
  confidenceThreshold: number;
  batchSize: number;
  numWorkers: number;
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
  startedAt: number;
  /** id of the camera_trap_models row that produced predictions for this
   * job, or null when running with the legacy AI4G default. Used to stamp
   * provenance on every identification insert. */
  activeClassifierModelId: number | null;
}

// ---------------------------------------------------------------------------
// Singleton Model Server State
// ---------------------------------------------------------------------------

let serverProc: ChildProcess | null = null;
let serverStatus: "starting" | "ready" | "busy" | "dead" = "dead";
let serverReadyResolve: (() => void) | null = null;
let serverReadyReject: ((err: Error) => void) | null = null;
let serverReadyPromise: Promise<void> | null = null;
let currentJob: JobContext | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
/** Last info message received from the Python model server. Used to pinpoint
 * where it died when stderr is empty (e.g. "Loading classifier: ..."). */
let lastModelServerInfo: string | null = null;
/** Last fatal error message emitted by Python via NDJSON (type: "error" without
 * an image). Captured here so it survives until the close handler runs. */
let lastModelServerError: string | null = null;
/** Active custom classifier model loaded into the current model server, or
 * null if running with AI4G defaults. Resolved by ensureModelServer() before
 * spawn and read by spawnModelServer() to assemble env vars. The line handler
 * uses the id to stamp provenance on every identification insert. */
let activeClassifierModel: ActiveModelForEnv | null = null;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const PID_FILE = path.join(process.cwd(), "data", "model-server.pid");

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

function killStaleModelServer(): void {
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
    if (pid && !isNaN(pid)) {
      try {
        process.kill(pid, "SIGTERM");
        console.log(`[ml-runner] Killed stale model server (PID ${pid})`);
      } catch {
        // Process already dead — fine
      }
    }
  } catch {
    // No PID file — nothing to clean up
  }
}

function writePidFile(pid: number): void {
  try {
    fs.writeFileSync(PID_FILE, String(pid), "utf-8");
  } catch (err) {
    console.error(`[ml-runner] Failed to write PID file: ${err}`);
  }
}

function removePidFile(): void {
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    // Already gone
  }
}

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
  removePidFile();
}

/**
 * Build a rich crash error message from process exit info, captured stderr,
 * and the last NDJSON messages received from the Python model server.
 *
 * Pure function — exported for unit testing. The spawn handler closes over
 * its `stderrLog` accumulator and passes it in here.
 *
 * Resolution priority (most specific → least):
 *   1. An NDJSON `error` message Python explicitly emitted
 *   2. The tail of stderr if any was captured
 *   3. A heuristic hint based on signal/exit code (OOM, segfault, etc.)
 */
export function buildCrashError(
  code: number | null,
  signal: NodeJS.Signals | null,
  phase: "startup" | "running",
  stderrLog: string,
  lastInfo: string | null,
  lastError: string | null,
): string {
  const phaseLabel =
    phase === "startup" ? "Model server died during startup" : "Model server crashed";
  const exitInfo = signal ? `signal ${signal}` : `exit code ${code}`;
  const lastActivity = lastInfo ? ` Last activity: ${lastInfo}.` : "";

  // Best signal: an explicit error message Python emitted via NDJSON.
  if (lastError) {
    return `${phaseLabel} (${exitInfo}).${lastActivity}\n${lastError}`;
  }

  if (stderrLog.trim()) {
    const tail = stderrLog
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .slice(-10)
      .join("\n");
    return `${phaseLabel} (${exitInfo}).${lastActivity}\n${tail}`;
  }

  // Empty stderr → Python never wrote anything before dying.
  // Strong indicators: SIGKILL (almost always OOM kill), code 137 (OOM in
  // container), code 139 (SIGSEGV native crash). Code 1 with no stderr is
  // most often OOM as well.
  let hint: string;
  if (signal === "SIGKILL" || code === 137) {
    hint =
      "El proceso fue terminado por el sistema operativo (SIGKILL). " +
      "Causa más probable: memoria insuficiente (OOM kill). " +
      "Revisa el límite de memoria del contenedor y `docker stats` durante la carga del modelo.";
  } else if (code === 139) {
    hint =
      "Crash nativo (SIGSEGV). Causa probable: incompatibilidad de torch/torchvision " +
      "o un binario nativo del modelo.";
  } else {
    hint =
      "El proceso terminó sin escribir nada a stderr — Python no alcanzó su manejador de errores. " +
      "Causa más probable: OOM kill o crash nativo durante la carga del modelo. " +
      "Verifica memoria del contenedor con `docker stats` y prueba ejecutar el model server " +
      "manualmente para ver si genera un traceback.";
  }
  return `${phaseLabel} (${exitInfo}).${lastActivity}\n${hint}`;
}

function spawnModelServer(): void {
  // Reset crash diagnostics for the new process
  lastModelServerInfo = null;
  lastModelServerError = null;
  const scriptPath = path.join(process.cwd(), "scripts", "model-server.py");
  const cwd = path.join(process.cwd(), "data");

  // findPython is async but we already validated it in ensureModelServer,
  // so use the env var or known path directly
  const pythonPath = process.env.ML_PYTHON_PATH || "python3";
  const absolutePython = path.resolve(pythonPath);

  console.log(`[ml-runner] Spawning model server: ${absolutePython} ${scriptPath}`);

  // Kill any orphaned model server from a previous Node.js process
  killStaleModelServer();

  const proc = spawn(absolutePython, [scriptPath], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    env: {
      ...process.env,
      HOME: "/tmp/ml-home",
      MPLCONFIGDIR: "/tmp/matplotlib-config",
      YOLO_CONFIG_DIR: "/tmp/Ultralytics",
      // Persist torch model weights across container restarts. docker-entrypoint.sh
      // sets this for the Docker case; this fallback handles native dev (npm run dev).
      // Without persistence, ~388 MB of detector + classifier weights re-download on
      // every restart, adding ~3 min to model server startup.
      TORCH_HOME:
        process.env.TORCH_HOME ?? path.join(process.cwd(), "data", "ml-cache", "torch"),
      DETECTOR_MODEL: ML_DEFAULTS.detectorModel,
      // Classifier env (CLASSIFIER_MODEL + CUSTOM_CLASSIFIER_*) is assembled
      // from the active camera_trap_models row by buildClassifierEnv. When no
      // active model exists, falls back to the AI4G default.
      ...buildClassifierEnv(activeClassifierModel),
      // Cap native thread pools to (available cores - 1) so the rest of the box
      // (Next.js, DB, oauth2-proxy, neighbors on shared hosts) keeps responsiveness
      // during a long ML job. availableParallelism() respects cgroup CPU limits in
      // containers (Node 18.14+), so this gives the right answer in all environments:
      //   - prod 4-vCPU droplet → 3 threads
      //   - dev Mac Docker VM with 8 cores → 7 threads
      // Microbenchmark on Apple Silicon showed ~1.44× speedup going from 3→8 threads,
      // so this is a real win on dev. See plan doc for details.
      OMP_NUM_THREADS: ML_THREAD_CAP,
      MKL_NUM_THREADS: ML_THREAD_CAP,
      OPENBLAS_NUM_THREADS: ML_THREAD_CAP,
      NUMEXPR_NUM_THREADS: ML_THREAD_CAP,
    },
  });

  serverProc = proc;
  serverStatus = "starting";

  if (proc.pid) {
    writePidFile(proc.pid);
  }

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
        lastModelServerInfo = msg.message ?? null;
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

      // Fatal/global errors (no image attached) must be handled BEFORE the
      // currentJob guard so they're not silently dropped during startup
      // (e.g. "Fatal: failed to load models: ...").
      if (msg.type === "error" && !msg.image) {
        console.error(`[ml-runner] ${msg.message}`);
        lastModelServerError = msg.message ?? null;
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
                classifierModelId: job.activeClassifierModelId,
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
      } else if (msg.type === "complete") {
        const elapsedSec = ((Date.now() - job.startedAt) / 1000).toFixed(1);
        const mem = process.memoryUsage();
        const rssMB = (mem.rss / 1024 / 1024).toFixed(0);
        const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(0);
        console.log(
          `[ml-runner] Job ${job.jobId} complete: ${job.processedCount} processed, ` +
          `${job.failedCount} failed, ${job.totalDetections} detections in ${elapsedSec}s ` +
          `(RSS: ${rssMB}MB, heap: ${heapMB}MB)` +
          (msg.cancelled ? " [CANCELLED]" : "")
        );

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

  // Capture stderr for diagnostics. Two buffers:
  //  - `stderrBuffer`: partial-line accumulator for line-by-line console logging
  //  - `stderrLog`: full transcript (capped) for inclusion in crash error messages
  let stderrBuffer = "";
  let stderrLog = "";
  const STDERR_LOG_MAX = 8 * 1024; // keep last ~8KB
  proc.stderr!.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    // Append to full transcript (bounded — keep tail)
    stderrLog += text;
    if (stderrLog.length > STDERR_LOG_MAX) {
      stderrLog = stderrLog.slice(-STDERR_LOG_MAX);
    }
    // Stream complete lines to console
    stderrBuffer += text;
    const lines = stderrBuffer.split("\n");
    stderrBuffer = lines.pop() || "";
    for (const l of lines) {
      if (l.trim()) console.error(`[model-server stderr] ${l}`);
    }
  });

  function finalizeCrash(code: number | null, signal: NodeJS.Signals | null): void {
    const phase: "startup" | "running" = serverReadyReject ? "startup" : "running";
    const crashError = buildCrashError(
      code,
      signal,
      phase,
      stderrLog,
      lastModelServerInfo,
      lastModelServerError,
    );

    // Reject pending ready promise
    if (serverReadyReject) {
      serverReadyReject(new Error(crashError));
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
        error: crashError,
      });
    }

    clearIdleTimer();
  }

  proc.on("close", (code, signal) => {
    // Flush any partial stderr line that never got a trailing newline
    if (stderrBuffer.trim()) {
      console.error(`[model-server stderr] ${stderrBuffer}`);
      stderrLog += stderrBuffer;
      stderrBuffer = "";
    }
    console.log(
      `[ml-runner] Model server exited (code=${code}, signal=${signal ?? "none"})`
    );
    serverProc = null;
    serverStatus = "dead";
    removePidFile();

    // Defer the rest by one tick so any pending readline `line` events
    // (which may carry Python's final NDJSON error) can fire first.
    // The line handler is async — it captures `lastModelServerError`
    // synchronously before any await, so a single setImmediate is enough.
    setImmediate(() => finalizeCrash(code, signal));
  });

  proc.on("error", (err) => {
    console.error(`[ml-runner] Model server spawn error: ${err.message}`);
    serverProc = null;
    serverStatus = "dead";

    // Surface spawn errors with the same rich format we use for crashes,
    // so the UI shows a useful message instead of a bare "ENOENT".
    const phase: "startup" | "running" = serverReadyReject ? "startup" : "running";
    const crashError = buildCrashError(
      null,
      null,
      phase,
      "",
      lastModelServerInfo,
      `Spawn error: ${err.message}`,
    );

    if (serverReadyReject) {
      serverReadyReject(new Error(crashError));
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
        error: crashError,
      });
    }
  });
}

/**
 * Look up the currently-active custom classifier model row, or null if none.
 * Tolerates DB errors at startup (e.g. fresh DB without the table yet) by
 * logging and returning null — the pipeline falls back to AI4G defaults.
 */
async function resolveActiveClassifierModel(): Promise<ActiveModelForEnv | null> {
  try {
    const rows = await db
      .select({
        id: cameraTrapModels.id,
        modelDir: cameraTrapModels.modelDir,
        classMappingJson: cameraTrapModels.classMappingJson,
        metricsJson: cameraTrapModels.metricsJson,
      })
      .from(cameraTrapModels)
      .where(eq(cameraTrapModels.active, true))
      .limit(1);
    return rows[0] ?? null;
  } catch (err) {
    console.warn(
      `[ml-runner] Failed to resolve active classifier model, falling back to default: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

async function ensureModelServer(): Promise<void> {
  // Already ready — just clear idle timer
  if (serverStatus === "ready" && serverProc) {
    clearIdleTimer();
    return;
  }

  // Busy — can't start another job
  if (serverStatus === "busy") {
    throw new Error("Model server is busy with another job");
  }

  // Already starting (or another caller is spawning) — share the same promise
  if (serverReadyPromise) {
    return serverReadyPromise;
  }

  // Dead — validate Python and spawn
  const python = await findPython();
  if (!python) {
    throw new Error("Python 3 no encontrado");
  }

  // Resolve the active custom classifier (if any) BEFORE spawn so the env
  // vars are correct on the very first job after a model swap.
  activeClassifierModel = await resolveActiveClassifierModel();

  // Re-check after async gap (another caller may have started while we awaited findPython)
  if (serverReadyPromise) {
    return serverReadyPromise;
  }
  if (serverStatus === "ready" && serverProc) {
    clearIdleTimer();
    return;
  }

  serverReadyPromise = new Promise<void>((resolve, reject) => {
    serverReadyResolve = resolve;
    serverReadyReject = reject;
    spawnModelServer();
  });

  // Clean up the shared promise when it settles
  serverReadyPromise.then(
    () => { serverReadyPromise = null; },
    () => { serverReadyPromise = null; },
  );

  return serverReadyPromise;
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

  // Fallback: if job doesn't complete within 30s, kill server
  // (batch processing takes longer per cancel check than sequential)
  setTimeout(() => {
    if (currentJob) {
      console.log("[ml-runner] Cancel timeout — killing model server");
      shutdownModelServer();
    }
  }, 30_000);
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
      startedAt: Date.now(),
      activeClassifierModelId: activeClassifierModel?.id ?? null,
    };

    serverStatus = "busy";
    clearIdleTimer();

    const jobConfig = JSON.stringify({
      image_paths: config.imagePaths,
      confidence_threshold: config.confidenceThreshold,
      batch_size: config.batchSize,
      num_workers: config.numWorkers,
    });

    serverProc!.stdin!.write(jobConfig + "\n");
  });
}

// ---------------------------------------------------------------------------
// Graceful Shutdown
// ---------------------------------------------------------------------------

process.on("SIGTERM", () => shutdownModelServer());
process.on("SIGINT", () => shutdownModelServer());
