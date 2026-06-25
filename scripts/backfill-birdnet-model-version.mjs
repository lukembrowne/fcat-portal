#!/usr/bin/env node

/**
 * One-time backfill: stamp the real BirdNET version onto existing predictions.
 *
 * Before version tracking, every BirdNET detection/identification was tagged
 * with the literal string "birdnet-analyzer" (no version). BirdNET hasn't been
 * upgraded since, so those predictions were effectively made with the version
 * currently installed in the ML venv. This script reads that version (via the
 * same `get_model_version()` logic in birdnet-runner.py) and rewrites the bare
 * "birdnet-analyzer" rows to the real `birdnet-analyzer@<version>` string.
 *
 * MUST be run INSIDE the Docker container:
 *   - the ML venv python is container-only, and
 *   - bare host scripts against data/portal.db while the container holds it
 *     open can corrupt SQLite on macOS bind mounts.
 *
 * Usage:
 *   docker compose exec portal node scripts/backfill-birdnet-model-version.mjs
 *
 * Idempotent: only rows whose model_version is exactly "birdnet-analyzer" are
 * touched, so re-running after the rollout is a no-op.
 */

import Database from "better-sqlite3";
import path from "path";
import { execFileSync } from "child_process";

const OLD_VALUE = "birdnet-analyzer";

const DB_PATH = process.env.DB_PATH || "data/portal.db";
const dbPath = path.isAbsolute(DB_PATH) ? DB_PATH : path.join(process.cwd(), DB_PATH);

const BIRDNET_SCRIPT = path.join(process.cwd(), "scripts", "birdnet-runner.py");

function getMlPython() {
  return (
    process.env.BIRDNET_PYTHON_PATH ||
    process.env.ML_PYTHON_PATH ||
    path.join(process.cwd(), "data", "ml-venv", "bin", "python3")
  );
}

function getCurrentModelVersion() {
  const python = getMlPython();
  const out = execFileSync(python, [BIRDNET_SCRIPT, "--print-version"], {
    encoding: "utf-8",
  });
  return out.trim();
}

function main() {
  const modelVersion = getCurrentModelVersion();
  if (!modelVersion || modelVersion === OLD_VALUE || modelVersion.includes("@unknown")) {
    console.error(
      `[backfill] Refusing to run: could not resolve a real version (got "${modelVersion}"). ` +
        `Run this INSIDE the container (docker compose exec portal node ...) where the ML venv is available.`
    );
    process.exit(1);
  }
  console.log(`[backfill] Current BirdNET version: ${modelVersion}`);

  const db = new Database(dbPath);
  db.pragma("busy_timeout = 5000");

  const tables = ["audio_detections", "audio_identifications"];
  let total = 0;
  const tx = db.transaction(() => {
    for (const table of tables) {
      const res = db
        .prepare(`UPDATE ${table} SET model_version = ? WHERE model_version = ?`)
        .run(modelVersion, OLD_VALUE);
      console.log(`[backfill] ${table}: updated ${res.changes} row(s)`);
      total += res.changes;
    }
  });
  tx();

  db.close();
  console.log(`[backfill] Done. Updated ${total} row(s) total.`);
}

main();
