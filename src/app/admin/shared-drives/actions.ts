"use server";

import { db } from "@/db";
import { sharedDrives, processingJobs, type SharedDrive } from "@/db/schema";
import { asc, desc, sql } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth";
import { recordEvent } from "@/lib/system-events";
import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/types";
import { log } from "@/lib/log";
import {
  DRIVE_ID_REGEX,
  sanitizeDriveError,
  getSoftPct,
  getHardPct,
  getStopPct,
} from "@/lib/shared-drives";
import {
  getSharedDriveMetadata,
  countSharedDriveItems,
  getChangesStartPageToken,
} from "@/lib/drive-client";
import { findActiveSharedDriveReconcileJob } from "@/lib/job-locks";
import { runReconciliationJob } from "@/lib/shared-drive-reconciliation-worker";
import { JOB_TYPES } from "@/lib/job-types";

// ---------------------------------------------------------------------------
// Sortable listing (SSR URL-param pattern, mirrors /admin/activity)
// ---------------------------------------------------------------------------

const SORTABLE_COLUMNS = {
  name: sharedDrives.name,
  status: sharedDrives.status,
  reconciledCount: sharedDrives.reconciledCount,
  pendingReservationsCount: sharedDrives.pendingReservationsCount,
  itemCap: sharedDrives.itemCap,
  lastReconciledAt: sharedDrives.lastReconciledAt,
  createdAt: sharedDrives.createdAt,
} as const;

export type SortColumn = keyof typeof SORTABLE_COLUMNS;
export type SortDirection = "asc" | "desc";

export type SharedDriveRow = SharedDrive & {
  effectiveCount: number;
  fillPct: number;
};

export type ThresholdConfig = {
  soft: number;
  hard: number;
  stop: number;
};

export async function listSharedDrives(opts: {
  sortBy?: string;
  sortDir?: string;
  includeArchived?: boolean;
}): Promise<{ rows: SharedDriveRow[]; thresholds: ThresholdConfig }> {
  await requireAdmin();

  const sortBy = (opts.sortBy && opts.sortBy in SORTABLE_COLUMNS
    ? opts.sortBy
    : "reconciledCount") as SortColumn;
  const sortDir: SortDirection = opts.sortDir === "asc" ? "asc" : "desc";
  const orderFn = sortDir === "asc" ? asc : desc;
  const idTiebreak = sortDir === "asc" ? asc(sharedDrives.id) : desc(sharedDrives.id);

  const query = db.select().from(sharedDrives);
  const rows = opts.includeArchived
    ? await query.orderBy(orderFn(SORTABLE_COLUMNS[sortBy]), idTiebreak)
    : await query
        .where(sql`${sharedDrives.archivedAt} IS NULL`)
        .orderBy(orderFn(SORTABLE_COLUMNS[sortBy]), idTiebreak);

  return {
    rows: rows.map((r) => {
      const effectiveCount = r.reconciledCount + r.pendingReservationsCount;
      return {
        ...r,
        effectiveCount,
        fillPct: r.itemCap > 0 ? effectiveCount / r.itemCap : 0,
      };
    }),
    thresholds: { soft: getSoftPct(), hard: getHardPct(), stop: getStopPct() },
  };
}

// ---------------------------------------------------------------------------
// Registration (two-step: preview name, then confirm)
// ---------------------------------------------------------------------------

export type DrivePreview = {
  driveId: string;
  name: string;
  createdTime: string | null;
  alreadyRegistered: boolean;
};

/** Step 1: validate the ID + confirm the SA can see the drive and its name. */
export async function previewDrive(
  driveId: string,
): Promise<ActionResult<DrivePreview>> {
  await requireAdmin();
  const id = driveId.trim();
  if (!DRIVE_ID_REGEX.test(id)) {
    return {
      success: false,
      error: "ID de Shared Drive inválido (debe empezar con 0A).",
    };
  }

  const [existing] = await db
    .select({ id: sharedDrives.id })
    .from(sharedDrives)
    .where(sql`${sharedDrives.driveId} = ${id}`)
    .limit(1);

  try {
    const meta = await getSharedDriveMetadata(id);
    return {
      success: true,
      data: {
        driveId: id,
        name: meta.name,
        createdTime: meta.createdTime,
        alreadyRegistered: !!existing,
      },
    };
  } catch (err) {
    return {
      success: false,
      error: `No se pudo acceder al drive: ${sanitizeDriveError(err)}`,
    };
  }
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "shared-drive"
  );
}

/** Step 2: insert the row and run an initial full count to baseline it. */
export async function registerDrive(input: {
  driveId: string;
  name: string;
  rootFolderId?: string;
}): Promise<ActionResult<{ id: string }>> {
  const admin = await requireAdmin();
  const driveId = input.driveId.trim();
  if (!DRIVE_ID_REGEX.test(driveId)) {
    return { success: false, error: "ID de Shared Drive inválido." };
  }
  const name = input.name.trim() || "(sin nombre)";
  // For a fresh Shared Drive the deployment root is the drive root (== driveId).
  const rootFolderId = (input.rootFolderId?.trim() || driveId).trim();

  // Idempotency: never double-register the same Drive ID.
  const [existing] = await db
    .select({ id: sharedDrives.id })
    .from(sharedDrives)
    .where(sql`${sharedDrives.driveId} = ${driveId}`)
    .limit(1);
  if (existing) {
    return { success: true, data: { id: existing.id } };
  }

  // Unique kebab slug PK.
  const base = slugify(name);
  let id = base;
  for (let n = 2; ; n++) {
    const [clash] = await db
      .select({ id: sharedDrives.id })
      .from(sharedDrives)
      .where(sql`${sharedDrives.id} = ${id}`)
      .limit(1);
    if (!clash) break;
    id = `${base}-${n}`;
  }

  await db.insert(sharedDrives).values({
    id,
    driveId,
    rootFolderId,
    name,
    status: "registering",
  });

  // Baseline the count synchronously (a fresh drive is near-empty → fast).
  try {
    const count = await countSharedDriveItems(driveId);
    const token = await getChangesStartPageToken(driveId);
    db.run(sql`
      UPDATE shared_drives
      SET reconciled_count = ${count},
          changes_page_token = ${token},
          last_reconciled_at = datetime('now'),
          last_full_reconcile_at = datetime('now'),
          last_health_check_at = datetime('now'),
          last_health_status = 'ok',
          status = 'active',
          updated_at = datetime('now')
      WHERE id = ${id}
    `);
  } catch (err) {
    db.run(sql`
      UPDATE shared_drives
      SET status = 'unreachable',
          last_health_status = ${sanitizeDriveError(err)},
          last_health_check_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ${id}
    `);
  }

  await recordEvent({
    source: "shared-drives",
    eventType: "drive_registered",
    severity: "success",
    summary: `Shared Drive registrado: ${name}`,
    actorEmail: admin.email,
    targetType: "shared_drive",
    targetId: id,
    details: { driveId, rootFolderId },
  });
  revalidatePath("/admin/shared-drives");
  return { success: true, data: { id } };
}

// ---------------------------------------------------------------------------
// Status / lifecycle mutations
// ---------------------------------------------------------------------------

async function mutateAndEvent(
  id: string,
  set: ReturnType<typeof sql>,
  eventType: string,
  summary: string,
): Promise<ActionResult> {
  const admin = await requireAdmin();
  db.run(sql`UPDATE shared_drives SET ${set}, updated_at = datetime('now') WHERE id = ${id}`);
  await recordEvent({
    source: "shared-drives",
    eventType,
    severity: "info",
    summary,
    actorEmail: admin.email,
    targetType: "shared_drive",
    targetId: id,
  });
  revalidatePath("/admin/shared-drives");
  return { success: true, data: undefined };
}

export async function markStatus(
  id: string,
  status: "active" | "read-only",
): Promise<ActionResult> {
  return mutateAndEvent(
    id,
    sql`status = ${status}`,
    "drive_status_changed",
    `Estado de drive cambiado a ${status}: ${id}`,
  );
}

export async function archiveDrive(id: string): Promise<ActionResult> {
  return mutateAndEvent(
    id,
    sql`archived_at = datetime('now')`,
    "drive_archived",
    `Shared Drive archivado: ${id}`,
  );
}

export async function unarchiveDrive(id: string): Promise<ActionResult> {
  return mutateAndEvent(
    id,
    sql`archived_at = NULL`,
    "drive_unarchived",
    `Shared Drive desarchivado: ${id}`,
  );
}

export async function editDriveName(
  id: string,
  name: string,
): Promise<ActionResult> {
  const clean = name.trim();
  if (!clean) return { success: false, error: "El nombre no puede estar vacío." };
  return mutateAndEvent(
    id,
    sql`name = ${clean}`,
    "drive_renamed",
    `Shared Drive renombrado: ${id} → ${clean}`,
  );
}

// ---------------------------------------------------------------------------
// Reconcile now (admin-triggered, single-flight)
// ---------------------------------------------------------------------------

export async function reconcileNow(): Promise<ActionResult> {
  const admin = await requireAdmin();

  const active = await findActiveSharedDriveReconcileJob();
  if (active && active.status === "processing") {
    return {
      success: false,
      error: "Ya hay una reconciliación en curso.",
    };
  }

  let jobId: number;
  if (active) {
    jobId = active.id;
  } else {
    const [job] = db
      .insert(processingJobs)
      .values({
        jobType: JOB_TYPES.SHARED_DRIVES_RECONCILE,
        deploymentId: null,
        cameraTrapProjectId: null,
        status: "pending",
        totalImages: 0,
        processedImages: 0,
        failedImages: 0,
        statusMessage: "En cola (reconciliación manual)...",
        createdBy: admin.email,
      })
      .returning()
      .all();
    jobId = job.id;
  }

  // Fire-and-forget: the job row tracks progress; the page shows it.
  runReconciliationJob(jobId).catch((err) =>
    log.error({ err, jobId }, "[shared-drives] manual reconcile failed"),
  );

  revalidatePath("/admin/shared-drives");
  return { success: true, data: undefined };
}
