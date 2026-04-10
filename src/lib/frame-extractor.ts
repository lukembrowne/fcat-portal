/**
 * Frame Extractor — Extracts frames from camera trap videos using ffmpeg.
 *
 * Calls ffprobe to get video duration, then ffmpeg to extract frames at a
 * configurable FPS rate. Returns paths to extracted JPEG frames.
 *
 * Server-only module — never import in Client Components.
 */

import "server-only";

import { execFile } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { log } from "@/lib/log";

const MAX_FRAMES_DEFAULT = 300;

export interface FrameExtractionResult {
  frames: { path: string; index: number }[];
  duration: number;
  error?: string;
}

/**
 * Get video duration in seconds using ffprobe.
 * Returns null if the video is corrupt or ffprobe fails.
 */
async function getVideoDuration(videoPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      "ffprobe",
      [
        "-v", "quiet",
        "-print_format", "json",
        "-show_format",
        videoPath,
      ],
      { timeout: 30_000 },
      (err, stdout) => {
        if (err) {
          log.error({ videoPath, err: err.message }, "[frame-extractor] ffprobe failed");
          resolve(null);
          return;
        }
        try {
          const data = JSON.parse(stdout);
          const duration = parseFloat(data.format?.duration);
          resolve(isNaN(duration) ? null : duration);
        } catch {
          resolve(null);
        }
      }
    );
  });
}

/**
 * Extract frames from a video file at a given FPS rate.
 *
 * @param videoPath - Absolute path to the video file
 * @param outputDir - Directory to write extracted frames
 * @param videoBaseName - Base name for frame files (without extension)
 * @param fps - Frames per second to extract (e.g., 1.0 = 1 frame/sec, 0.5 = 1 frame every 2 sec)
 * @param maxFrames - Maximum number of frames to extract (default 300)
 * @returns Extraction result with frame paths and duration
 */
export async function extractFrames(
  videoPath: string,
  outputDir: string,
  videoBaseName: string,
  fps: number = 1.0,
  maxFrames: number = MAX_FRAMES_DEFAULT
): Promise<FrameExtractionResult> {
  // 1. Get video duration
  const duration = await getVideoDuration(videoPath);
  if (duration === null) {
    return {
      frames: [],
      duration: 0,
      error: "No se pudo leer el video (archivo corrupto o formato no soportado)",
    };
  }

  // 2. Calculate expected frame count and apply cap
  const expectedFrames = Math.ceil(duration * fps);
  const framesToExtract = Math.min(expectedFrames, maxFrames);

  if (framesToExtract === 0) {
    return { frames: [], duration, error: "Video demasiado corto para extraer cuadros" };
  }

  // If we need to cap, adjust the effective duration
  const effectiveDuration = framesToExtract < expectedFrames
    ? framesToExtract / fps
    : duration;

  // Ensure output directory exists
  await fs.mkdir(outputDir, { recursive: true });

  // 3. Extract frames with ffmpeg
  const framePattern = path.join(outputDir, `${videoBaseName}_f%04d.jpg`);

  const ffmpegArgs = [
    "-i", videoPath,
    "-vf", `fps=${fps}`,
    "-q:v", "2", // High quality JPEG
    "-frames:v", String(framesToExtract),
    framePattern,
    "-y", // Overwrite existing files
  ];

  // Only limit duration if we're capping
  if (framesToExtract < expectedFrames) {
    ffmpegArgs.splice(2, 0, "-t", String(effectiveDuration));
  }

  let ffmpegPid: number | undefined;

  const ffmpegError = await new Promise<string | null>((resolve) => {
    const proc = execFile(
      "ffmpeg",
      ffmpegArgs,
      { timeout: 300_000 }, // 5 minute timeout
      (err, _stdout, stderr) => {
        if (err) {
          log.error(
            { videoPath, err: err.message, stderr },
            "[frame-extractor] ffmpeg failed"
          );
          resolve(err.message);
          return;
        }
        resolve(null);
      }
    );

    // Track PID for cancellation
    if (proc.pid) {
      ffmpegPid = proc.pid;
      activeExtractionPids.add(proc.pid);
    }
  });

  if (ffmpegPid) {
    activeExtractionPids.delete(ffmpegPid);
  }

  // 4. Collect extracted frame paths
  const frames: { path: string; index: number }[] = [];

  try {
    const files = await fs.readdir(outputDir);
    const frameFiles = files
      .filter((f) => f.startsWith(`${videoBaseName}_f`) && f.endsWith(".jpg"))
      .sort();

    for (let i = 0; i < frameFiles.length; i++) {
      frames.push({
        path: path.join(outputDir, frameFiles[i]),
        index: i,
      });
    }
  } catch {
    // Output directory may not have been created if ffmpeg failed early
  }

  if (frames.length === 0 && ffmpegError) {
    return {
      frames: [],
      duration,
      error: `Error al extraer cuadros: ${ffmpegError}`,
    };
  }

  if (ffmpegError && frames.length > 0) {
    log.warn(
      { videoPath, frameCount: frames.length },
      "[frame-extractor] Partial extraction: frames extracted before error"
    );
  }

  if (framesToExtract < expectedFrames) {
    log.warn(
      { videoPath, maxFrames, durationSec: +duration.toFixed(1), expectedFrames, fps },
      "[frame-extractor] Capped frames for long video"
    );
  }

  return {
    frames,
    duration,
    error: ffmpegError ? `Extracción parcial: ${ffmpegError}` : undefined,
  };
}

// --- Cancellation support ---

const activeExtractionPids = new Set<number>();

/**
 * Kill all currently running ffmpeg processes.
 */
export function cancelFrameExtraction(): void {
  for (const pid of activeExtractionPids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Process may have already exited
    }
  }
  activeExtractionPids.clear();
}
