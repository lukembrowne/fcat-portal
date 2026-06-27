/**
 * Shared-drive reconciliation worker.
 *
 * Trues up each registered Shared Drive's `reconciled_count` against Drive API
 * ground truth, health-checks SA access, absorbs in-flight reservation tokens,
 * and emits capacity / health events. Run from the nightly cron and the admin
 * "Reconcile now" action (single-flight via findActiveSharedDriveReconcileJob).
 *
 * Cadence:
 *   - Nightly: `changes.list?driveId` delta (cheap, ~1–5 calls/drive)
 *   - Sunday (weekly): full `files.list?driveId` count + token rotation
 *   - First run for a drive (no token): full count, then store the start token
 *
 * Named `-worker` to match audio-sync-worker / camera-trap-sync-worker. Run
 * directly (not via the unified queue) like drive_sync — it's read-heavy Drive
 * metadata work that should not serialize behind multi-hour ML runs.
 */

import "server-only";

import pLimit from "p-limit";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { processingJobs, sharedDrives, type SharedDrive } from "@/db/schema";
import { log } from "@/lib/log";
import {
  recordEvent,
  buildJobStartEvent,
  buildJobCompletionEvent,
} from "@/lib/system-events";
import {
  getSharedDriveMetadata,
  countSharedDriveItems,
  getChangesStartPageToken,
  listSharedDriveChangesDelta,
} from "@/lib/drive-client";
import {
  getSoftPct,
  getHardPct,
  getStopPct,
  sanitizeDriveError,
  getProjectCapacities,
} from "@/lib/shared-drives";

// Cap parallel per-drive Drive work to stay under the per-SA quota
// (~325K units/min). 5 drives × pageSize 1000 (100 units) keeps headroom.
const RECONCILE_CONCURRENCY = 5;

// Drift beyond this fraction AND absolute count emits a warning (informational
// on delta runs, corrective on full runs).
const DRIFT_PCT = 0.05;
const DRIFT_MIN_ITEMS = 1000;

interface ReconcileResult {
  id: string;
  name: string;
  before: number;
  after: number;
  mode: "full" | "delta";
  unreachable?: boolean;
}

/** Drives the nightly job touches: everything registered, baselined, visible. */
function getReconcilableDrives(): SharedDrive[] {
  return db
    .select()
    .from(sharedDrives)
    .where(sql`${sharedDrives.archivedAt} IS NULL AND ${sharedDrives.status} != 'registering'`)
    .all();
}

function nowSql(): string {
  const row = db.get(sql`SELECT datetime('now') AS t`) as { t: string };
  return row.t;
}

function hadRecentEvent(eventType: string, driveId: string): boolean {
  const row = db.get(sql`
    SELECT 1 AS x FROM system_events
    WHERE source = 'shared-drives'
      AND event_type = ${eventType}
      AND target_id = ${driveId}
      AND occurred_at >= unixepoch('now', '-1 day')
    LIMIT 1
  `) as { x: number } | undefined;
  return !!row;
}

/**
 * Reconcile a single drive. Never throws — a Drive failure flips the drive to
 * `unreachable` and returns. Caller wraps in allSettled regardless.
 */
async function reconcileOneDrive(
  drive: SharedDrive,
  opts: { isFullCount: boolean },
): Promise<ReconcileResult> {
  const before = drive.reconciledCount;

  // Snapshot scan-start so we only absorb reservations that predate this run.
  const snapshotTime = nowSql();

  // 1. Health check (also our access probe).
  try {
    await getSharedDriveMetadata(drive.driveId);
  } catch (err) {
    const sanitized = sanitizeDriveError(err);
    db.run(sql`
      UPDATE shared_drives
      SET status = 'unreachable',
          last_health_status = ${sanitized},
          last_health_check_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ${drive.id}
    `);
    await recordEvent({
      source: "shared-drives",
      eventType: "drive_unreachable",
      severity: "error",
      summary: `Shared Drive inaccesible: ${drive.name}`,
      targetType: "shared_drive",
      targetId: drive.id,
      details: { error: sanitized },
    });
    return { id: drive.id, name: drive.name, before, after: before, mode: "delta", unreachable: true };
  }

  // 2. Count: full (Sunday / no token yet) vs delta.
  const doFull = opts.isFullCount || !drive.changesPageToken;
  let after: number;
  let newPageToken: string;
  // Trashed (purgeable) count is only re-measured on the full count; delta runs
  // can't reliably track untrash/purge transitions, so carry the last value.
  let trashedAfter = drive.trashedCount;
  if (doFull) {
    const counts = await countSharedDriveItems(drive.driveId);
    after = counts.total;
    trashedAfter = counts.trashed;
    newPageToken = await getChangesStartPageToken(drive.driveId);
  } else {
    const { delta, newStartPageToken } = await listSharedDriveChangesDelta(
      drive.driveId,
      drive.changesPageToken!,
      // Start of this delta's window: count only files created since the last
      // reconcile, so modifications / moves / a drive-wide permission change
      // don't re-count already-counted items (the 2026-06-27 817K spike).
      drive.lastReconciledAt,
    );
    after = Math.max(0, before + delta);
    newPageToken = newStartPageToken;
  }

  // 3. Drift check (informational; full runs are themselves the correction).
  const drift = Math.abs(after - before);
  if (drift > DRIFT_MIN_ITEMS && before > 0 && drift / before > DRIFT_PCT) {
    await recordEvent({
      source: "shared-drives",
      eventType: "drive_count_drift",
      severity: "warn",
      summary: `Deriva de conteo en ${drive.name}: ${before.toLocaleString()} → ${after.toLocaleString()}`,
      targetType: "shared_drive",
      targetId: drive.id,
      details: { before, after, mode: doFull ? "full" : "delta" },
    });
  }

  // 4. Persist count + absorb pre-snapshot reservations (single transaction).
  db.transaction((tx) => {
    tx.run(sql`
      UPDATE shared_drives
      SET reconciled_count = ${after},
          trashed_count = ${trashedAfter},
          last_reconciled_at = datetime('now'),
          last_full_reconcile_at = ${doFull ? sql`datetime('now')` : sql`last_full_reconcile_at`},
          changes_page_token = ${newPageToken},
          last_health_check_at = datetime('now'),
          last_health_status = 'ok',
          status = CASE WHEN status = 'unreachable' THEN 'active' ELSE status END,
          pending_reservations_count = (
            SELECT COALESCE(SUM(quota), 0) FROM shared_drive_reservations
            WHERE shared_drive_id = ${drive.id}
              AND released_at IS NULL
              AND created_at > ${snapshotTime}
          ),
          updated_at = datetime('now')
      WHERE id = ${drive.id}
    `);
    tx.run(sql`
      UPDATE shared_drive_reservations
      SET released_at = datetime('now')
      WHERE shared_drive_id = ${drive.id}
        AND released_at IS NULL
        AND created_at <= ${snapshotTime}
    `);
  });

  // 5. Threshold transitions + re-nag (24h dedup per level).
  await applyThresholdTransitions(drive, after);

  return { id: drive.id, name: drive.name, before, after, mode: doFull ? "full" : "delta" };
}

async function applyThresholdTransitions(
  drive: SharedDrive,
  count: number,
): Promise<void> {
  const cap = drive.itemCap;
  if (cap <= 0) return;
  const ratio = count / cap;
  const pctStr = `${(ratio * 100).toFixed(1)}%`;

  if (ratio >= getStopPct()) {
    // Auto-flip to read-only — the selector stops picking it immediately.
    // Only act (and alert) if it isn't already read-only.
    if (drive.status === "active") {
      db.run(sql`
        UPDATE shared_drives SET status = 'read-only', updated_at = datetime('now')
        WHERE id = ${drive.id} AND status = 'active'
      `);
      await recordEvent({
        source: "shared-drives",
        eventType: "drive_full_readonly",
        severity: "error",
        summary: `Shared Drive lleno (${pctStr}) — ${drive.name} ahora es solo-lectura`,
        targetType: "shared_drive",
        targetId: drive.id,
        details: { count, cap, ratio },
      });
    }
    return;
  }

  if (ratio >= getHardPct()) {
    if (!hadRecentEvent("drive_threshold_hard", drive.id)) {
      await recordEvent({
        source: "shared-drives",
        eventType: "drive_threshold_hard",
        severity: "error",
        summary: `Umbral crítico (${pctStr}) en ${drive.name} — aprovisionar un nuevo drive YA`,
        targetType: "shared_drive",
        targetId: drive.id,
        details: { count, cap, ratio },
      });
    }
    return;
  }

  if (ratio >= getSoftPct()) {
    if (!hadRecentEvent("drive_threshold_soft", drive.id)) {
      await recordEvent({
        source: "shared-drives",
        eventType: "drive_threshold_soft",
        severity: "warn",
        summary: `Umbral de aviso (${pctStr}) en ${drive.name} — planificar aprovisionamiento`,
        targetType: "shared_drive",
        targetId: drive.id,
        details: { count, cap, ratio },
      });
    }
  }
}

function hadRecentProjectEvent(eventType: string, projectId: number): boolean {
  const row = db.get(sql`
    SELECT 1 AS x FROM system_events
    WHERE source = 'shared-drives'
      AND event_type = ${eventType}
      AND target_id = ${String(projectId)}
      AND occurred_at >= unixepoch('now', '-1 day')
    LIMIT 1
  `) as { x: number } | undefined;
  return !!row;
}

/**
 * After per-drive counts are trued up, roll up capacity per project and warn
 * when a project should provision its next drive — either it has no active
 * drive with headroom (urgent), or its emptiest active drive is already past the
 * soft threshold (a single new deployment could fill it). 24h dedup per project.
 */
async function emitProjectProvisionAlerts(): Promise<void> {
  const soft = getSoftPct();
  const names = new Map<number, string>();
  for (const p of db.all(sql`SELECT id, name FROM ct_projects`) as {
    id: number;
    name: string;
  }[]) {
    names.set(p.id, p.name);
  }

  for (const c of getProjectCapacities()) {
    const needsProvision =
      !c.hasHeadroom ||
      (c.emptiestActiveFill !== null && c.emptiestActiveFill >= soft);
    if (!needsProvision) continue;
    if (hadRecentProjectEvent("project_provision_ahead", c.projectId)) continue;

    const name = names.get(c.projectId) ?? `#${c.projectId}`;
    const pctStr =
      c.capTotal > 0
        ? `${((c.effectiveTotal / c.capTotal) * 100).toFixed(1)}%`
        : "—";
    await recordEvent({
      source: "shared-drives",
      eventType: "project_provision_ahead",
      severity: c.hasHeadroom ? "warn" : "error",
      summary: c.hasHeadroom
        ? `Proyecto ${name}: aprovisiona el próximo Shared Drive pronto (${pctStr})`
        : `Proyecto ${name}: sin capacidad — aprovisiona un Shared Drive YA (${pctStr})`,
      targetType: "ct_project",
      targetId: String(c.projectId),
      details: {
        projectId: c.projectId,
        driveCount: c.driveCount,
        activeDriveCount: c.activeDriveCount,
        effectiveTotal: c.effectiveTotal,
        capTotal: c.capTotal,
        emptiestActiveFill: c.emptiestActiveFill,
        hasHeadroom: c.hasHeadroom,
      },
    });
  }
}

/**
 * Entry point dispatched for a `shared_drives_reconcile` processing job. Run
 * directly by the cron endpoint / admin action (not the unified queue).
 */
export async function runReconciliationJob(jobId: number): Promise<void> {
  const [job] = await db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId));
  if (!job) {
    log.warn({ jobId }, "[shared-drives] reconcile job row missing");
    return;
  }

  const isFullCount = new Date().getUTCDay() === 0; // Sunday → weekly full
  const drives = getReconcilableDrives();

  // Mark processing + emit start event once.
  await db
    .update(processingJobs)
    .set({
      status: "processing",
      startedAt: job.startedAt ?? new Date(),
      totalImages: drives.length,
      processedImages: 0,
      statusMessage: drives.length
        ? `Reconciliando ${drives.length} drive(s)...`
        : "Sin drives para reconciliar",
    })
    .where(eq(processingJobs.id, jobId));
  const [startedJob] = await db
    .select()
    .from(processingJobs)
    .where(eq(processingJobs.id, jobId));
  if (startedJob) {
    void recordEvent(buildJobStartEvent(startedJob)).catch(() => {});
  }

  const startMs = Date.now();
  try {
    const limit = pLimit(RECONCILE_CONCURRENCY);
    let processed = 0;
    const results = await Promise.allSettled(
      drives.map((d) =>
        limit(async () => {
          const r = await reconcileOneDrive(d, { isFullCount });
          processed += 1;
          await db
            .update(processingJobs)
            .set({
              processedImages: processed,
              statusMessage: `Reconciliando ${d.name} (${processed} de ${drives.length})`,
            })
            .where(eq(processingJobs.id, jobId));
          return r;
        }),
      ),
    );

    const ok = results.filter((r) => r.status === "fulfilled").length;
    const failed = results.length - ok;

    // Per-project provision-ahead alerts (after all counts are trued up).
    await emitProjectProvisionAlerts();
    const driveDeltas = results
      .filter((r): r is PromiseFulfilledResult<ReconcileResult> => r.status === "fulfilled")
      .map((r) => ({
        id: r.value.id,
        before: r.value.before,
        after: r.value.after,
        mode: r.value.mode,
        unreachable: r.value.unreachable ?? false,
      }));

    await db
      .update(processingJobs)
      .set({
        status: "completed",
        completedAt: new Date(),
        processedImages: ok,
        failedImages: failed,
        statusMessage: `Reconciliación completada · ${ok}/${drives.length} drives`,
      })
      .where(eq(processingJobs.id, jobId));

    const [done] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId));
    if (done) {
      await recordEvent(
        buildJobCompletionEvent(done, { isFullCount, driveDeltas }),
      );
    }
    log.info(
      { jobId, drives: drives.length, ok, failed, isFullCount, elapsedMs: Date.now() - startMs },
      "[shared-drives] reconcile complete",
    );
  } catch (err) {
    log.error({ err, jobId }, "[shared-drives] reconcile failed");
    await db
      .update(processingJobs)
      .set({
        status: "failed",
        completedAt: new Date(),
        errorMessage: err instanceof Error ? err.message : String(err),
        statusMessage: "Reconciliación fallida",
      })
      .where(eq(processingJobs.id, jobId));
    const [failedJob] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, jobId));
    if (failedJob) {
      await recordEvent(buildJobCompletionEvent(failedJob));
    }
  }
}
