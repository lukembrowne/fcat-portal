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
    }

    if (stuckJobs.length > 0) {
      console.log(`[db] Recovered ${stuckJobs.length} stuck processing job(s)`);
    }
  } catch {
    // Schema might not exist yet during first push
  }
}
