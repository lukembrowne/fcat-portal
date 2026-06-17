/**
 * BioChoco monthly data-quality review — data gathering (auth-agnostic).
 *
 * Composes the SAME primitives that power `/biochoco/data` and the nightly
 * refresh cron — `loadSchedule`, ODK submissions, the Drive re-count, and the
 * DB tables — into one merged, review-ready snapshot. It deliberately imports
 * NO auth (`requirePermission`) or React/Next server-only modules, so it can be
 * called from a plain `tsx` script (see scripts/biochoco-review-snapshot.ts) as
 * well as from a server action.
 *
 * Plan: docs/plans/2026-06-16-feat-biochoco-data-quality-review-skill-plan.md
 */

import { db } from "@/db";
import { deployments, images, ibuttonUploads, processingJobs } from "@/db/schema";
import { eq, isNotNull, inArray, sql } from "drizzle-orm";
import { loadSchedule } from "@/lib/sheets-client";
import { fetchSubmissions } from "@/lib/odk-client";
import {
  BIOCHOCO_PROJECT_ID,
  BIOCHOCO_FORM_DEPLOY,
  BIOCHOCO_FORM_RETRIEVE,
} from "@/lib/odk-constants";
import { checkDeploymentUploads } from "@/lib/drive-client";
import { computeCoverage } from "@/app/biochoco/ibutton/coverage";
import { computeWindowQc } from "@/lib/deployment-window-qc";
import { log } from "@/lib/log";
import {
  runChecks,
  summarizeFindings,
  type DataType,
  type ReviewDeployment,
  type ReviewFinding,
} from "@/lib/biochoco-review-checks";

/** Strip TZ offset / millis from an ODK time: "09:20:00.000-05:00" → "09:20:00".
 *  Mirrors `cleanOdkTime` in odk-deployment-window.ts — keep field paths in sync. */
function cleanOdkTime(raw: string): string {
  return raw.replace(/\.\d{3}.*$/, "");
}

interface OdkLifecycle {
  deployedSet: Set<string>;
  retrievedSet: Set<string>;
  deployDateMap: Map<string, string>; // YYYY-MM-DD
  retrieveDateMap: Map<string, string>;
  deployDateTimeMap: Map<string, string>; // YYYY-MM-DD HH:mm:ss (local Ecuador)
  retrieveDateTimeMap: Map<string, string>;
}

/**
 * Extract deploy/retrieve lifecycle + dates from ODK submissions, honoring the
 * Feb-2026 form restructuring fallback chains (see docs/solutions). Lifecycle is
 * keyed on submission *presence* (a submission with no date still counts as
 * deployed/retrieved); datetime maps are used for window/coverage QC.
 */
async function loadOdkLifecycle(): Promise<OdkLifecycle> {
  const [rawDeploys, rawRetrieves] = await Promise.all([
    fetchSubmissions<Record<string, unknown>>(BIOCHOCO_PROJECT_ID, BIOCHOCO_FORM_DEPLOY),
    fetchSubmissions<Record<string, unknown>>(BIOCHOCO_PROJECT_ID, BIOCHOCO_FORM_RETRIEVE),
  ]);

  const lc: OdkLifecycle = {
    deployedSet: new Set(),
    retrievedSet: new Set(),
    deployDateMap: new Map(),
    retrieveDateMap: new Map(),
    deployDateTimeMap: new Map(),
    retrieveDateTimeMap: new Map(),
  };

  for (const sub of rawDeploys) {
    const sel = sub.site_selection as Record<string, unknown> | undefined;
    const info = sub.deployment_info as Record<string, unknown> | undefined;
    const depId = (sel?.deployment_id as string) ?? (sub.deployment_id as string) ?? "";
    if (!depId) continue;
    lc.deployedSet.add(depId);
    const date =
      (info?.deploy_date as string) ??
      (sel?.fecha_instalacion as string) ??
      (sub.fecha_instalacion as string) ??
      "";
    if (!date) continue;
    const dateStr = date.slice(0, 10);
    lc.deployDateMap.set(depId, dateStr);
    const time = (info?.deploy_time as string) ?? "";
    lc.deployDateTimeMap.set(depId, `${dateStr} ${time ? cleanOdkTime(time) : "00:00:00"}`);
  }

  for (const sub of rawRetrieves) {
    const sel = sub.site_selection as Record<string, unknown> | undefined;
    const info = sub.retrieval_info as Record<string, unknown> | undefined;
    const depId = (sel?.deployment_id as string) ?? (sub.deployment_id as string) ?? "";
    if (!depId) continue;
    lc.retrievedSet.add(depId);
    const date =
      (info?.retrieval_date as string) ??
      (sel?.fecha_recuperacion as string) ??
      (sub.fecha_recuperacion as string) ??
      "";
    if (!date) continue;
    const dateStr = date.slice(0, 10);
    lc.retrieveDateMap.set(depId, dateStr);
    const time = (info?.retrieval_time as string) ?? "";
    lc.retrieveDateTimeMap.set(depId, `${dateStr} ${time ? cleanOdkTime(time) : "23:59:59"}`);
  }

  return lc;
}

export interface RecountResult {
  deploymentName: string;
  ok: boolean;
  error?: string;
}

/**
 * Force a live Google Drive re-count for every deployment that has a Drive
 * folder, persisting fresh counts/sizes/newest-dates/subfolder-IDs to the DB —
 * the same write the "Actualizar Conteo" button performs, but for all rows.
 * Per-deployment failures are collected, never thrown, so one bad folder can't
 * abort the monthly run.
 */
export async function recountAllUploads(
  onProgress?: (done: number, total: number, name: string) => void
): Promise<RecountResult[]> {
  const rows = await db
    .select({ name: deployments.name, driveFolderId: deployments.driveFolderId })
    .from(deployments)
    .where(isNotNull(deployments.driveFolderId));

  const CONCURRENCY = 10;
  const results: RecountResult[] = [];
  let done = 0;

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      batch.map(async (r): Promise<RecountResult> => {
        const folderId = r.driveFolderId;
        if (!folderId) return { deploymentName: r.name, ok: false, error: "Sin carpeta de Drive" };
        const result = await checkDeploymentUploads(folderId);
        if (!result.success) return { deploymentName: r.name, ok: false, error: result.error };
        const u = result.data;
        await db
          .update(deployments)
          .set({
            uploadCameraCount: u.camarasTrampas,
            uploadAudioCount: u.grabadoresDeAudio,
            uploadIbuttonCount: u.ibutton,
            uploadCameraSizeBytes: u.camarasTrampasSizeBytes,
            uploadAudioSizeBytes: u.grabadoresDeAudioSizeBytes,
            uploadIbuttonSizeBytes: u.ibuttonSizeBytes,
            uploadNewestCameraDate: u.camarasTrampasNewestDate,
            uploadNewestAudioDate: u.grabadoresDeAudioNewestDate,
            uploadNewestIbuttonDate: u.ibuttonNewestDate,
            uploadCameraFolderId: u.subfolderIds.camarasTrampas,
            uploadAudioFolderId: u.subfolderIds.grabadoresDeAudio,
            uploadIbuttonFolderId: u.subfolderIds.ibutton,
            uploadCountsCheckedAt: sql`(unixepoch())`,
          })
          .where(eq(deployments.name, r.name));
        return { deploymentName: r.name, ok: true };
      })
    );
    for (let j = 0; j < settled.length; j++) {
      const s = settled[j];
      const res =
        s.status === "fulfilled"
          ? s.value
          : { deploymentName: batch[j].name, ok: false, error: "Error inesperado en recuento" };
      results.push(res);
      done++;
      onProgress?.(done, rows.length, batch[j].name);
    }
  }

  return results;
}

/**
 * Build the merged, review-ready snapshot of every BioChoco deployment that has
 * a Drive folder. Reads cached upload counts from the DB — call
 * `recountAllUploads()` first for live ground truth. Pass its errors as
 * `recountErrors` so re-count failures surface as a finding (check #6).
 */
export async function gatherDeploymentReviewData(
  recountErrors?: Map<string, string>
): Promise<ReviewDeployment[]> {
  const [schedule, lc, dbRows] = await Promise.all([
    loadSchedule(),
    loadOdkLifecycle(),
    db
      .select({
        id: deployments.id,
        name: deployments.name,
        siteName: deployments.siteName,
        latitude: deployments.latitude,
        longitude: deployments.longitude,
        excluded: deployments.excluded,
        status: deployments.status,
        driveFolderId: deployments.driveFolderId,
        fieldNotes: deployments.fieldNotes,
        uploadCameraCount: deployments.uploadCameraCount,
        uploadAudioCount: deployments.uploadAudioCount,
        uploadIbuttonCount: deployments.uploadIbuttonCount,
        uploadCameraFolderId: deployments.uploadCameraFolderId,
        uploadAudioFolderId: deployments.uploadAudioFolderId,
        uploadIbuttonFolderId: deployments.uploadIbuttonFolderId,
        uploadCountsCheckedAt: deployments.uploadCountsCheckedAt,
        uploadNewestCameraDate: deployments.uploadNewestCameraDate,
        uploadNewestAudioDate: deployments.uploadNewestAudioDate,
        uploadNewestIbuttonDate: deployments.uploadNewestIbuttonDate,
      })
      .from(deployments)
      .where(isNotNull(deployments.driveFolderId)),
  ]);

  const dbByName = new Map(dbRows.map((r) => [r.name, r]));
  const depIds = dbRows.map((r) => r.id);

  // Processing health aggregated per deployment.
  const procByDep = new Map<number, { failedJobs: number; failedImages: number }>();
  if (depIds.length) {
    const procRows = await db
      .select({
        depId: processingJobs.deploymentId,
        failedJobs: sql<number>`sum(case when ${processingJobs.status} = 'failed' then 1 else 0 end)`,
        failedImages: sql<number>`coalesce(sum(${processingJobs.failedImages}), 0)`,
      })
      .from(processingJobs)
      .where(inArray(processingJobs.deploymentId, depIds))
      .groupBy(processingJobs.deploymentId);
    for (const r of procRows) {
      if (r.depId != null)
        procByDep.set(r.depId, {
          failedJobs: Number(r.failedJobs) || 0,
          failedImages: Number(r.failedImages) || 0,
        });
    }
  }

  // iButton upload rows (one per deployment) for coverage.
  const ibuttonByDep = new Map<
    number,
    { rowsImported: number; sampleRate: string | null; dateRangeStart: string | null; dateRangeEnd: string | null }
  >();
  if (depIds.length) {
    const ibRows = await db
      .select({
        depId: ibuttonUploads.deploymentId,
        rowsImported: ibuttonUploads.rowsImported,
        sampleRate: ibuttonUploads.sampleRate,
        dateRangeStart: ibuttonUploads.dateRangeStart,
        dateRangeEnd: ibuttonUploads.dateRangeEnd,
      })
      .from(ibuttonUploads)
      .where(inArray(ibuttonUploads.deploymentId, depIds));
    for (const r of ibRows) {
      if (r.depId != null) ibuttonByDep.set(r.depId, r);
    }
  }

  const out: ReviewDeployment[] = [];

  for (const row of schedule) {
    const dbRow = dbByName.get(row.deploymentId);
    if (!dbRow) continue; // only deployments with a real Drive folder

    const lifecycle = lc.retrievedSet.has(row.deploymentId)
      ? "retrieved"
      : lc.deployedSet.has(row.deploymentId)
        ? "deployed"
        : "scheduled";

    const expectedTypes: DataType[] = [];
    if (dbRow.uploadCameraFolderId) expectedTypes.push("camera");
    if (dbRow.uploadAudioFolderId) expectedTypes.push("audio");
    if (dbRow.uploadIbuttonFolderId) expectedTypes.push("ibutton");
    const expectedTypesSource = expectedTypes.length > 0 ? "folders" : "fallback-all";
    const effectiveExpected: DataType[] =
      expectedTypes.length > 0 ? expectedTypes : ["camera", "audio", "ibutton"];

    const odkDeployAt = lc.deployDateTimeMap.get(row.deploymentId) ?? null;
    const odkRetrieveAt = lc.retrieveDateTimeMap.get(row.deploymentId) ?? null;

    // Camera image window QC (best-effort; null on failure).
    let cameraOutOfWindow = false;
    let cameraFilesOutsideWindow: number | null = null;
    if (odkDeployAt && odkRetrieveAt && (dbRow.uploadCameraCount ?? 0) > 0) {
      try {
        const [stats] = await db
          .select({
            min: sql<string | null>`min(${images.exifTimestamp})`,
            max: sql<string | null>`max(${images.exifTimestamp})`,
            total: sql<number>`count(${images.exifTimestamp})`,
            outside: sql<number>`coalesce(sum(case when ${images.exifTimestamp} < ${odkDeployAt} or ${images.exifTimestamp} > ${odkRetrieveAt} then 1 else 0 end), 0)`,
          })
          .from(images)
          .where(eq(images.deploymentId, dbRow.id));
        if (stats && Number(stats.total) > 0) {
          const qc = computeWindowQc({
            odkDeployAt,
            odkRetrieveAt,
            firstFileAt: stats.min,
            lastFileAt: stats.max,
            totalFiles: Number(stats.total),
            outsideCount: Number(stats.outside),
          });
          cameraOutOfWindow = qc.hasOutOfWindow;
          cameraFilesOutsideWindow = Number(stats.outside);
        }
      } catch (err) {
        log.warn({ err, deploymentId: row.deploymentId }, "window QC failed");
      }
    }

    // iButton coverage (best-effort; null when window/rate unknown).
    let ibuttonCoveragePct: number | null = null;
    let ibuttonRowsImported: number | null = null;
    const ib = ibuttonByDep.get(dbRow.id);
    if (ib) {
      ibuttonRowsImported = ib.rowsImported;
      try {
        const cov = computeCoverage({
          odkDeployAt,
          odkRetrieveAt,
          sampleRate: ib.sampleRate,
          rowsImported: ib.rowsImported,
          dateRangeStart: ib.dateRangeStart,
          dateRangeEnd: ib.dateRangeEnd,
        });
        ibuttonCoveragePct = cov.coveragePct;
      } catch (err) {
        log.warn({ err, deploymentId: row.deploymentId }, "iButton coverage failed");
      }
    }

    const proc = procByDep.get(dbRow.id);

    out.push({
      deploymentId: row.deploymentId,
      siteId: row.siteId,
      siteName: dbRow.siteName ?? row.siteName ?? null,
      habitat: row.habitatType,
      season: row.season,
      lifecycle,
      excluded: dbRow.excluded,
      plannedDeployDate: row.plannedDeployDate,
      plannedRetrieveDate: row.plannedRetrieveDate,
      actualDeployDate: lc.deployDateMap.get(row.deploymentId) ?? row.actualDeployDate,
      actualRetrieveDate: lc.retrieveDateMap.get(row.deploymentId) ?? row.actualRetrieveDate,
      latitude: dbRow.latitude,
      longitude: dbRow.longitude,
      expectedTypes: effectiveExpected,
      expectedTypesSource,
      counts: {
        camera: dbRow.uploadCameraCount,
        audio: dbRow.uploadAudioCount,
        ibutton: dbRow.uploadIbuttonCount,
      },
      countsCheckedAt: dbRow.uploadCountsCheckedAt
        ? Math.floor(dbRow.uploadCountsCheckedAt.getTime() / 1000)
        : null,
      recountError: recountErrors?.get(row.deploymentId) ?? null,
      newestUploadDate:
        [dbRow.uploadNewestCameraDate, dbRow.uploadNewestAudioDate, dbRow.uploadNewestIbuttonDate]
          .filter(Boolean)
          .sort()
          .pop() ?? null,
      processingStatus: dbRow.status,
      failedJobs: proc?.failedJobs ?? 0,
      failedImages: proc?.failedImages ?? 0,
      ibuttonRowsImported,
      ibuttonCoveragePct,
      cameraOutOfWindow,
      cameraFilesOutsideWindow,
      fieldNotes: dbRow.fieldNotes,
    });
  }

  return out;
}

export interface ReviewSnapshot {
  generatedAt: string;
  today: string;
  recountPerformed: boolean;
  totals: {
    deployments: number;
    excluded: number;
    scheduled: number;
    deployed: number;
    retrieved: number;
    withFindings: number;
    driveRecountFailures: number;
  };
  summary: ReturnType<typeof summarizeFindings>;
  findings: ReviewFinding[];
  deployments: ReviewDeployment[];
  driveErrors: { deploymentId: string; error: string }[];
}

/**
 * End-to-end snapshot: optionally force a live Drive re-count, gather the merged
 * data, run the checks, and assemble the result object. Shared by the API route
 * (`/api/cron/biochoco-review`) and the local script so both emit identical JSON.
 *
 * In production the nightly refresh cron keeps Drive counts ~24h fresh, so the
 * monthly review can run with `recount: false` and still be accurate.
 */
export async function buildReviewSnapshot(opts: {
  today: string;
  recount: boolean;
  onRecountProgress?: (done: number, total: number, name: string) => void;
}): Promise<ReviewSnapshot> {
  const recountErrors = new Map<string, string>();
  if (opts.recount) {
    const results = await recountAllUploads(opts.onRecountProgress);
    for (const r of results) if (!r.ok && r.error) recountErrors.set(r.deploymentName, r.error);
  }

  const deployments = await gatherDeploymentReviewData(recountErrors);
  const findings = runChecks(deployments, { today: opts.today });
  const summary = summarizeFindings(findings);

  return {
    generatedAt: new Date().toISOString(),
    today: opts.today,
    recountPerformed: opts.recount,
    totals: {
      deployments: deployments.length,
      excluded: deployments.filter((d) => d.excluded).length,
      scheduled: deployments.filter((d) => d.lifecycle === "scheduled").length,
      deployed: deployments.filter((d) => d.lifecycle === "deployed").length,
      retrieved: deployments.filter((d) => d.lifecycle === "retrieved").length,
      withFindings: new Set(findings.map((f) => f.deploymentId)).size,
      driveRecountFailures: recountErrors.size,
    },
    summary,
    findings,
    deployments,
    driveErrors: [...recountErrors.entries()].map(([deploymentId, error]) => ({
      deploymentId,
      error,
    })),
  };
}

/** Today's calendar date in Ecuador local time (UTC-5), "YYYY-MM-DD". */
export function ecuadorToday(): string {
  return new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}
