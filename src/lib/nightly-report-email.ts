/**
 * HTML builder for the nightly "BioChoco Datos — Resumen nocturno" email.
 *
 * Pure presentation layer (no DB / no Drive / no server-only deps) so it can be
 * unit-tested and rendered offline. The cron route
 * (`src/app/api/cron/nightly-refresh/route.ts`) gathers the data and calls
 * `buildEmailHtml`.
 *
 * Layout: a top "Resumen del día" dashboard (Datos nuevos / Actividad / Totales
 * acumulados) that interleaves the 24h Drive deltas with the analysis-activity
 * totals, followed by a "Detalle" area (new deployments, job + verification
 * tables, BirdNET, per-installation breakdown, errors).
 */

import type { UploadStatus } from "@/lib/drive-client";
import {
  formatBytes,
  formatCountCell,
  formatNewSince,
} from "@/lib/email/format";
import { buildPortalActivityDetail } from "@/lib/portal-updates/email-template";
import type { PortalUpdatesPayload } from "@/lib/portal-updates/types";

// ---------------------------------------------------------------------------
// Types (shared with the cron route)
// ---------------------------------------------------------------------------

export interface DeploymentResult {
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

export interface SnapshotData {
  totalCameras: number;
  totalAudio: number;
  totalIbutton: number;
  totalCameraSizeBytes: number;
  totalAudioSizeBytes: number;
  totalIbuttonSizeBytes: number;
  deploymentsWithUploads: number;
  totalDeployments: number;
}

export interface SnapshotDelta extends SnapshotData {
  deltaCameras: number | null;
  deltaAudio: number | null;
  deltaIbutton: number | null;
  deltaCameraSizeBytes: number | null;
  deltaAudioSizeBytes: number | null;
  deltaIbuttonSizeBytes: number | null;
  previousSnapshotDate: string | null;
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Base URL for deployment links in the email. Matches the convention used by
// the other cron email routes (shared-drive-alerts, research-reminders, etc.).
const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://portal.fcat-ecuador.org";

/** Wrap email cell HTML in an anchor (muted blue, no underline) to a portal page. */
function emailLink(href: string, inner: string): string {
  return `<a href="${href}" style="color:#2563eb;text-decoration:none">${inner}</a>`;
}

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
  </table>
  <p style="color:#6b7280;font-size:12px;margin-top:6px;max-width:560px">«Archivos de audio» son los archivos ya indexados en el portal; puede ir por detrás de «Grabadores de audio» (subidos a Drive) mientras la sincronización de audio se pone al día.</p>`;
}

// --- Top "Resumen del día" dashboard --------------------------------------

/** A label/value row in a dashboard mini-table. `value` may be HTML. */
function metricRow(label: string, value: string): string {
  return `<tr>
      <td style="padding:4px 20px 4px 0;color:#374151">${label}</td>
      <td style="padding:4px 0;font-weight:600">${value}</td>
    </tr>`;
}

/** A titled group of metric rows inside the dashboard panel. */
function dashboardGroup(title: string, rowsHtml: string): string {
  return `
    <div style="margin-top:14px">
      <div style="text-transform:uppercase;font-size:11px;letter-spacing:.04em;color:#6b7280;font-weight:700;margin-bottom:2px">${title}</div>
      <table style="border-collapse:collapse">${rowsHtml}</table>
    </div>`;
}

/**
 * "Datos nuevos" row: 24h delta as the primary figure, cumulative total as
 * muted context. Falls back to the cumulative figure when there's no prior
 * snapshot to diff against (first run).
 */
function newDataRow(
  label: string,
  deltaCount: number | null,
  deltaBytes: number | null,
  totalCount: number,
  totalBytes: number,
): string {
  const totalMuted = `<span style="color:#9ca3af;font-weight:400">· ${totalCount.toLocaleString()} en total (${formatBytes(totalBytes)})</span>`;
  if (deltaCount === null) {
    return metricRow(label, `${totalCount.toLocaleString()} (${formatBytes(totalBytes)})`);
  }
  const sign = deltaCount >= 0 ? "+" : "−";
  const color = deltaCount > 0 ? "#16a34a" : "#6b7280";
  const cnt = `<span style="color:${color}">${sign}${Math.abs(deltaCount).toLocaleString()}</span>`;
  const sz = deltaBytes
    ? ` <span style="color:#9ca3af;font-weight:400">(${deltaBytes >= 0 ? "+" : "−"}${formatBytes(Math.abs(deltaBytes))})</span>`
    : "";
  return metricRow(label, `${cnt}${sz} ${totalMuted}`);
}

function buildDashboard(
  delta: SnapshotDelta,
  audioReport: AudioReport,
  activity: PortalUpdatesPayload | null,
): string {
  const totalFiles = delta.totalCameras + delta.totalAudio + delta.totalIbutton;
  const totalSize =
    delta.totalCameraSizeBytes + delta.totalAudioSizeBytes + delta.totalIbuttonSizeBytes;

  const datosGroup = dashboardGroup(
    "Datos nuevos (24 h)",
    [
      newDataRow("Cámaras trampa", delta.deltaCameras, delta.deltaCameraSizeBytes, delta.totalCameras, delta.totalCameraSizeBytes),
      newDataRow("Grabadores de audio", delta.deltaAudio, delta.deltaAudioSizeBytes, delta.totalAudio, delta.totalAudioSizeBytes),
      newDataRow("iButton", delta.deltaIbutton, delta.deltaIbuttonSizeBytes, delta.totalIbutton, delta.totalIbuttonSizeBytes),
    ].join(""),
  );

  const actividadGroup = dashboardGroup(
    "Actividad (24 h)",
    activity
      ? [
          metricRow("Trabajos cámara trampa", activity.totalCtJobs.toLocaleString()),
          metricRow("Trabajos audio", activity.totalAudioJobs.toLocaleString()),
          metricRow("Imágenes verificadas", activity.totalCtVerifiedImages.toLocaleString()),
          metricRow("Grabaciones verificadas", activity.totalAudioVerifiedFiles.toLocaleString()),
        ].join("")
      : metricRow("Resumen de actividad", `<span style="color:#9ca3af;font-weight:400">No disponible</span>`),
  );

  const totalesGroup = dashboardGroup(
    "Totales acumulados",
    [
      metricRow("Almacenamiento", `${formatBytes(totalSize)} · ${totalFiles.toLocaleString()} archivos`),
      metricRow("BirdNET", `${audioReport.totalDetections.toLocaleString()} detecciones · ${audioReport.totalSpecies.toLocaleString()} especies`),
      metricRow("Instalaciones con datos", `${delta.deploymentsWithUploads} / ${delta.totalDeployments}`),
    ].join(""),
  );

  return `
  <div style="border:1px solid #e5e7eb;border-radius:8px;padding:4px 20px 16px;margin-top:16px;background:#fafafa">
    <h3 style="margin:12px 0 0 0">Resumen del día</h3>
    ${datosGroup}
    ${actividadGroup}
    ${totalesGroup}
  </div>`;
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

export function buildEmailHtml(
  date: string,
  statusLine: string,
  results: DeploymentResult[],
  delta: SnapshotDelta,
  errors: DeploymentResult[],
  audioReport: AudioReport,
  activity: PortalUpdatesPayload | null,
): string {
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
      // Link the name + each count cell to its data type's page. Only link a
      // count cell when its count > 0 (rows can carry a 0 in one category).
      const nameCell = emailLink(`${SITE_URL}/camera-trap/${r.id}`, r.name);
      const camCount = u.camarasTrampas ?? 0;
      const audCount = u.grabadoresDeAudio ?? 0;
      const ibtCount = u.ibutton ?? 0;
      const camCell = camCount > 0
        ? emailLink(`${SITE_URL}/camera-trap/${r.id}`, formatCountCell(u.camarasTrampas, r.previousCameraCount))
        : formatCountCell(u.camarasTrampas, r.previousCameraCount);
      const audCell = audCount > 0
        ? emailLink(`${SITE_URL}/audio/${r.id}`, formatCountCell(u.grabadoresDeAudio, r.previousAudioCount))
        : formatCountCell(u.grabadoresDeAudio, r.previousAudioCount);
      const ibtCell = ibtCount > 0
        ? emailLink(`${SITE_URL}/biochoco/ibutton/${r.id}`, formatCountCell(u.ibutton, r.previousIbuttonCount))
        : formatCountCell(u.ibutton, r.previousIbuttonCount);
      return `<tr>
        <td style="padding:6px 12px;border:1px solid #e5e7eb">${nameCell}</td>
        <td style="padding:6px 12px;border:1px solid #e5e7eb">${r.siteName ?? "—"}</td>
        <td style="padding:6px 12px;border:1px solid #e5e7eb;text-align:right">${camCell}</td>
        <td style="padding:6px 12px;border:1px solid #e5e7eb;text-align:right">${audCell}</td>
        <td style="padding:6px 12px;border:1px solid #e5e7eb;text-align:right">${ibtCell}</td>
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
        <td style="padding:6px 12px;border:1px solid #bbf7d0">${emailLink(`${SITE_URL}/camera-trap/${r.id}`, r.name)}</td>
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

  const activityDetail = activity ? buildPortalActivityDetail(activity) : "";

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1f2937;max-width:800px;margin:0 auto;padding:20px">
  <h2 style="margin-bottom:4px">BioChoco Datos — Resumen nocturno</h2>
  <p style="color:#6b7280;margin-top:0">${date} · <span style="color:${errors.length > 0 ? "#dc2626" : "#16a34a"};font-weight:600">${statusLine}</span></p>

  ${buildDashboard(delta, audioReport, activity)}

  <h3 style="margin-top:28px;border-top:2px solid #e5e7eb;padding-top:16px">Detalle</h3>

  ${newDeploymentsSection}

  ${activityDetail ? `
  <h4 style="margin:16px 0 4px 0;font-size:14px;color:#374151">Trabajos y verificación (últimas 24 h)</h4>
  ${activityDetail}` : ""}

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
