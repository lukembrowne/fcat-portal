/**
 * Database Connection — Singleton pattern with WAL mode
 *
 * Uses module-level variable for singleton (not globalThis).
 * Recovers stuck jobs on startup.
 *
 * Corruption prevention:
 * - busy_timeout prevents SQLITE_BUSY on concurrent writes
 * - WAL autocheckpoint keeps WAL file bounded
 * - Graceful shutdown checkpoints WAL before exit
 */

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import path from "path";
import fs from "fs";
import * as schema from "./schema";
import { log } from "@/lib/log";

const TEMP_BASE = path.join(process.cwd(), "data", "tmp");

let _db: BetterSQLite3Database<typeof schema> | null = null;
let _sqlite: InstanceType<typeof Database> | null = null;

function getDbPath(): string {
  const dbPath = process.env.DB_PATH || "data/portal.db";
  return path.isAbsolute(dbPath) ? dbPath : path.join(process.cwd(), dbPath);
}

export function getDb(): BetterSQLite3Database<typeof schema> {
  if (_db) return _db;

  const dbPath = getDbPath();

  // Ensure data directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const sqlite = new Database(dbPath);
  _sqlite = sqlite;

  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqlite.pragma("wal_autocheckpoint = 1000");

  // Structural integrity check on startup — catch corruption before it spreads.
  // SQLite 3.37+ reports type affinity mismatches (e.g., "NUMERIC value in ...")
  // alongside real corruption. Filter these out since they're harmless.
  const integrity = sqlite.pragma("integrity_check") as { integrity_check: string }[];
  const firstResult = integrity[0]?.integrity_check;
  if (firstResult !== "ok") {
    const typeAffinityPattern = /^(NUMERIC|TEXT|NULL|REAL|BLOB|INTEGER) value in /;
    const structuralIssues = integrity.filter(
      (r) => !typeAffinityPattern.test(r.integrity_check)
    );
    if (structuralIssues.length > 0) {
      log.error({ structuralIssues }, "[db] DATABASE INTEGRITY CHECK FAILED");
      throw new Error("Database integrity check failed — the database file may be corrupted");
    }
    log.warn({ count: integrity.length }, "[db] Integrity check: type affinity warnings (non-critical)");
  } else {
    log.info("[db] Integrity check: ok");
  }

  // Startup health report
  logStartupHealth(dbPath);

  _db = drizzle(sqlite, { schema });

  // Stuck-job recovery is invoked from instrumentation.ts at server start —
  // it runs exactly once per process there, so no globalThis guard is needed
  // here, and lazy hot-reload re-init can no longer create zombie jobs.

  return _db;
}

export const db = new Proxy({} as BetterSQLite3Database<typeof schema>, {
  get(_target, prop) {
    const real = getDb();
    const value = (real as unknown as Record<string | symbol, unknown>)[prop];
    // Bind methods to the real Drizzle instance so `this` isn't the Proxy
    if (typeof value === "function") {
      return value.bind(real);
    }
    return value;
  },
});

function logStartupHealth(dbPath: string) {
  try {
    const dbStat = fs.statSync(dbPath);
    const walPath = dbPath + "-wal";
    const walSize = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;

    log.info(
      `[db] Database: ${(dbStat.size / 1024 / 1024).toFixed(1)}MB, WAL: ${(walSize / 1024 / 1024).toFixed(1)}MB`
    );
    // Integrity check result is logged in getDb() before this function runs

    // Check backup freshness
    const backupDir = path.join(path.dirname(dbPath), "backups");
    if (fs.existsSync(backupDir)) {
      const backups = fs
        .readdirSync(backupDir)
        .filter((f) => f.startsWith("portal-") && f.endsWith(".db"))
        .sort()
        .reverse();

      if (backups.length > 0) {
        const latestStat = fs.statSync(path.join(backupDir, backups[0]));
        const ageHours = (Date.now() - latestStat.mtimeMs) / (1000 * 60 * 60);

        if (ageHours > 2) {
          log.warn(
            `[db] WARNING: Latest backup is ${ageHours.toFixed(1)}h old (${backups[0]})`
          );
        } else {
          log.info(`[db] Latest backup: ${backups[0]} (${ageHours.toFixed(1)}h ago)`);
        }
      } else {
        log.warn("[db] WARNING: No backups found in data/backups/");
      }
    } else {
      log.warn("[db] WARNING: Backup directory does not exist (data/backups/)");
    }
  } catch (e) {
    log.warn({ err: e }, "[db] Could not complete startup health check");
  }
}

// Graceful shutdown: checkpoint WAL before exit
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (_sqlite) {
      try {
        _sqlite.pragma("wal_checkpoint(TRUNCATE)");
        log.info("[db] WAL checkpoint completed on shutdown");
      } catch {
        // DB might already be closed
      }
    }
    process.exit(0);
  });
}

/**
 * Reset jobs left in `processing` from a previous server lifecycle so they
 * resume on the next queue tick instead of being marked failed.
 *
 * Per-image writes in ml-runner mean partially-finished jobs already have
 * detections + identifications persisted for completed images. Resetting the
 * job to `pending` and re-running it through `processJobInternal` (which
 * filters to images with `status = pending`) picks up only the leftover work.
 */
export function recoverStuckJobs() {
  const database = getDb();
  try {
    const stuckJobs = database
      .select()
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.status, "processing"))
      .all();

    for (const job of stuckJobs) {
      log.warn(
        {
          jobId: job.id,
          deploymentId: job.deploymentId,
          jobType: job.jobType,
          phase: job.statusMessage,
          startedAt: job.startedAt,
        },
        "[db] Resuming interrupted job"
      );

      database
        .update(schema.processingJobs)
        .set({
          status: "pending",
          startedAt: null,
          statusMessage: "Reanudando trabajo interrumpido...",
          errorMessage: null,
          pid: null,
        })
        .where(eq(schema.processingJobs.id, job.id))
        .run();

      // Leave deployment.status alone — the deployment is still mid-processing
      // semantically; only the runner died.

      // Reset images that didn't finish back to `pending` so they re-enter the
      // ML run. Already-processed images keep their detections/identifications.
      const jobImages = database
        .select()
        .from(schema.images)
        .where(eq(schema.images.jobId, job.id))
        .all();

      for (const img of jobImages) {
        if (img.status === "processed") continue;

        const update: { status: "pending"; path?: null } = { status: "pending" };
        if (img.path && img.path.includes("/tmp/ct-job-")) {
          update.path = null;
        }
        database
          .update(schema.images)
          .set(update)
          .where(eq(schema.images.id, img.id))
          .run();
      }
    }

    if (stuckJobs.length > 0) {
      log.info({ count: stuckJobs.length }, "[db] Resumed interrupted jobs");
    }

    // Clean up orphaned temp directories
    try {
      if (fs.existsSync(TEMP_BASE)) {
        const entries = fs.readdirSync(TEMP_BASE);
        for (const entry of entries) {
          if (entry.startsWith("ct-job-")) {
            const dirPath = path.join(TEMP_BASE, entry);
            fs.rmSync(dirPath, { recursive: true, force: true });
            log.info({ dirPath }, "[db] Cleaned up orphaned temp dir");
          }
        }
      }
    } catch {
      // temp dir cleanup is best-effort
    }
  } catch {
    // Schema might not exist yet during first push
  }
}
