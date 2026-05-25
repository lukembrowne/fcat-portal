/**
 * Nightly BioChoco Data Refresh & Email Report
 *
 * Called by cron via curl. Refreshes Google Drive file counts and sizes
 * for all BioChoco deployments, saves a daily snapshot, computes deltas
 * from the previous snapshot, and sends a summary email via Resend.
 *
 * Auth: Bearer token from CRON_SECRET env var (not user auth).
 */

import { db } from "@/db";
import {
  deployments,
  processingJobs,
  uploadCountSnapshots,
  audioFiles,
  audioDetections,
  audioIdentifications,
} from "@/db/schema";
import type { UploadStatus } from "@/lib/drive-client";
import { verifyCronSecret } from "@/lib/cron-auth";
import { and, inArray, isNotNull, eq, gte, sql, count } from "drizzle-orm";
import { Resend } from "resend";
import { log } from "@/lib/log";
import { recordEvent } from "@/lib/system-events";
import {
  formatBytes,
  formatCountCell,
  formatDeltaHtml,
  formatNewSince,
} from "@/lib/email/format";
import {
  awaitJobTerminal,
  runDriveSyncWorker,
} from "@/lib/camera-trap-sync-worker";
import { processNextQueueable } from "@/lib/job-queue";
import { JOB_TYPES } from "@/lib/job-types";

export const dynamic = "force-dynamic";

// Budgets carved out of the cron --max-time 600s wall: CT first, then audio,
// with ~60s of slack left for snapshot + email. If either phase consistently
// runs hot, raise the matching constant AND --max-time in scripts/crontab
// together (the cron will SIGTERM before our timeout fires otherwise).
const CT_SYNC_TIMEOUT_MS = 420_000; // 7 min
const AUDIO_SYNC_TIMEOUT_MS = 120_000; // 2 min
const POLL_INTERVAL_MS = 5_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DeploymentResult {
  id: number;
  name: string;
  siteName: string | null;
  uploads: UploadStatus | null;
  previousCameraCount: number | null;
  previousAudioCount: number | null;
  previousIbuttonCount: number | null;
  previousCheckedAt: Date | null;
  error: string | null;
}

interface SnapshotData {
  totalCameras: number;
  totalAudio: number;
  totalIbutton: number;
  totalCameraSizeBytes: number;
  totalAudioSizeBytes: number;
  totalIbuttonSizeBytes: number;
  deploymentsWithUploads: number;
  totalDeployments: number;
}

interface SnapshotDelta extends SnapshotData {
  deltaCameras: number | null;
  deltaAudio: number | null;
  deltaIbutton: number | null;
  deltaCameraSizeBytes: number | null;
  deltaAudioSizeBytes: number | null;
  deltaIbuttonSizeBytes: number | null;
  previousSnapshotDate: string | null;
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  if (!verifyCronSecret(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const startTime = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    log.info({ today }, "[nightly] Starting BioChoco data refresh");

    // Step 1: snapshot prior upload counts per deployment. These become the
    // "previous_*" values for tonight's email delta after the worker runs.
    const priorRows = db
      .select({
        id: deployments.id,
        priorCameraCount: deployments.uploadCameraCount,
        priorAudioCount: deployments.uploadAudioCount,
        priorIbuttonCount: deployments.uploadIbuttonCount,
        priorCheckedAt: deployments.uploadCountsCheckedAt,
      })
      .from(deployments)
      .where(isNotNull(deployments.driveFolderId))
      .all();
    const priorMap = new Map(priorRows.map((r) => [r.id, r]));
    log.info(
      { count: priorRows.length },
      "[nightly] Snapshot of prior counts captured"
    );

    // Step 2: run the same drive_sync worker the manual button uses.
    // The cron does NOT use enqueueDriveSyncJob (which schedules via after())
    // because we need to block here until completion to compute the email.
    // Single-flight is enforced by reusing any in-flight job we find.
    const [inflight] = db
      .select({ id: processingJobs.id, status: processingJobs.status })
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.jobType, "drive_sync"),
          inArray(processingJobs.status, ["pending", "processing"]),
        ),
      )
      .all();

    let jobId: number;
    if (inflight) {
      jobId = inflight.id;
      log.info(
        { jobId, status: inflight.status },
        "[nightly] Reusing in-flight drive_sync job",
      );
      // If it's pending (queued but worker never started, e.g. after a crash),
      // kick the worker now. If it's already processing, just wait.
      if (inflight.status === "pending") {
        runDriveSyncWorker(jobId).catch((err) =>
          log.error({ err, jobId }, "[nightly] worker rejected"),
        );
      }
    } else {
      const [job] = db
        .insert(processingJobs)
        .values({
          jobType: "drive_sync",
          deploymentId: null,
          cameraTrapProjectId: null,
          status: "pending",
          totalImages: 0,
          processedImages: 0,
          failedImages: 0,
          statusMessage: "En cola (nightly)...",
          createdBy: "cron@nightly",
        })
        .returning()
        .all();
      jobId = job.id;
      log.info({ jobId }, "[nightly] Enqueued drive_sync job");
      runDriveSyncWorker(jobId).catch((err) =>
        log.error({ err, jobId }, "[nightly] worker rejected"),
      );
    }

    const terminal = await awaitJobTerminal(jobId, {
      intervalMs: POLL_INTERVAL_MS,
      timeoutMs: CT_SYNC_TIMEOUT_MS,
    });

    if (!terminal) {
      log.error({ jobId }, "[nightly] Worker did not finish within timeout");
      await recordEvent({
        source: "cron",
        eventType: "cron_nightly_refresh",
        severity: "error",
        actorEmail: null,
        summary: `Tiempo de espera agotado para drive_sync (job ${jobId})`,
        durationMs: Date.now() - startTime,
        details: { jobId, reason: "drive_sync_timeout", timeoutMs: CT_SYNC_TIMEOUT_MS },
      });
      return Response.json(
        {
          error: "drive_sync timeout",
          jobId,
          elapsed: `${((Date.now() - startTime) / 1000).toFixed(1)}s`,
        },
        { status: 504 },
      );
    }
    log.info(
      {
        jobId,
        status: terminal.status,
        processed: terminal.processedImages,
        failed: terminal.failedImages,
      },
      "[nightly] drive_sync terminal",
    );

    // Step 2b: run audio_sync sequentially after CT. We don't fail the whole
    // cron if audio sync misbehaves — log it and keep going so the email
    // still ships with whatever data we have. Single-flight: reuse an
    // in-flight audio_sync job if one exists.
    const audioTerminal = await runNightlyAudioSync();
    if (audioTerminal) {
      log.info(
        {
          status: audioTerminal.status,
          processed: audioTerminal.processedImages,
          failed: audioTerminal.failedImages,
        },
        "[nightly] audio_sync terminal",
      );
    }

    // Step 3: promote previous_* columns from the prior snapshot for any row
    // we observed before the worker ran. New rows created during sync are
    // skipped (they have no prior to promote).
    for (const [depId, prior] of priorMap) {
      db.update(deployments)
        .set({
          previousCameraCount: prior.priorCameraCount,
          previousAudioCount: prior.priorAudioCount,
          previousIbuttonCount: prior.priorIbuttonCount,
          previousCountsCheckedAt: prior.priorCheckedAt,
        })
        .where(eq(deployments.id, depId))
        .run();
    }

    // Step 4: read the post-sync state. Includes any newly-discovered rows
    // since the worker may have inserted deployments.
    const postSyncRows = db
      .select({
        id: deployments.id,
        name: deployments.name,
        siteName: deployments.siteName,
        uploadCameraCount: deployments.uploadCameraCount,
        uploadAudioCount: deployments.uploadAudioCount,
        uploadIbuttonCount: deployments.uploadIbuttonCount,
        uploadCameraSizeBytes: deployments.uploadCameraSizeBytes,
        uploadAudioSizeBytes: deployments.uploadAudioSizeBytes,
        uploadIbuttonSizeBytes: deployments.uploadIbuttonSizeBytes,
        uploadNewestCameraDate: deployments.uploadNewestCameraDate,
        uploadNewestAudioDate: deployments.uploadNewestAudioDate,
        uploadNewestIbuttonDate: deployments.uploadNewestIbuttonDate,
        subfolderCamera: deployments.uploadCameraFolderId,
        subfolderAudio: deployments.uploadAudioFolderId,
        subfolderIbutton: deployments.uploadIbuttonFolderId,
      })
      .from(deployments)
      .where(isNotNull(deployments.driveFolderId))
      .all();

    const results: DeploymentResult[] = postSyncRows.map((r) => {
      const prior = priorMap.get(r.id);
      const uploads: UploadStatus = {
        camarasTrampas: r.uploadCameraCount,
        grabadoresDeAudio: r.uploadAudioCount,
        ibutton: r.uploadIbuttonCount,
        camarasTrampasSizeBytes: r.uploadCameraSizeBytes,
        grabadoresDeAudioSizeBytes: r.uploadAudioSizeBytes,
        ibuttonSizeBytes: r.uploadIbuttonSizeBytes,
        camarasTrampasNewestDate: r.uploadNewestCameraDate,
        grabadoresDeAudioNewestDate: r.uploadNewestAudioDate,
        ibuttonNewestDate: r.uploadNewestIbuttonDate,
        subfolderIds: {
          camarasTrampas: r.subfolderCamera,
          grabadoresDeAudio: r.subfolderAudio,
          ibutton: r.subfolderIbutton,
        },
      };
      return {
        id: r.id,
        name: r.name,
        siteName: r.siteName,
        uploads,
        previousCameraCount: prior?.priorCameraCount ?? null,
        previousAudioCount: prior?.priorAudioCount ?? null,
        previousIbuttonCount: prior?.priorIbuttonCount ?? null,
        previousCheckedAt: prior?.priorCheckedAt ?? null,
        error: null,
      };
    });

    if (terminal.status !== "completed") {
      log.warn(
        { jobId, status: terminal.status, errorMessage: terminal.errorMessage },
        "[nightly] drive_sync did not complete cleanly — email will still send",
      );
    }

    // Step 5: Save daily snapshot
    const snapshot = computeSnapshot(results, results.length);

    db.insert(uploadCountSnapshots)
      .values({
        date: today,
        totalCameras: snapshot.totalCameras,
        totalAudio: snapshot.totalAudio,
        totalIbutton: snapshot.totalIbutton,
        totalCameraSizeBytes: snapshot.totalCameraSizeBytes,
        totalAudioSizeBytes: snapshot.totalAudioSizeBytes,
        totalIbuttonSizeBytes: snapshot.totalIbuttonSizeBytes,
        deploymentsWithUploads: snapshot.deploymentsWithUploads,
        totalDeployments: snapshot.totalDeployments,
      })
      .onConflictDoUpdate({
        target: uploadCountSnapshots.date,
        set: {
          totalCameras: snapshot.totalCameras,
          totalAudio: snapshot.totalAudio,
          totalIbutton: snapshot.totalIbutton,
          totalCameraSizeBytes: snapshot.totalCameraSizeBytes,
          totalAudioSizeBytes: snapshot.totalAudioSizeBytes,
          totalIbuttonSizeBytes: snapshot.totalIbuttonSizeBytes,
          deploymentsWithUploads: snapshot.deploymentsWithUploads,
          totalDeployments: snapshot.totalDeployments,
          createdAt: sql`(unixepoch())`,
        },
      })
      .run();

    log.info("[nightly] Snapshot saved");

    // Step 4: Compute deltas from previous snapshot
    const prevRows = db
      .select()
      .from(uploadCountSnapshots)
      .where(sql`${uploadCountSnapshots.date} < ${today}`)
      .orderBy(sql`${uploadCountSnapshots.date} DESC`)
      .limit(1)
      .all();

    const prev = prevRows[0] ?? null;
    const delta: SnapshotDelta = {
      ...snapshot,
      deltaCameras: prev ? snapshot.totalCameras - prev.totalCameras : null,
      deltaAudio: prev ? snapshot.totalAudio - prev.totalAudio : null,
      deltaIbutton: prev ? snapshot.totalIbutton - prev.totalIbutton : null,
      deltaCameraSizeBytes: prev ? snapshot.totalCameraSizeBytes - prev.totalCameraSizeBytes : null,
      deltaAudioSizeBytes: prev ? snapshot.totalAudioSizeBytes - prev.totalAudioSizeBytes : null,
      deltaIbuttonSizeBytes: prev ? snapshot.totalIbuttonSizeBytes - prev.totalIbuttonSizeBytes : null,
      previousSnapshotDate: prev ? prev.date : null,
    };

    // Step 4b: gather audio stats (BirdNET index totals + today's deltas).
    // Uses createdAt on the audio tables so we don't need a separate snapshot
    // table — the totals grow monotonically in practice.
    const audioReport = await collectAudioReport(prev?.date ?? null);

    // Step 5: Send email
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const NIGHTLY_REPORT_EMAILS = process.env.NIGHTLY_REPORT_EMAILS;

    if (RESEND_API_KEY && NIGHTLY_REPORT_EMAILS) {
      await sendReport(
        RESEND_API_KEY,
        NIGHTLY_REPORT_EMAILS,
        today,
        results,
        delta,
        audioReport,
      );
    } else {
      log.warn("[nightly] Email skipped — RESEND_API_KEY or NIGHTLY_REPORT_EMAILS not set");
    }

    const errorCount = terminal.failedImages;
    const elapsedMs = Date.now() - startTime;
    const elapsed = (elapsedMs / 1000).toFixed(1);
    const totalSize = snapshot.totalCameraSizeBytes + snapshot.totalAudioSizeBytes + snapshot.totalIbuttonSizeBytes;
    log.info(
      {
        jobId,
        elapsedSec: elapsed,
        deployments: results.length,
        errors: errorCount,
        totalSize: formatBytes(totalSize),
      },
      "[nightly] Done",
    );

    const ok = terminal.status === "completed" && errorCount === 0;
    await recordEvent({
      source: "cron",
      eventType: "cron_nightly_refresh",
      severity: ok ? "success" : "warn",
      actorEmail: null,
      summary: ok
        ? `Refresco nocturno completado · ${results.length} instalaciones · ${formatBytes(totalSize)}`
        : `Refresco nocturno con problemas · ${errorCount} fallo${errorCount === 1 ? "" : "s"} de ${results.length} instalaciones`,
      durationMs: elapsedMs,
      details: {
        jobId,
        driveSyncStatus: terminal.status,
        deployments: results.length,
        errors: errorCount,
        totalCameras: snapshot.totalCameras,
        totalAudio: snapshot.totalAudio,
        totalIbutton: snapshot.totalIbutton,
        totalSizeBytes: totalSize,
      },
    });

    return Response.json({
      ok: terminal.status === "completed",
      jobId,
      jobStatus: terminal.status,
      deployments: results.length,
      errors: errorCount,
      totalSize: formatBytes(totalSize),
      elapsed: `${elapsed}s`,
    });
  } catch (err) {
    log.error({ err }, "[nightly] Fatal error");
    await recordEvent({
      source: "cron",
      eventType: "cron_nightly_refresh",
      severity: "error",
      actorEmail: null,
      summary: `Refresco nocturno falló: ${err instanceof Error ? err.message : "error desconocido"}`,
      details: { error: err instanceof Error ? err.message : String(err) },
    });
    return Response.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
}

// ---------------------------------------------------------------------------
// Audio sync (run after CT) + report
// ---------------------------------------------------------------------------

interface NightlyJobTerminal {
  status: string;
  processedImages: number;
  failedImages: number;
}

/**
 * Run an audio_sync job for the nightly cron. Mirrors the CT pattern in the
 * main handler: reuse an in-flight job if one exists, otherwise insert + kick
 * the worker inline (not via `after()`, which only runs once the response is
 * sent — we need it to run now so we can await terminal).
 *
 * Never throws — returns null on timeout/error so the cron can still send
 * whatever email data it has.
 */
async function runNightlyAudioSync(): Promise<NightlyJobTerminal | null> {
  try {
    const [inflight] = db
      .select({ id: processingJobs.id, status: processingJobs.status })
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.jobType, JOB_TYPES.AUDIO_SYNC),
          inArray(processingJobs.status, ["pending", "processing"]),
        ),
      )
      .all();

    let jobId: number;
    if (inflight) {
      jobId = inflight.id;
      log.info(
        { jobId, status: inflight.status },
        "[nightly] Reusing in-flight audio_sync job",
      );
      if (inflight.status === "pending") {
        processNextQueueable().catch((err) =>
          log.error({ err, jobId }, "[nightly] queue advance failed"),
        );
      }
    } else {
      const [job] = db
        .insert(processingJobs)
        .values({
          jobType: JOB_TYPES.AUDIO_SYNC,
          deploymentId: null,
          cameraTrapProjectId: null,
          status: "pending",
          totalImages: 0,
          processedImages: 0,
          failedImages: 0,
          statusMessage: "En cola (nightly)...",
          createdBy: "cron@nightly",
        })
        .returning()
        .all();
      jobId = job.id;
      log.info({ jobId }, "[nightly] Enqueued audio_sync job");
      processNextQueueable().catch((err) =>
        log.error({ err, jobId }, "[nightly] queue advance failed"),
      );
    }

    const terminal = await awaitJobTerminal(jobId, {
      intervalMs: POLL_INTERVAL_MS,
      timeoutMs: AUDIO_SYNC_TIMEOUT_MS,
    });

    if (!terminal) {
      log.error({ jobId }, "[nightly] audio_sync did not finish within timeout");
      return null;
    }
    return terminal;
  } catch (err) {
    log.error({ err }, "[nightly] audio_sync failed");
    return null;
  }
}

export interface AudioReport {
  /** Total indexed audio files across all deployments. */
  totalFiles: number;
  /** Total BirdNET detections (rows in audio_detections). */
  totalDetections: number;
  /** Distinct species across all audio_identifications. */
  totalSpecies: number;
  /** Deployments that have at least one indexed audio file. */
  deploymentsWithAudio: number;
  /** Audio files indexed since the previous nightly snapshot. */
  newFilesSincePrev: number | null;
  /** BirdNET detections created since the previous nightly snapshot. */
  newDetectionsSincePrev: number | null;
  /** BirdNET jobs that completed since the previous nightly snapshot. */
  birdnetJobsCompletedSincePrev: number | null;
  /** Previous snapshot date used to compute the "since" deltas. */
  previousSnapshotDate: string | null;
}

/**
 * Read audio totals + "new since previous snapshot" deltas. We piggy-back on
 * the `previousSnapshotDate` from `uploadCountSnapshots` so the audio block
 * shares the same comparison window as the CT block.
 */
async function collectAudioReport(
  previousSnapshotDate: string | null,
): Promise<AudioReport> {
  const [files] = await db.select({ n: count() }).from(audioFiles);
  const [detections] = await db.select({ n: count() }).from(audioDetections);
  const [species] = await db
    .select({ n: sql<number>`COUNT(DISTINCT ${audioIdentifications.species})` })
    .from(audioIdentifications);
  const [deps] = await db
    .select({
      n: sql<number>`COUNT(DISTINCT ${audioFiles.deploymentId})`,
    })
    .from(audioFiles);

  let newFilesSincePrev: number | null = null;
  let newDetectionsSincePrev: number | null = null;
  let birdnetJobsCompletedSincePrev: number | null = null;

  if (previousSnapshotDate) {
    // Treat the previous snapshot's date as the lower bound (midnight UTC of
    // that date). New rows since then are "today's progress" from the email's
    // point of view.
    const cutoff = new Date(`${previousSnapshotDate}T00:00:00Z`);
    const [f] = await db
      .select({ n: count() })
      .from(audioFiles)
      .where(gte(audioFiles.createdAt, cutoff));
    newFilesSincePrev = f?.n ?? 0;

    const [d] = await db
      .select({ n: count() })
      .from(audioDetections)
      .where(gte(audioDetections.createdAt, cutoff));
    newDetectionsSincePrev = d?.n ?? 0;

    const [j] = await db
      .select({ n: count() })
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.jobType, JOB_TYPES.BIRDNET),
          eq(processingJobs.status, "completed"),
          gte(processingJobs.completedAt, cutoff),
        ),
      );
    birdnetJobsCompletedSincePrev = j?.n ?? 0;
  }

  return {
    totalFiles: files?.n ?? 0,
    totalDetections: detections?.n ?? 0,
    totalSpecies: species?.n ?? 0,
    deploymentsWithAudio: deps?.n ?? 0,
    newFilesSincePrev,
    newDetectionsSincePrev,
    birdnetJobsCompletedSincePrev,
    previousSnapshotDate,
  };
}

// ---------------------------------------------------------------------------
// Snapshot computation
// ---------------------------------------------------------------------------

function computeSnapshot(
  results: DeploymentResult[],
  totalDeployments: number
): SnapshotData {
  let totalCameras = 0;
  let totalAudio = 0;
  let totalIbutton = 0;
  let totalCameraSizeBytes = 0;
  let totalAudioSizeBytes = 0;
  let totalIbuttonSizeBytes = 0;
  let deploymentsWithUploads = 0;

  for (const r of results) {
    if (!r.uploads) continue;
    const cam = r.uploads.camarasTrampas ?? 0;
    const aud = r.uploads.grabadoresDeAudio ?? 0;
    const ibt = r.uploads.ibutton ?? 0;
    totalCameras += cam;
    totalAudio += aud;
    totalIbutton += ibt;
    totalCameraSizeBytes += r.uploads.camarasTrampasSizeBytes ?? 0;
    totalAudioSizeBytes += r.uploads.grabadoresDeAudioSizeBytes ?? 0;
    totalIbuttonSizeBytes += r.uploads.ibuttonSizeBytes ?? 0;
    if (cam > 0 || aud > 0 || ibt > 0) deploymentsWithUploads++;
  }

  return {
    totalCameras, totalAudio, totalIbutton,
    totalCameraSizeBytes, totalAudioSizeBytes, totalIbuttonSizeBytes,
    deploymentsWithUploads, totalDeployments,
  };
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

async function sendReport(
  apiKey: string,
  recipientEmails: string,
  date: string,
  results: DeploymentResult[],
  delta: SnapshotDelta,
  audioReport: AudioReport,
) {
  const resend = new Resend(apiKey);
  const fromEmail = process.env.RESEND_FROM_EMAIL ?? "portal@fcat-ecuador.org";
  const to = recipientEmails.split(",").map((e) => e.trim()).filter(Boolean);

  if (to.length === 0) {
    log.warn("[nightly] No recipient emails configured");
    return;
  }

  const errors = results.filter((r) => r.error);
  const statusLine = errors.length > 0
    ? `Completado con errores (${errors.length} fallos)`
    : "Completado";

  const html = buildEmailHtml(date, statusLine, results, delta, errors, audioReport);

  try {
    const { error } = await resend.emails.send({
      from: fromEmail,
      to,
      subject: `BioChoco Datos — Resumen nocturno ${date}`,
      html,
    });

    if (error) {
      log.error({ err: error }, "[nightly] Resend API error");
    } else {
      log.info({ to }, "[nightly] Email sent");
    }
  } catch (err) {
    log.error({ err }, "[nightly] Failed to send email");
  }
}

// ---------------------------------------------------------------------------
// HTML Email Builder
// ---------------------------------------------------------------------------

function buildAudioSection(report: AudioReport): string {
  return `
  <h3 style="margin-top:32px">🎙️ Audio (BirdNET)</h3>
  <table style="border-collapse:collapse;margin-top:8px">
    <tr>
      <td style="padding:6px 16px 6px 0;font-weight:600">Instalaciones con audio indexado</td>
      <td style="padding:6px 0">${report.deploymentsWithAudio.toLocaleString()}</td>
    </tr>
    <tr>
      <td style="padding:6px 16px 6px 0;font-weight:600">Archivos de audio</td>
      <td style="padding:6px 0">${report.totalFiles.toLocaleString()}${formatNewSince(report.newFilesSincePrev, report.previousSnapshotDate)}</td>
    </tr>
    <tr>
      <td style="padding:6px 16px 6px 0;font-weight:600">Detecciones BirdNET</td>
      <td style="padding:6px 0">${report.totalDetections.toLocaleString()}${formatNewSince(report.newDetectionsSincePrev, report.previousSnapshotDate)}</td>
    </tr>
    <tr>
      <td style="padding:6px 16px 6px 0;font-weight:600">Especies detectadas</td>
      <td style="padding:6px 0">${report.totalSpecies.toLocaleString()}</td>
    </tr>
    <tr>
      <td style="padding:6px 16px 6px 0;font-weight:600">Instalaciones analizadas</td>
      <td style="padding:6px 0">${report.birdnetJobsCompletedSincePrev === null ? "—" : `${report.birdnetJobsCompletedSincePrev.toLocaleString()}${report.previousSnapshotDate ? ` desde ${report.previousSnapshotDate}` : ""}`}</td>
    </tr>
  </table>`;
}

function buildEmailHtml(
  date: string,
  statusLine: string,
  results: DeploymentResult[],
  delta: SnapshotDelta,
  errors: DeploymentResult[],
  audioReport: AudioReport,
): string {
  const totalFiles = delta.totalCameras + delta.totalAudio + delta.totalIbutton;
  const totalSize = delta.totalCameraSizeBytes + delta.totalAudioSizeBytes + delta.totalIbuttonSizeBytes;

  const deploymentRows = results
    .filter((r) => {
      if (!r.uploads) return false;
      return (
        (r.uploads.camarasTrampas ?? 0) > 0 ||
        (r.uploads.grabadoresDeAudio ?? 0) > 0 ||
        (r.uploads.ibutton ?? 0) > 0
      );
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const deploymentTableRows = deploymentRows
    .map((r) => {
      const u = r.uploads!;
      return `<tr>
        <td style="padding:6px 12px;border:1px solid #e5e7eb">${r.name}</td>
        <td style="padding:6px 12px;border:1px solid #e5e7eb">${r.siteName ?? "—"}</td>
        <td style="padding:6px 12px;border:1px solid #e5e7eb;text-align:right">${formatCountCell(u.camarasTrampas, r.previousCameraCount)}</td>
        <td style="padding:6px 12px;border:1px solid #e5e7eb;text-align:right">${formatCountCell(u.grabadoresDeAudio, r.previousAudioCount)}</td>
        <td style="padding:6px 12px;border:1px solid #e5e7eb;text-align:right">${formatCountCell(u.ibutton, r.previousIbuttonCount)}</td>
      </tr>`;
    })
    .join("\n");

  // "Nuevas instalaciones" — first time this deployment has any uploads.
  // Treats null prior (never seen) and 0 prior (seen but empty) the same.
  const newDeployments = results
    .filter((r) => {
      if (!r.uploads) return false;
      const prevTotal =
        (r.previousCameraCount ?? 0) +
        (r.previousAudioCount ?? 0) +
        (r.previousIbuttonCount ?? 0);
      const curTotal =
        (r.uploads.camarasTrampas ?? 0) +
        (r.uploads.grabadoresDeAudio ?? 0) +
        (r.uploads.ibutton ?? 0);
      return prevTotal === 0 && curTotal > 0;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const newDeploymentsSection =
    newDeployments.length > 0
      ? `
  <h3 style="margin-top:24px;color:#16a34a">Nuevas instalaciones con datos (${newDeployments.length})</h3>
  <table style="border-collapse:collapse;width:100%;margin-top:8px">
    <tr style="background:#f0fdf4">
      <th style="padding:8px 12px;border:1px solid #bbf7d0;text-align:left">Instalación</th>
      <th style="padding:8px 12px;border:1px solid #bbf7d0;text-align:left">Sitio</th>
      <th style="padding:8px 12px;border:1px solid #bbf7d0;text-align:right">Cámaras</th>
      <th style="padding:8px 12px;border:1px solid #bbf7d0;text-align:right">Audio</th>
      <th style="padding:8px 12px;border:1px solid #bbf7d0;text-align:right">iButton</th>
    </tr>
    ${newDeployments
      .map((r) => {
        const u = r.uploads!;
        return `<tr>
        <td style="padding:6px 12px;border:1px solid #bbf7d0">${r.name}</td>
        <td style="padding:6px 12px;border:1px solid #bbf7d0">${r.siteName ?? "—"}</td>
        <td style="padding:6px 12px;border:1px solid #bbf7d0;text-align:right">${(u.camarasTrampas ?? 0).toLocaleString()}</td>
        <td style="padding:6px 12px;border:1px solid #bbf7d0;text-align:right">${(u.grabadoresDeAudio ?? 0).toLocaleString()}</td>
        <td style="padding:6px 12px;border:1px solid #bbf7d0;text-align:right">${(u.ibutton ?? 0).toLocaleString()}</td>
      </tr>`;
      })
      .join("\n")}
  </table>`
      : "";

  const errorSection =
    errors.length > 0
      ? `
    <h3 style="color:#dc2626;margin-top:24px">Errores</h3>
    <table style="border-collapse:collapse;width:100%;margin-top:8px">
      <tr style="background:#fef2f2">
        <th style="padding:8px 12px;border:1px solid #fecaca;text-align:left">Instalación</th>
        <th style="padding:8px 12px;border:1px solid #fecaca;text-align:left">Error</th>
      </tr>
      ${errors
        .map(
          (e) => `<tr>
        <td style="padding:6px 12px;border:1px solid #fecaca">${e.name}</td>
        <td style="padding:6px 12px;border:1px solid #fecaca;color:#dc2626">${e.error}</td>
      </tr>`
        )
        .join("\n")}
    </table>`
      : "";

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1f2937;max-width:800px;margin:0 auto;padding:20px">
  <h2 style="margin-bottom:4px">BioChoco Datos — Resumen nocturno</h2>
  <p style="color:#6b7280;margin-top:0">${date}</p>

  <p style="font-size:16px;font-weight:600;color:${errors.length > 0 ? "#dc2626" : "#16a34a"}">${statusLine}</p>

  <p style="font-size:14px;color:#6b7280;margin-top:8px">Total: <strong>${formatBytes(totalSize)}</strong> en ${totalFiles.toLocaleString()} archivos</p>

  <h3 style="margin-top:24px">Resumen</h3>
  <table style="border-collapse:collapse;margin-top:8px">
    <tr>
      <td style="padding:6px 16px 6px 0;font-weight:600">Cámaras trampa</td>
      <td style="padding:6px 0">${delta.totalCameras.toLocaleString()} (${formatBytes(delta.totalCameraSizeBytes)})${formatDeltaHtml(delta.deltaCameras, delta.deltaCameraSizeBytes, delta.previousSnapshotDate)}</td>
    </tr>
    <tr>
      <td style="padding:6px 16px 6px 0;font-weight:600">Grabadores de audio</td>
      <td style="padding:6px 0">${delta.totalAudio.toLocaleString()} (${formatBytes(delta.totalAudioSizeBytes)})${formatDeltaHtml(delta.deltaAudio, delta.deltaAudioSizeBytes, delta.previousSnapshotDate)}</td>
    </tr>
    <tr>
      <td style="padding:6px 16px 6px 0;font-weight:600">iButton</td>
      <td style="padding:6px 0">${delta.totalIbutton.toLocaleString()} (${formatBytes(delta.totalIbuttonSizeBytes)})${formatDeltaHtml(delta.deltaIbutton, delta.deltaIbuttonSizeBytes, delta.previousSnapshotDate)}</td>
    </tr>
    <tr>
      <td style="padding:6px 16px 6px 0;font-weight:600">Instalaciones con datos</td>
      <td style="padding:6px 0">${delta.deploymentsWithUploads} de ${delta.totalDeployments}</td>
    </tr>
  </table>

  ${newDeploymentsSection}

  ${buildAudioSection(audioReport)}

  <h3 style="margin-top:24px">Por instalación</h3>
  <table style="border-collapse:collapse;width:100%;margin-top:8px">
    <tr style="background:#f3f4f6">
      <th style="padding:8px 12px;border:1px solid #e5e7eb;text-align:left">Instalación</th>
      <th style="padding:8px 12px;border:1px solid #e5e7eb;text-align:left">Sitio</th>
      <th style="padding:8px 12px;border:1px solid #e5e7eb;text-align:right">Cámaras</th>
      <th style="padding:8px 12px;border:1px solid #e5e7eb;text-align:right">Audio</th>
      <th style="padding:8px 12px;border:1px solid #e5e7eb;text-align:right">iButton</th>
    </tr>
    ${deploymentTableRows}
  </table>

  ${errorSection}

  <p style="color:#9ca3af;font-size:12px;margin-top:32px">Generado automáticamente por FCAT Portal</p>
</body>
</html>`;
}
