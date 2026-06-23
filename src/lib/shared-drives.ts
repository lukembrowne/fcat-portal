/**
 * Multi-Shared-Drive fan-out — registry queries, atomic capacity-based
 * selection, reservation tokens, and small event/util helpers.
 *
 * Background: Google caps a Shared Drive at 500,000 items. FCAT-BIOCHOCO is
 * near that cap, so new deployment folders fan out across multiple registered
 * Shared Drives. The codebase is already drive-agnostic (every Drive API call
 * uses `supportsAllDrives: true`), so this module only governs WHICH drive a
 * NEW deployment folder is created under. Existing per-file `driveFileId`
 * reads are unaffected.
 *
 * Capacity model (two counters; see schema.ts):
 *   effectiveCount = reconciledCount + pendingReservationsCount
 *   - reconciledCount: Drive API ground truth (nightly delta / weekly full)
 *   - pendingReservationsCount: in-flight folder reservations, denormalized
 *     from the open `shared_drive_reservations` token rows for fast selection.
 *
 * Alert thresholds (industry 75/85/95 convention):
 *   - soft (75%): re-nag alert; provision soon
 *   - hard (85%): selector refuses NEW reservations
 *   - stop (95%): reconcile auto-flips the drive to status='read-only'
 */

import "server-only";

import { randomUUID } from "crypto";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { sharedDrives, type SharedDrive, type SharedDriveStatus } from "@/db/schema";

// Per-deployment item reservation (audio + camera-trap + frames + iButton +
// folder overhead). Reserved up-front at folder-create, trued up nightly by
// reconcile against the Drive-API ground truth. This is a SOFT reservation, not
// a hard per-folder limit: under-reserving self-corrects on the next reconcile,
// and the 95% read-only auto-flip backstops a runaway. Sized at 10k to match
// observed reality (avg ~6.9k items/deployment, heaviest observed ~8.5k) so
// batch folder-creation on a fresh drive doesn't hit a false "no capacity" wall
// after only ~10 folders. Override with SHARED_DRIVE_DEPLOYMENT_QUOTA if needed.
function intEnv(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export const DEPLOYMENT_QUOTA = intEnv("SHARED_DRIVE_DEPLOYMENT_QUOTA", 10_000);

// Validates a Google Shared Drive ID (starts with 0A). Folder IDs do NOT match
// this — that's intentional, registration must be given the drive ID.
export const DRIVE_ID_REGEX = /^0A[A-Za-z0-9_-]{15,40}$/;

// ---------------------------------------------------------------------------
// Feature flags (both default OFF; flip discovery first, routing second)
// ---------------------------------------------------------------------------

/** Gates the union discovery scan across all registered drives. Flip first. */
export function sharedDriveDiscoveryEnabled(): boolean {
  return process.env.SHARED_DRIVE_DISCOVERY_ENABLED === "true";
}

/** Gates capacity-based routing of new deployment folders. Flip second. */
export function sharedDriveRoutingEnabled(): boolean {
  return process.env.SHARED_DRIVE_ROUTING_ENABLED === "true";
}

// ---------------------------------------------------------------------------
// Thresholds (env-configurable; accept either 75 or 0.75 form)
// ---------------------------------------------------------------------------

function pct(envName: string, fallback: number): number {
  const raw = process.env[envName];
  if (!raw) return fallback;
  let n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  if (n > 1) n = n / 100; // accept "75" as 0.75
  return n > 1 ? fallback : n;
}

export const getSoftPct = () => pct("SHARED_DRIVE_SOFT_PCT", 0.75);
export const getHardPct = () => pct("SHARED_DRIVE_HARD_PCT", 0.85);
export const getStopPct = () => pct("SHARED_DRIVE_STOP_PCT", 0.95);

// ---------------------------------------------------------------------------
// Selection + reservation
// ---------------------------------------------------------------------------

export type SelectionSuccess = {
  sharedDriveId: string;
  driveId: string;
  /** Parent folder under which to create the deployment folder. */
  rootFolderId: string;
  /** REQUIRED to release the reservation on folder-create failure. */
  reservationId: string;
  reconciledCount: number;
  pendingReservationsCount: number;
};

export type SelectionResult =
  | SelectionSuccess
  | { error: "no_capacity" | "no_active_drives" };

type PickRow = {
  id: string;
  drive_id: string;
  root_folder_id: string;
  reconciled_count: number;
  pending_reservations_count: number;
};

/**
 * Atomically pick the fullest active drive still under the HARD threshold —
 * scoped to a single project's drive pool — and reserve DEPLOYMENT_QUOTA items
 * via a typed token. Synchronous better-sqlite3 transaction — never async (see
 * MEMORY gotcha).
 *
 * One project per drive: only drives with this `camera_trap_project_id` are
 * eligible, so a project can never spill into another project's drive. Bin-packs
 * (fullest-first) so a project's drives fill in order; `id ASC` is a
 * deterministic tiebreaker because SQLite does not guarantee tie resolution by
 * rowid inside a scalar subquery.
 */
export function selectAndReserveSlot(projectId: number): SelectionResult {
  const quota = DEPLOYMENT_QUOTA;
  const hardPct = getHardPct();
  const reservationId = randomUUID();

  return db.transaction((tx): SelectionResult => {
    const row = tx.get(sql`
      UPDATE shared_drives
      SET pending_reservations_count = pending_reservations_count + ${quota},
          updated_at = datetime('now')
      WHERE id = (
        SELECT id FROM shared_drives
        WHERE status = 'active'
          AND archived_at IS NULL
          AND camera_trap_project_id = ${projectId}
          AND (reconciled_count + pending_reservations_count + ${quota}) <= (item_cap * ${hardPct})
        ORDER BY (reconciled_count + pending_reservations_count) DESC, id ASC
        LIMIT 1
      )
      RETURNING id, drive_id, root_folder_id, reconciled_count, pending_reservations_count
    `) as PickRow | undefined;

    if (!row) {
      // Distinguish "no headroom on this project's drives" from "this project
      // has no active drives at all" so the caller can surface a clearer message.
      const anyActive = tx.get(sql`
        SELECT 1 AS x FROM shared_drives
        WHERE status = 'active' AND archived_at IS NULL
          AND camera_trap_project_id = ${projectId}
        LIMIT 1
      `) as { x: number } | undefined;
      return { error: anyActive ? "no_capacity" : "no_active_drives" };
    }

    tx.run(sql`
      INSERT INTO shared_drive_reservations (id, shared_drive_id, quota)
      VALUES (${reservationId}, ${row.id}, ${quota})
    `);

    return {
      sharedDriveId: row.id,
      driveId: row.drive_id,
      rootFolderId: row.root_folder_id,
      reservationId,
      reconciledCount: row.reconciled_count,
      pendingReservationsCount: row.pending_reservations_count,
    };
  });
}

/**
 * Release a reservation by token. Idempotent: if reconcile already absorbed
 * the token (marked it released), this no-ops, so the catch-block release
 * after a reconcile can't double-decrement. `MAX(0, …)` is a defensive floor.
 */
export function releaseReservation(reservationId: string): void {
  db.transaction((tx) => {
    const token = tx.get(sql`
      SELECT shared_drive_id, quota FROM shared_drive_reservations
      WHERE id = ${reservationId} AND released_at IS NULL
    `) as { shared_drive_id: string; quota: number } | undefined;
    if (!token) return; // already released / absorbed — no-op

    tx.run(sql`
      UPDATE shared_drive_reservations
      SET released_at = datetime('now')
      WHERE id = ${reservationId}
    `);
    tx.run(sql`
      UPDATE shared_drives
      SET pending_reservations_count = MAX(0, pending_reservations_count - ${token.quota}),
          updated_at = datetime('now')
      WHERE id = ${token.shared_drive_id}
    `);
  });
}

/** Attach a deployment id to a reservation once the folder + DB row exist. */
export function attachReservationToDeployment(
  reservationId: string,
  deploymentId: number,
): void {
  db.run(sql`
    UPDATE shared_drive_reservations
    SET deployment_id = ${deploymentId}
    WHERE id = ${reservationId} AND released_at IS NULL
  `);
}

// ---------------------------------------------------------------------------
// Registry queries
// ---------------------------------------------------------------------------

/** Current status of a drive (for the TOCTOU re-check between select + create). */
export function getDriveStatus(sharedDriveId: string): SharedDriveStatus | null {
  const row = db.get(sql`
    SELECT status FROM shared_drives WHERE id = ${sharedDriveId}
  `) as { status: SharedDriveStatus } | undefined;
  return row?.status ?? null;
}

export async function listDrives(): Promise<SharedDrive[]> {
  return db.select().from(sharedDrives);
}

export async function getDriveById(id: string): Promise<SharedDrive | null> {
  const [row] = await db
    .select()
    .from(sharedDrives)
    .where(sql`${sharedDrives.id} = ${id}`)
    .limit(1);
  return row ?? null;
}

/**
 * Look up a registry row by its Google Shared Drive ID (the `0A…` `drive_id`).
 * Used to map a folder's resolved host drive back to a registry slug (e.g. when
 * backfilling / stamping a deployment's `shared_drive_id`). Null = that drive
 * isn't registered yet (register it in the admin UI first).
 */
export async function getDriveByDriveId(driveId: string): Promise<SharedDrive | null> {
  const [row] = await db
    .select()
    .from(sharedDrives)
    .where(sql`${sharedDrives.driveId} = ${driveId}`)
    .limit(1);
  return row ?? null;
}

/**
 * Root folder IDs of a project's non-archived drives. Reads still resolve via
 * supportsAllDrives regardless of status, so we include active + read-only +
 * unreachable (Promise.allSettled at the call site isolates a drive that
 * genuinely can't be listed).
 */
export function getDriveRootIdsForProject(projectId: number): string[] {
  const rows = db.all(sql`
    SELECT root_folder_id FROM shared_drives
    WHERE archived_at IS NULL AND camera_trap_project_id = ${projectId}
  `) as { root_folder_id: string }[];
  return rows.map((r) => r.root_folder_id);
}

/**
 * Root folder IDs to scan when discovering deployments for a CT project.
 *
 * - Discovery flag OFF → just the project's own root (unchanged behavior).
 * - Discovery flag ON → the union of the project's own root and the roots of
 *   every non-archived drive registered to THIS project. Scoped per project, so
 *   discovery never sweeps another project's drive (no cross-contamination).
 * - A project with no registered drives → just its own root.
 */
export function getDiscoveryRootsForProject(
  projectId: number,
  projectRootFolderId: string,
): string[] {
  if (!sharedDriveDiscoveryEnabled()) return [projectRootFolderId];
  const projectRoots = getDriveRootIdsForProject(projectId);
  if (projectRoots.length === 0) return [projectRootFolderId];
  return Array.from(new Set([projectRootFolderId, ...projectRoots]));
}

/** Per-project capacity rollup for provision-ahead alerts + the admin UI. */
export type ProjectCapacity = {
  projectId: number;
  driveCount: number;
  activeDriveCount: number;
  reconciledTotal: number;
  effectiveTotal: number;
  capTotal: number;
  /** Fill of the project's emptiest ACTIVE drive (0..1); null if none active. */
  emptiestActiveFill: number | null;
  /** True if the project has at least one active drive under the hard pct. */
  hasHeadroom: boolean;
};

export function getProjectCapacities(): ProjectCapacity[] {
  const hardPct = getHardPct();
  const rows = db.all(sql`
    SELECT
      camera_trap_project_id AS pid,
      COUNT(*) AS drive_count,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active_count,
      SUM(reconciled_count) AS reconciled_total,
      SUM(reconciled_count + pending_reservations_count) AS effective_total,
      SUM(item_cap) AS cap_total,
      MIN(CASE WHEN status = 'active'
            THEN CAST(reconciled_count + pending_reservations_count AS REAL) / item_cap
          END) AS emptiest_active_fill,
      MAX(CASE WHEN status = 'active'
              AND (reconciled_count + pending_reservations_count) < (item_cap * ${hardPct})
            THEN 1 ELSE 0 END) AS has_headroom
    FROM shared_drives
    WHERE archived_at IS NULL AND camera_trap_project_id IS NOT NULL
    GROUP BY camera_trap_project_id
  `) as Array<{
    pid: number;
    drive_count: number;
    active_count: number;
    reconciled_total: number;
    effective_total: number;
    cap_total: number;
    emptiest_active_fill: number | null;
    has_headroom: number;
  }>;
  return rows.map((r) => ({
    projectId: r.pid,
    driveCount: r.drive_count,
    activeDriveCount: r.active_count,
    reconciledTotal: r.reconciled_total,
    effectiveTotal: r.effective_total,
    capTotal: r.cap_total,
    emptiestActiveFill: r.emptiest_active_fill,
    hasHeadroom: r.has_headroom === 1,
  }));
}

// ---------------------------------------------------------------------------
// Capacity alerts (shared by the alert email cron + the in-portal admin banner)
// ---------------------------------------------------------------------------

export type CapacityAlertLevel = "soft" | "hard" | "stop";

export type DriveCapacityAlert = {
  id: string;
  name: string;
  projectName: string | null;
  effectiveCount: number;
  itemCap: number;
  fillPct: number;
  trashedCount: number;
  level: CapacityAlertLevel;
};

export type ProjectProvisionAlert = {
  projectId: number;
  projectName: string;
  fillPct: number;
  /** False = no active drive with headroom (urgent). */
  hasHeadroom: boolean;
};

export type SharedDriveCapacityAlerts = {
  thresholds: { soft: number; hard: number; stop: number };
  /** Non-archived drives whose effective fill is at/over the soft threshold. */
  drives: DriveCapacityAlert[];
  /** Projects that should provision their next drive soon. */
  provisionProjects: ProjectProvisionAlert[];
  /** Any drive at/over the HARD threshold, or any project with no headroom. */
  hasCritical: boolean;
};

/**
 * Single source of truth for "is a Shared Drive approaching its cap?" — used by
 * the daily alert-email cron and the admin banner so both agree. Returns only
 * drives/projects that have actually crossed a threshold (empty when healthy).
 */
export function getSharedDriveCapacityAlerts(): SharedDriveCapacityAlerts {
  const soft = getSoftPct();
  const hard = getHardPct();
  const stop = getStopPct();

  const projectNames = new Map<number, string>();
  for (const p of db.all(sql`SELECT id, name FROM ct_projects`) as {
    id: number;
    name: string;
  }[]) {
    projectNames.set(p.id, p.name);
  }

  const driveRows = db.all(sql`
    SELECT id, name, camera_trap_project_id AS pid, status, item_cap,
           reconciled_count + pending_reservations_count AS effective,
           trashed_count
    FROM shared_drives
    WHERE archived_at IS NULL AND status != 'registering'
  `) as Array<{
    id: string;
    name: string;
    pid: number | null;
    status: string;
    item_cap: number;
    effective: number;
    trashed_count: number;
  }>;

  const drives: DriveCapacityAlert[] = [];
  for (const r of driveRows) {
    const fillPct = r.item_cap > 0 ? r.effective / r.item_cap : 0;
    if (fillPct < soft) continue;
    const level: CapacityAlertLevel =
      fillPct >= stop ? "stop" : fillPct >= hard ? "hard" : "soft";
    drives.push({
      id: r.id,
      name: r.name,
      projectName: r.pid != null ? projectNames.get(r.pid) ?? null : null,
      effectiveCount: r.effective,
      itemCap: r.item_cap,
      fillPct,
      trashedCount: r.trashed_count,
      level,
    });
  }
  drives.sort((a, b) => b.fillPct - a.fillPct);

  const provisionProjects: ProjectProvisionAlert[] = [];
  for (const c of getProjectCapacities()) {
    const needsProvision =
      !c.hasHeadroom ||
      (c.emptiestActiveFill !== null && c.emptiestActiveFill >= soft);
    if (!needsProvision) continue;
    provisionProjects.push({
      projectId: c.projectId,
      projectName: projectNames.get(c.projectId) ?? `#${c.projectId}`,
      fillPct: c.capTotal > 0 ? c.effectiveTotal / c.capTotal : 0,
      hasHeadroom: c.hasHeadroom,
    });
  }
  provisionProjects.sort((a, b) => b.fillPct - a.fillPct);

  const hasCritical =
    drives.some((d) => d.level !== "soft") ||
    provisionProjects.some((p) => !p.hasHeadroom);

  return { thresholds: { soft, hard, stop }, drives, provisionProjects, hasCritical };
}

// ---------------------------------------------------------------------------
// Error sanitation (before persisting to last_health_status / event details)
// ---------------------------------------------------------------------------

/**
 * Strip anything that looks like a Drive ID or service-account hash (20+ word
 * chars) and cap length, so Drive API errors can't leak unrelated org folder
 * IDs / SA email patterns into the activity log.
 */
export function sanitizeDriveError(err: unknown): string {
  const e = err as { code?: number | string; message?: string } | undefined;
  let msg = e?.message ?? String(err ?? "error desconocido");
  msg = msg.replace(/[\w-]{20,}/g, "[id]");
  const prefix = e?.code != null ? `[${e.code}] ` : "";
  return (prefix + msg).slice(0, 200);
}
