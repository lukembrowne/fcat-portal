/**
 * ML Runner — Node.js ↔ Python subprocess bridge
 *
 * IMPORTANT: The ML Python venv lives on the HOST, not in Docker.
 * Set ML_PYTHON_PATH env var to the venv's python3 binary.
 * If the host is rebuilt, the ML pipeline silently breaks.
 *
 * Server-only module — never import in Client Components.
 */

import "server-only";

import { spawn, execFile } from "child_process";
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
  type: "progress" | "result" | "error" | "complete" | "info";
  image?: string;
  index?: number;
  total?: number;
  detections?: DetectionResult[];
  message?: string;
  total_processed?: number;
  total_detections?: number;
}

/**
 * Find the Python executable.
 * Checks ML_PYTHON_PATH env var first, then falls back to system python.
 * No mock fallback — ML either works or fails with a clear error.
 */
async function findPython(): Promise<string | null> {
  const envPython = process.env.ML_PYTHON_PATH;
  const candidates = envPython
    ? [envPython, "python3", "python"]
    : ["python3", "python"];

  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ["--version"]);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

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
    return {
      available: true,
      python,
      message: `pytorch-wildlife ${version} disponible (usando ${python})`,
    };
  } catch {
    return {
      available: false,
      python,
      message: `pytorch-wildlife no encontrado vía ${python}. Configure ML_PYTHON_PATH o ejecute: pip install -r scripts/requirements-inference.txt`,
    };
  }
}

/**
 * Run ML predictions via Python subprocess.
 *
 * FIX: Awaits image path-to-ID lookup BEFORE spawning subprocess
 * to avoid race condition where results arrive before the lookup map is ready.
 */
export async function runMLPredictions(
  jobId: number,
  config: MLConfig
): Promise<MLRunResult> {
  const python = await findPython();
  if (!python) {
    return {
      success: false,
      totalProcessed: 0,
      totalDetections: 0,
      error: "Python 3 no encontrado",
    };
  }

  // FIX: Build path → image ID lookup BEFORE spawning subprocess
  const jobImages = await db
    .select()
    .from(images)
    .where(eq(images.jobId, jobId));

  const imagePathToId = new Map<string, number>();
  for (const img of jobImages) {
    imagePathToId.set(img.path, img.id);
  }

  const scriptPath = path.join(process.cwd(), "scripts", "predict.py");

  const stdinPayload = JSON.stringify({
    image_paths: config.imagePaths,
    detector_model: config.detectorModel,
    classifier_model: config.classifierModel,
    device: config.device,
    confidence_threshold: config.confidenceThreshold,
    batch_size: config.batchSize,
  });

  return new Promise((resolve) => {
    const proc = spawn(python, [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Store PID for cancellation
    if (proc.pid) {
      db.update(processingJobs)
        .set({ pid: proc.pid })
        .where(eq(processingJobs.id, jobId))
        .then(() => {});
    }

    // Send config via stdin
    proc.stdin.write(stdinPayload);
    proc.stdin.end();

    let processedCount = 0;
    let failedCount = 0;
    let totalDetections = 0;

    const rl = createInterface({ input: proc.stdout });

    rl.on("line", async (line) => {
      try {
        const msg: NDJSONMessage = JSON.parse(line);

        if (msg.type === "progress") {
          await db
            .update(processingJobs)
            .set({ processedImages: processedCount })
            .where(eq(processingJobs.id, jobId));
        } else if (msg.type === "result" && msg.image) {
          const imageId = imagePathToId.get(msg.image);
          if (!imageId) return;

          const resultDetections = msg.detections || [];

          if (resultDetections.length > 0) {
            for (const det of resultDetections) {
              const [detection] = await db
                .insert(detections)
                .values({
                  imageId,
                  jobId,
                  bboxX: det.bbox.x,
                  bboxY: det.bbox.y,
                  bboxWidth: det.bbox.width,
                  bboxHeight: det.bbox.height,
                  detectionConfidence: det.detection_confidence,
                  detectionClass: det.detection_class,
                  modelVersion: config.detectorModel,
                })
                .returning();

              if (det.classification) {
                await db.insert(identifications).values({
                  detectionId: detection.id,
                  species: det.classification.species,
                  confidence: det.classification.confidence,
                  modelVersion: config.classifierModel,
                  verificationStatus: "unverified",
                });
              }

              totalDetections++;
            }
          }

          await db
            .update(images)
            .set({ status: "processed" })
            .where(eq(images.id, imageId));

          processedCount++;

          await db
            .update(processingJobs)
            .set({ processedImages: processedCount })
            .where(eq(processingJobs.id, jobId));
        } else if (msg.type === "error" && msg.image) {
          const imageId = imagePathToId.get(msg.image);
          if (imageId) {
            await db
              .update(images)
              .set({
                status: "failed",
                errorMessage: msg.message || "ML prediction failed",
              })
              .where(eq(images.id, imageId));
            failedCount++;
            await db
              .update(processingJobs)
              .set({ failedImages: failedCount })
              .where(eq(processingJobs.id, jobId));
          }
        } else if (msg.type === "info") {
          console.log(`[ml-runner] ${msg.message}`);
        }
      } catch {
        // Skip malformed JSON lines
      }
    });

    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    proc.on("close", async (code) => {
      if (code === 0) {
        resolve({
          success: true,
          totalProcessed: processedCount,
          totalDetections,
        });
      } else {
        resolve({
          success: false,
          totalProcessed: processedCount,
          totalDetections,
          error: stderr.trim() || `Python process exited with code ${code}`,
        });
      }
    });

    proc.on("error", (err) => {
      resolve({
        success: false,
        totalProcessed: processedCount,
        totalDetections,
        error: err.message,
      });
    });
  });
}
