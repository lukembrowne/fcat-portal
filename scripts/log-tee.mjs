#!/usr/bin/env node
/**
 * log-tee — supervisor process that runs the Next.js server and mirrors
 * its stdout/stderr into a rotating file on the persisted data volume.
 *
 * Used as the container entrypoint replacement for `node server.js`.
 * Captures everything reaching stdout (Node, Python ML subprocess, console.*,
 * pino JSON, etc.) so the in-app /admin/logs viewer can stream it without SSH.
 *
 * Why a Node supervisor (instead of `node server.js | tee ...` in shell):
 *   - PID 1 in the container is this script, so SIGTERM from Docker
 *     reaches us cleanly and we can forward it to the child for graceful
 *     shutdown (WAL checkpoint, etc.) — shell pipelines drop signals.
 *   - Rotation logic stays in JS, no logrotate dependency.
 *
 * Env:
 *   LOG_FILE        — output path (default /app/data/logs/portal.log)
 *   LOG_MAX_BYTES   — rotate when current file exceeds this (default 50MB)
 *   SERVER_ENTRY    — entry script to spawn (default server.js)
 */

import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";

const LOG_FILE = process.env.LOG_FILE ?? "/app/data/logs/portal.log";
const LOG_MAX_BYTES = Number(process.env.LOG_MAX_BYTES ?? 50 * 1024 * 1024);
const SERVER_ENTRY = process.env.SERVER_ENTRY ?? "server.js";
const ROTATED_FILE = `${LOG_FILE}.1`;

mkdirSync(dirname(LOG_FILE), { recursive: true });

let out = createWriteStream(LOG_FILE, { flags: "a" });
let bytes = existsSync(LOG_FILE) ? statSync(LOG_FILE).size : 0;

function rotateIfNeeded() {
  if (bytes < LOG_MAX_BYTES) return;
  try {
    out.end();
    // renameSync overwrites existing destination on Linux
    renameSync(LOG_FILE, ROTATED_FILE);
  } catch (err) {
    process.stderr.write(`[log-tee] rotate failed: ${err}\n`);
  }
  out = createWriteStream(LOG_FILE, { flags: "a" });
  bytes = 0;
}

function tee(stream, dest) {
  stream.on("data", (chunk) => {
    dest.write(chunk);
    out.write(chunk);
    bytes += chunk.length;
    rotateIfNeeded();
  });
}

// LOG_TEE=1 tells src/lib/log.ts to skip its direct-file write,
// since this supervisor already mirrors stdout to LOG_FILE for it.
const child = spawn("node", [SERVER_ENTRY], {
  stdio: ["inherit", "pipe", "pipe"],
  env: { ...process.env, LOG_TEE: "1", LOG_FILE },
});

tee(child.stdout, process.stdout);
tee(child.stderr, process.stderr);

const forward = (sig) => {
  if (!child.killed) child.kill(sig);
};
process.on("SIGTERM", () => forward("SIGTERM"));
process.on("SIGINT", () => forward("SIGINT"));

child.on("exit", (code, signal) => {
  out.end(() => {
    process.exit(code ?? (signal ? 1 : 0));
  });
});

child.on("error", (err) => {
  process.stderr.write(`[log-tee] failed to spawn ${SERVER_ENTRY}: ${err}\n`);
  process.exit(1);
});
