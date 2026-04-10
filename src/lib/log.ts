import "server-only";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import pino, { type Logger, type DestinationStream } from "pino";
import pretty from "pino-pretty";

/**
 * Singleton pino logger for server-side code.
 *
 * Output strategy (driven by two env vars: NODE_ENV and LOG_TEE):
 *
 *   1. Dev mode (NODE_ENV=development, LOG_TEE not set)
 *      - stdout: pretty-printed colorized lines (nice `docker compose logs`)
 *      - file:   raw JSON lines written to LOG_FILE (default data/logs/portal.log)
 *                so the /admin/logs viewer parses levels + context correctly
 *
 *   2. Docker production under log-tee (LOG_TEE=1)
 *      - stdout: raw JSON (log-tee captures it and writes to the rotating file)
 *      - file:   skipped here — log-tee owns it to avoid double-writes
 *
 *   3. Anything else (prod without log-tee, tests, scripts)
 *      - stdout: raw JSON
 *      - file:   only if LOG_FILE is explicitly set
 *
 * Convention (pino style — context object first, message second):
 *   log.info({ jobId, count }, "started ML processing")
 *   log.error({ err, jobId }, "ML batch failed")
 *   log.warn({ userEmail }, "permission denied")
 */

const isDev = process.env.NODE_ENV !== "production";
const isUnderTee = process.env.LOG_TEE === "1";

// Default to data/logs/portal.log in dev so the viewer works out of the box.
// In prod, only honor an explicit LOG_FILE (and log-tee will set LOG_TEE=1
// before spawning, which makes us skip the direct-file path anyway).
const explicitLogFile = process.env.LOG_FILE;
const defaultDevLogFile = isDev ? resolve(process.cwd(), "data", "logs", "portal.log") : undefined;
const logFilePath = explicitLogFile
  ? isAbsolute(explicitLogFile) ? explicitLogFile : resolve(process.cwd(), explicitLogFile)
  : defaultDevLogFile;

const shouldWriteFileDirectly = !!logFilePath && !isUnderTee;
// Pretty stdout only when we're NOT under log-tee. log-tee needs raw JSON on
// stdout because it writes stdout to the rotating log file that the viewer reads.
const shouldPrettyStdout = isDev && !isUnderTee;

function buildStdoutStream(): DestinationStream {
  if (!shouldPrettyStdout) return process.stdout;
  // pino-pretty used as a library returns a Transform stream that accepts
  // raw pino JSON and writes pretty colorized text to the given destination.
  return pretty({
    colorize: true,
    translateTime: "HH:MM:ss.l",
    ignore: "pid,hostname,app",
    singleLine: false,
    destination: 1, // fd 1 = stdout
  });
}

let destination: DestinationStream;
if (shouldWriteFileDirectly && logFilePath) {
  try {
    mkdirSync(dirname(logFilePath), { recursive: true });
  } catch {
    // best effort — pino.destination will surface the real error if it fails
  }
  destination = pino.multistream([
    { stream: buildStdoutStream() },
    {
      stream: pino.destination({
        dest: logFilePath,
        append: true,
        sync: false,
        mkdir: true,
      }),
    },
  ]);
} else if (shouldPrettyStdout) {
  destination = buildStdoutStream();
} else {
  destination = process.stdout;
}

export const log: Logger = pino(
  {
    level: process.env.LOG_LEVEL ?? (isDev ? "debug" : "info"),
    base: { app: "fcat-portal" },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  destination,
);

// Announce startup — guarded so Turbopack HMR doesn't spam the log file.
const startupKey = "__fcat_logger_init";
if (!(globalThis as Record<string, unknown>)[startupKey]) {
  (globalThis as Record<string, unknown>)[startupKey] = true;
  log.info(
    {
      pid: process.pid,
      logFile: shouldWriteFileDirectly ? logFilePath : null,
      underTee: isUnderTee,
    },
    "logger initialized",
  );
}

/**
 * Create a child logger with persistent context fields.
 * Use at the top of a request/job handler so every line is tagged.
 *
 * @example
 *   const jobLog = logFor({ jobId, userEmail });
 *   jobLog.info({ count }, "started ML processing");
 *   jobLog.error({ err }, "ML batch failed");
 */
export function logFor(ctx: Record<string, unknown>): Logger {
  return log.child(ctx);
}
