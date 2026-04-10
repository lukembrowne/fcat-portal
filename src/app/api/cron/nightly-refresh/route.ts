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
import { deployments, uploadCountSnapshots } from "@/db/schema";
import { checkDeploymentUploads, type UploadStatus } from "@/lib/drive-client";
import { verifyCronSecret } from "@/lib/cron-auth";
import { isNotNull, eq, sql } from "drizzle-orm";
import { Resend } from "resend";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DeploymentResult {
  id: number;
  name: string;
  siteName: string | null;
  uploads: UploadStatus | null;
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
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
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

    // Step 1: Query all deployments with a Drive folder
    const allDeployments = db
      .select({
        id: deployments.id,
        name: deployments.name,
        siteName: deployments.siteName,
        driveFolderId: deployments.driveFolderId,
      })
      .from(deployments)
      .where(isNotNull(deployments.driveFolderId))
      .all();

    log.info({ count: allDeployments.length }, "[nightly] Found deployments with Drive folders");

    // Step 2: Check each deployment sequentially
    const results: DeploymentResult[] = [];

    for (const dep of allDeployments) {
      log.info({ name: dep.name, folderId: dep.driveFolderId }, "[nightly] Checking deployment");

      const result = await checkDeploymentUploads(dep.driveFolderId!);

      if (!result.success) {
        log.error({ name: dep.name, err: result.error }, "[nightly] FAILED");
        results.push({
          id: dep.id,
          name: dep.name,
          siteName: dep.siteName,
          uploads: null,
          error: result.error,
        });
        continue;
      }

      const uploads = result.data;
      log.info(
        {
          name: dep.name,
          cameras: uploads.camarasTrampas,
          audio: uploads.grabadoresDeAudio,
          ibutton: uploads.ibutton,
        },
        "[nightly] deployment counts"
      );

      // Persist counts, sizes, newest dates to DB
      db.update(deployments)
        .set({
          uploadCameraCount: uploads.camarasTrampas,
          uploadAudioCount: uploads.grabadoresDeAudio,
          uploadIbuttonCount: uploads.ibutton,
          uploadCameraSizeBytes: uploads.camarasTrampasSizeBytes,
          uploadAudioSizeBytes: uploads.grabadoresDeAudioSizeBytes,
          uploadIbuttonSizeBytes: uploads.ibuttonSizeBytes,
          uploadNewestCameraDate: uploads.camarasTrampasNewestDate,
          uploadNewestAudioDate: uploads.grabadoresDeAudioNewestDate,
          uploadNewestIbuttonDate: uploads.ibuttonNewestDate,
          uploadCameraFolderId: uploads.subfolderIds.camarasTrampas,
          uploadAudioFolderId: uploads.subfolderIds.grabadoresDeAudio,
          uploadIbuttonFolderId: uploads.subfolderIds.ibutton,
          uploadCountsCheckedAt: sql`(unixepoch())`,
        })
        .where(eq(deployments.id, dep.id))
        .run();

      results.push({
        id: dep.id,
        name: dep.name,
        siteName: dep.siteName,
        uploads,
        error: null,
      });
    }

    // Step 3: Save daily snapshot
    const snapshot = computeSnapshot(results, allDeployments.length);

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

    // Step 5: Send email
    const RESEND_API_KEY = process.env.RESEND_API_KEY;
    const NIGHTLY_REPORT_EMAILS = process.env.NIGHTLY_REPORT_EMAILS;

    if (RESEND_API_KEY && NIGHTLY_REPORT_EMAILS) {
      await sendReport(RESEND_API_KEY, NIGHTLY_REPORT_EMAILS, today, results, delta);
    } else {
      log.warn("[nightly] Email skipped — RESEND_API_KEY or NIGHTLY_REPORT_EMAILS not set");
    }

    const errorCount = results.filter((r) => r.error).length;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const totalSize = snapshot.totalCameraSizeBytes + snapshot.totalAudioSizeBytes + snapshot.totalIbuttonSizeBytes;
    log.info(
      { elapsedSec: elapsed, deployments: results.length, errors: errorCount, totalSize: formatBytes(totalSize) },
      "[nightly] Done"
    );

    return Response.json({
      ok: true,
      deployments: results.length,
      errors: errorCount,
      totalSize: formatBytes(totalSize),
      elapsed: `${elapsed}s`,
    });
  } catch (err) {
    log.error({ err }, "[nightly] Fatal error");
    return Response.json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      { status: 500 }
    );
  }
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
  delta: SnapshotDelta
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

  const html = buildEmailHtml(date, statusLine, results, delta, errors);

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

function formatDeltaHtml(
  countDelta: number | null,
  sizeDelta: number | null,
  previousDate: string | null
): string {
  if (countDelta === null) return "";
  const sinceLabel = previousDate ? `desde ${previousDate}` : "desde último conteo";
  if (countDelta === 0 && (sizeDelta === null || sizeDelta === 0)) {
    return ` <span style="color:#6b7280">sin cambios ${sinceLabel}</span>`;
  }
  const parts: string[] = [];
  if (countDelta !== 0) {
    parts.push(`${countDelta > 0 ? "+" : ""}${countDelta} archivos`);
  }
  if (sizeDelta && sizeDelta !== 0) {
    parts.push(`${sizeDelta > 0 ? "+" : ""}${formatBytes(Math.abs(sizeDelta))}`);
  }
  const color = countDelta > 0 ? "#16a34a" : "#dc2626";
  return ` <span style="color:${color};font-weight:600">${parts.join(", ")} ${sinceLabel}</span>`;
}

function buildEmailHtml(
  date: string,
  statusLine: string,
  results: DeploymentResult[],
  delta: SnapshotDelta,
  errors: DeploymentResult[]
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
        <td style="padding:6px 12px;border:1px solid #e5e7eb;text-align:right">${u.camarasTrampas ?? 0}</td>
        <td style="padding:6px 12px;border:1px solid #e5e7eb;text-align:right">${u.grabadoresDeAudio ?? 0}</td>
        <td style="padding:6px 12px;border:1px solid #e5e7eb;text-align:right">${u.ibutton ?? 0}</td>
      </tr>`;
    })
    .join("\n");

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
