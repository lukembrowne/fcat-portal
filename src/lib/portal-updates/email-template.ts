import type {
  JobBucket,
  LeaderboardRow,
  PortalUpdatesPayload,
  ProjectActivity,
} from "./types";

export function buildPortalUpdatesSubject(
  payload: PortalUpdatesPayload,
): string {
  const date = formatDate(payload.windowEnd);
  if (payload.projects.length === 0) {
    return `FCAT Portal — Sin actividad nueva (${date})`;
  }
  return `FCAT Portal — Actividad diaria ${date}`;
}

export function buildPortalUpdatesHtml(
  payload: PortalUpdatesPayload,
): string {
  const windowLabel = `${formatDateTime(payload.windowStart)} a ${formatDateTime(payload.windowEnd)}`;

  const headerHtml = `
  <h2 style="margin-bottom:4px">Actividad del Portal</h2>
  <p style="color:#6b7280;margin-top:0;font-size:14px">Resumen de las últimas 24 horas — ${windowLabel}</p>

  <p style="font-size:14px;margin-top:16px">
    <strong>${payload.totalCtJobs.toLocaleString()}</strong> trabajos cámara trampa &nbsp;·&nbsp;
    <strong>${payload.totalAudioJobs.toLocaleString()}</strong> trabajos audio &nbsp;·&nbsp;
    <strong>${payload.totalCtVerifiedImages.toLocaleString()}</strong> imágenes verificadas &nbsp;·&nbsp;
    <strong>${payload.totalAudioVerifiedFiles.toLocaleString()}</strong> grabaciones verificadas
  </p>
  `;

  const bodyHtml = payload.projects.length === 0
    ? `<p style="margin-top:24px;color:#6b7280">No hubo actividad nueva en este período.</p>`
    : payload.projects.map(renderProjectSection).join("\n");

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1f2937;max-width:800px;margin:0 auto;padding:20px">
${headerHtml}
${bodyHtml}
  <p style="color:#9ca3af;font-size:12px;margin-top:32px;border-top:1px solid #e5e7eb;padding-top:12px">portal.fcat-ecuador.org</p>
</body>
</html>`;
}

function renderProjectSection(project: ProjectActivity): string {
  const sections: string[] = [];

  if (project.ctJobs.length > 0) {
    sections.push(renderJobBlock("Cámaras trampa — Trabajos", project.ctJobs));
  }

  if (project.ctVerifiedImages > 0) {
    sections.push(
      renderVerifyBlock(
        "Cámaras trampa — Verificación",
        `${project.ctVerifiedImages.toLocaleString()} imágenes verificadas`,
        project.ctTopVerificadores,
      ),
    );
  }

  if (project.audioJobs.length > 0) {
    sections.push(renderJobBlock("Audio — Trabajos", project.audioJobs));
  }

  if (project.audioVerifiedFiles > 0) {
    sections.push(
      renderVerifyBlock(
        "Audio — Verificación",
        `${project.audioVerifiedFiles.toLocaleString()} grabaciones verificadas`,
        project.audioTopVerificadores,
      ),
    );
  }

  return `
  <section style="margin-top:28px;border-top:2px solid #e5e7eb;padding-top:16px">
    <h3 style="margin:0 0 12px 0;color:#111827">${escapeHtml(project.projectName)}</h3>
    ${sections.join("\n")}
  </section>`;
}

function renderJobBlock(title: string, buckets: JobBucket[]): string {
  const rows = buckets.map((b) => {
    const failedNote = b.failed > 0
      ? `, <span style="color:#dc2626">${b.failed.toLocaleString()} fallidos</span>`
      : "";
    return `<li>${escapeHtml(b.label)}: ${b.completed.toLocaleString()} completados${failedNote}</li>`;
  }).join("\n      ");

  return `
    <h4 style="margin:12px 0 4px 0;font-size:14px;color:#374151">${title}</h4>
    <ul style="margin:0;padding-left:20px;font-size:14px">
      ${rows}
    </ul>`;
}

function renderVerifyBlock(
  title: string,
  totalLine: string,
  leaderboard: LeaderboardRow[],
): string {
  const leaderboardHtml = leaderboard.length === 0
    ? ""
    : `
    <p style="margin:4px 0 0 0;font-size:13px;color:#6b7280">
      Verificadores:
      ${leaderboard.map((r) => `<strong>${escapeHtml(r.actorEmail)}</strong> (${r.count.toLocaleString()})`).join(" &nbsp;·&nbsp; ")}
    </p>`;

  return `
    <h4 style="margin:12px 0 4px 0;font-size:14px;color:#374151">${title}</h4>
    <p style="margin:0;font-size:14px">${totalLine}</p>${leaderboardHtml}`;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function formatDateTime(d: Date): string {
  return d.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
