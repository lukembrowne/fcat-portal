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
      console.error("[db] DATABASE INTEGRITY CHECK FAILED:", structuralIssues);
      throw new Error("Database integrity check failed — the database file may be corrupted");
    }
    console.warn(`[db] Integrity check: ${integrity.length} type affinity warnings (non-critical)`);
  } else {
    console.log("[db] Integrity check: ok");
  }

  // Startup health report
  logStartupHealth(dbPath);

  _db = drizzle(sqlite, { schema });

  // Recover stuck jobs on startup — only once per process.
  // globalThis survives hot reload; module-level _db does not.
  // Without this guard, hot reload re-runs recoverStuckJobs, which marks
  // actively-running jobs as "failed" while their Promises keep going (zombie jobs).
  const RECOVERY_KEY = "__portal_jobs_recovered";
  const g = globalThis as unknown as Record<string, boolean>;
  if (!g[RECOVERY_KEY]) {
    recoverStuckJobs(_db);
    g[RECOVERY_KEY] = true;
  }

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

    console.log(
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
          console.warn(
            `[db] WARNING: Latest backup is ${ageHours.toFixed(1)}h old (${backups[0]})`
          );
        } else {
          console.log(`[db] Latest backup: ${backups[0]} (${ageHours.toFixed(1)}h ago)`);
        }
      } else {
        console.warn("[db] WARNING: No backups found in data/backups/");
      }
    } else {
      console.warn("[db] WARNING: Backup directory does not exist (data/backups/)");
    }
  } catch (e) {
    console.warn("[db] Could not complete startup health check:", e);
  }
}

// Graceful shutdown: checkpoint WAL before exit
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    if (_sqlite) {
      try {
        _sqlite.pragma("wal_checkpoint(TRUNCATE)");
        console.log("[db] WAL checkpoint completed on shutdown");
      } catch {
        // DB might already be closed
      }
    }
    process.exit(0);
  });
}

function recoverStuckJobs(database: BetterSQLite3Database<typeof schema>) {
  try {
    const stuckJobs = database
      .select()
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.status, "processing"))
      .all();

    for (const job of stuckJobs) {
      console.warn(
        `[db] Recovering stuck job ${job.id}: deployment=${job.deploymentId}, type=${job.jobType}, phase="${job.statusMessage}", started=${job.startedAt}`
      );

      database
        .update(schema.processingJobs)
        .set({
          status: "failed",
          errorMessage: `Job interrupted by server restart (phase: ${job.statusMessage || "unknown"})`,
        })
        .where(eq(schema.processingJobs.id, job.id))
        .run();

      // Also reset the deployment status
      database
        .update(schema.deployments)
        .set({ status: "scanned", updatedAt: new Date() })
        .where(eq(schema.deployments.id, job.deploymentId))
        .run();

      // Clear temp paths from images belonging to failed jobs
      const jobImages = database
        .select()
        .from(schema.images)
        .where(eq(schema.images.jobId, job.id))
        .all();

      for (const img of jobImages) {
        if (img.path && img.path.includes("/tmp/ct-job-")) {
          database
            .update(schema.images)
            .set({ path: null })
            .where(eq(schema.images.id, img.id))
            .run();
        }
      }
    }

    if (stuckJobs.length > 0) {
      console.log(`[db] Recovered ${stuckJobs.length} stuck processing job(s)`);
    }

    // Clean up orphaned temp directories
    try {
      if (fs.existsSync(TEMP_BASE)) {
        const entries = fs.readdirSync(TEMP_BASE);
        for (const entry of entries) {
          if (entry.startsWith("ct-job-")) {
            const dirPath = path.join(TEMP_BASE, entry);
            fs.rmSync(dirPath, { recursive: true, force: true });
            console.log(`[db] Cleaned up orphaned temp dir: ${dirPath}`);
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
