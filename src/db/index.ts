/**
 * Database Connection — Singleton pattern with WAL mode
 *
 * Uses module-level variable for singleton (not globalThis).
 * Recovers stuck jobs on startup.
 */

import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import path from "path";
import fs from "fs";
import * as schema from "./schema";

const TEMP_BASE = path.join(process.cwd(), "data", "tmp");

let _db: BetterSQLite3Database<typeof schema> | null = null;

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
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  _db = drizzle(sqlite, { schema });

  // Recover stuck jobs on startup
  recoverStuckJobs(_db);

  return _db;
}

export const db = new Proxy({} as BetterSQLite3Database<typeof schema>, {
  get(_target, prop) {
    return (getDb() as unknown as Record<string | symbol, unknown>)[prop];
  },
});

function recoverStuckJobs(database: BetterSQLite3Database<typeof schema>) {
  try {
    const stuckJobs = database
      .select()
      .from(schema.processingJobs)
      .where(eq(schema.processingJobs.status, "processing"))
      .all();

    for (const job of stuckJobs) {
      database
        .update(schema.processingJobs)
        .set({ status: "failed", errorMessage: "Job interrupted by server restart" })
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
