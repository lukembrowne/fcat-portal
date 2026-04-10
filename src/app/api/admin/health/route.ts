/**
 * Admin Health Snapshot
 *
 * Lightweight system status for /admin/logs:
 *   - DB + WAL file sizes
 *   - Most recent backup name + timestamp + size
 *   - ML venv readiness
 *   - Active processing job count
 *   - Process uptime + RSS memory
 *
 * Read-only, no streaming. Polled by the client every ~10s.
 * Security: requireAdmin().
 */

import { requireAdmin } from "@/lib/auth";
import { db } from "@/db";
import { processingJobs } from "@/db/schema";
import { log } from "@/lib/log";
import { inArray, sql } from "drizzle-orm";
import { promises as fsp } from "node:fs";
import path from "node:path";

export const dynamic = "force-dynamic";

const DATA_DIR = path.join(process.cwd(), "data");

async function safeStat(p: string) {
  try {
    return await fsp.stat(p);
  } catch {
    return null;
  }
}

async function findLatestBackup() {
  const backupsDir = path.join(DATA_DIR, "backups");
  try {
    const entries = await fsp.readdir(backupsDir);
    let newest: { name: string; mtimeMs: number; size: number } | null = null;
    for (const name of entries) {
      if (!name.startsWith("portal-") || !name.endsWith(".db")) continue;
      const st = await safeStat(path.join(backupsDir, name));
      if (!st) continue;
      if (!newest || st.mtimeMs > newest.mtimeMs) {
        newest = { name, mtimeMs: st.mtimeMs, size: st.size };
      }
    }
    return newest;
  } catch {
    return null;
  }
}

export async function GET() {
  const user = await requireAdmin();
  log.debug({ userEmail: user.email }, "admin health snapshot requested");

  const dbPath = path.join(DATA_DIR, "portal.db");
  const walPath = path.join(DATA_DIR, "portal.db-wal");
  const mlVenvBin = path.join(DATA_DIR, "ml-venv", "bin", "python");
  const portalLogPath = path.join(DATA_DIR, "logs", "portal.log");
  const cronLogPath = path.join(DATA_DIR, "backups", "cron.log");

  const [dbStat, walStat, mlStat, portalLogStat, cronLogStat, latestBackup] =
    await Promise.all([
      safeStat(dbPath),
      safeStat(walPath),
      safeStat(mlVenvBin),
      safeStat(portalLogPath),
      safeStat(cronLogPath),
      findLatestBackup(),
    ]);

  let activeJobCount = 0;
  try {
    const rows = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(processingJobs)
      .where(inArray(processingJobs.status, ["pending", "processing"]));
    activeJobCount = Number(rows[0]?.count ?? 0);
  } catch {
    // best effort — db unavailable
  }

  const mem = process.memoryUsage();

  return Response.json({
    serverTime: new Date().toISOString(),
    nodeVersion: process.version,
    uptimeSec: Math.floor(process.uptime()),
    rssBytes: mem.rss,
    heapUsedBytes: mem.heapUsed,
    db: {
      sizeBytes: dbStat?.size ?? null,
      walSizeBytes: walStat?.size ?? null,
      modifiedAt: dbStat ? new Date(dbStat.mtimeMs).toISOString() : null,
    },
    activeJobCount,
    latestBackup: latestBackup
      ? {
          name: latestBackup.name,
          at: new Date(latestBackup.mtimeMs).toISOString(),
          sizeBytes: latestBackup.size,
        }
      : null,
    mlVenvReady: mlStat !== null,
    logs: {
      portal: portalLogStat
        ? { sizeBytes: portalLogStat.size, modifiedAt: new Date(portalLogStat.mtimeMs).toISOString() }
        : null,
      cron: cronLogStat
        ? { sizeBytes: cronLogStat.size, modifiedAt: new Date(cronLogStat.mtimeMs).toISOString() }
        : null,
    },
  });
}
