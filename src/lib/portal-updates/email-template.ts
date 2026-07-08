import {
  COLOR_MUTED,
  COLOR_NEGATIVE,
  COLOR_POSITIVE,
  SITE_URL,
  TABLE_BORDER,
  TABLE_HEADER_BG,
  emailLink,
  escapeHtml,
  formatDate,
  formatDateTime,
  formatDuration,
} from "@/lib/email/format";
import type {
  JobDetail,
  LeaderboardRow,
  PortalUpdatesPayload,
  ProjectActivity,
  VerifiedDeploymentRow,
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
  <p style="color:${COLOR_MUTED};margin-top:0;font-size:14px">Resumen de las últimas 24 horas — ${windowLabel}</p>`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1f2937;max-width:800px;margin:0 auto;padding:20px">
${headerHtml}
${buildPortalUpdatesBody(payload)}
  <p style="color:#9ca3af;font-size:12px;margin-top:32px;border-top:1px solid ${TABLE_BORDER};padding-top:12px">portal.fcat-ecuador.org</p>
</body>
</html>`;
}

/**
 * The inner activity HTML (summary table + per-project sections, or the
 * "no activity" note) WITHOUT the `<html>`/`<body>` wrapper, header, or footer.
 * Used both by `buildPortalUpdatesHtml` (standalone email) and by the nightly
 * BioChoco email, which embeds this as a section under its own heading.
 */
export function buildPortalUpdatesBody(
  payload: PortalUpdatesPayload,
): string {
  const summaryHtml = `
  <h3 style="margin-top:24px">Resumen</h3>
  <table style="border-collapse:collapse;margin-top:8px">
    ${summaryRow(
      "Trabajos cámara trampa",
      payload.totalCtJobs,
      "Procesos de detección/ML de cámara trampa finalizados (completados o fallidos) en el período",
    )}
    ${summaryRow(
      "Trabajos audio",
      payload.totalAudioJobs,
      "Procesos de audio (BirdNET, índices acústicos, etc.) finalizados en el período",
    )}
    ${summaryRow(
      "Imágenes verificadas",
      payload.totalCtVerifiedImages,
      "Imágenes con al menos una identificación verificada o corregida en el período (cada imagen cuenta una vez, sin importar cuántas especies se revisaron)",
    )}
    ${summaryRow(
      "Grabaciones verificadas",
      payload.totalAudioVerifiedFiles,
      "Grabaciones con al menos una identificación verificada o corregida en el período (cada grabación cuenta una vez, sin importar cuántas especies se revisaron)",
    )}
  </table>`;

  const bodyHtml = payload.projects.length === 0
    ? `<p style="margin-top:24px;color:${COLOR_MUTED}">No hubo actividad nueva en este período.</p>`
    : payload.projects.map(renderProjectSection).join("\n");

  const verifiedBlock = renderVerifiedDeploymentsBlock(payload.verifiedDeployments);

  return [summaryHtml, bodyHtml, verifiedBlock].filter(Boolean).join("\n");
}

/**
 * Just the per-project DETAIL sections (job tables + verification
 * leaderboards), WITHOUT the summary metric table. Used by the nightly
 * BioChoco email, which surfaces the activity totals in its own top dashboard
 * and only needs the detail tables below. Returns "" when there's no activity.
 */
export function buildPortalActivityDetail(
  payload: PortalUpdatesPayload,
): string {
  // Single project (the BioChoco nightly case): drop the project-name heading —
  // it just collides with the "Cámaras trampa — Trabajos" / "Audio — Trabajos"
  // sub-headings and reads as if audio jobs belong to a "Cámaras Trampa" group.
  // Render the sub-sections directly. With multiple projects, keep the headings.
  let projectsHtml = "";
  if (payload.projects.length === 1) {
    projectsHtml = renderProjectInner(payload.projects[0]).join("\n");
  } else if (payload.projects.length > 1) {
    projectsHtml = payload.projects.map(renderProjectSection).join("\n");
  }

  const verifiedBlock = renderVerifiedDeploymentsBlock(payload.verifiedDeployments);

  if (!projectsHtml && !verifiedBlock) return "";
  return [projectsHtml, verifiedBlock].filter(Boolean).join("\n");
}

function summaryRow(label: string, value: number, description: string): string {
  const labelCell = `<strong>${label}</strong><div style="color:${COLOR_MUTED};font-size:12px;font-weight:400;margin-top:2px;max-width:480px">${description}</div>`;
  return `<tr>
      <td style="padding:8px 16px 8px 0;vertical-align:top">${labelCell}</td>
      <td style="padding:8px 0;vertical-align:top;text-align:right;font-weight:600">${value.toLocaleString()}</td>
    </tr>`;
}

/** The job + verification sub-sections for one project (no project heading). */
function renderProjectInner(project: ProjectActivity): string[] {
  const sections: string[] = [];

  if (project.ctJobs.length > 0) {
    sections.push(renderJobTable("Cámaras trampa — Trabajos", project.ctJobs));
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
    sections.push(renderJobTable("Audio — Trabajos", project.audioJobs));
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

  return sections;
}

function renderProjectSection(project: ProjectActivity): string {
  return `
  <section style="margin-top:28px;border-top:2px solid ${TABLE_BORDER};padding-top:16px">
    <h3 style="margin:0 0 12px 0;color:#111827">${escapeHtml(project.projectName)}</h3>
    ${renderProjectInner(project).join("\n")}
  </section>`;
}

function renderJobTable(title: string, jobs: JobDetail[]): string {
  const headerCell = (text: string, align: "left" | "right" | "center") =>
    `<th style="padding:8px 12px;border:1px solid ${TABLE_BORDER};text-align:${align}">${text}</th>`;

  const rows = jobs.map(renderJobRow).join("\n");

  return `
    <h4 style="margin:16px 0 4px 0;font-size:14px;color:#374151">${escapeHtml(title)}</h4>
    <table style="border-collapse:collapse;width:100%;margin-top:8px;font-size:13px">
      <tr style="background:${TABLE_HEADER_BG}">
        ${headerCell("Tipo", "left")}
        ${headerCell("Instalación", "left")}
        ${headerCell("Procesado", "right")}
        ${headerCell("Duración", "right")}
        ${headerCell("Estado", "left")}
      </tr>
      ${rows}
    </table>`;
}

function renderJobRow(job: JobDetail): string {
  const cell = (content: string, align: "left" | "right" = "left") =>
    `<td style="padding:6px 12px;border:1px solid ${TABLE_BORDER};text-align:${align};vertical-align:top">${content}</td>`;

  // Tipo: label + model as a muted sub-line.
  const model = job.detectorModel
    ? `<div style="color:${COLOR_MUTED};font-size:11px;margin-top:2px">${escapeHtml(
        [job.detectorModel, job.classifierModel].filter(Boolean).join(" · "),
      )}</div>`
    : "";
  const tipoCell = `<strong>${escapeHtml(job.label)}</strong>${model}`;

  // Instalación: deployment + site sub-line.
  const site = job.siteName
    ? `<div style="color:${COLOR_MUTED};font-size:11px;margin-top:2px">${escapeHtml(job.siteName)}</div>`
    : "";
  const instalacionCell = `${escapeHtml(job.deploymentName)}${site}`;

  // Procesado: images (+ videos/frames), with failed count in red.
  const procesadoCell = renderProcessedCell(job);

  // Estado: colored label, error sub-line on failure.
  const estadoCell = renderEstadoCell(job);

  return `<tr>
        ${cell(tipoCell)}
        ${cell(instalacionCell)}
        ${cell(procesadoCell, "right")}
        ${cell(formatDuration(job.durationMs), "right")}
        ${cell(estadoCell)}
      </tr>`;
}

function renderProcessedCell(job: JobDetail): string {
  const parts: string[] = [];

  if (job.totalImages > 0 || job.processedImages > 0) {
    parts.push(
      `${job.processedImages.toLocaleString()} / ${job.totalImages.toLocaleString()}`,
    );
  }
  if (job.totalVideos > 0) {
    parts.push(`${job.totalVideos.toLocaleString()} videos`);
  }
  if (job.extractedFrames > 0) {
    parts.push(`${job.extractedFrames.toLocaleString()} frames`);
  }

  const main = parts.length > 0 ? parts.join(" · ") : "—";

  const failed = job.failedImages > 0
    ? `<div style="color:${COLOR_NEGATIVE};font-size:11px;margin-top:2px">${job.failedImages.toLocaleString()} fallidas</div>`
    : "";

  return `${main}${failed}`;
}

function renderEstadoCell(job: JobDetail): string {
  if (job.status === "failed") {
    const error = job.errorMessage
      ? `<div style="color:${COLOR_NEGATIVE};font-size:11px;margin-top:2px">${escapeHtml(job.errorMessage)}</div>`
      : "";
    return `<span style="color:${COLOR_NEGATIVE};font-weight:600">Fallido</span>${error}`;
  }
  return `<span style="color:${COLOR_POSITIVE};font-weight:600">Completado</span>`;
}

/**
 * "Instalaciones verificadas" table — deployments whose status flipped to
 * verified/verified_empty in the window, with who did it. Returns "" when none.
 */
function renderVerifiedDeploymentsBlock(rows: VerifiedDeploymentRow[]): string {
  if (rows.length === 0) return "";

  const body = rows
    .map((r) => {
      const tipo = r.empty
        ? `<span style="color:${COLOR_MUTED}">Vacía (sin detecciones)</span>`
        : "Verificada";
      const name = r.deploymentName || `#${r.deploymentId}`;
      const nameLink = emailLink(
        `${SITE_URL}/camera-trap/${r.deploymentId}`,
        escapeHtml(name),
      );
      return `<tr>
        <td style="padding:6px 12px;border:1px solid ${TABLE_BORDER}">${nameLink}</td>
        <td style="padding:6px 12px;border:1px solid ${TABLE_BORDER}">${escapeHtml(r.actorEmail ?? "—")}</td>
        <td style="padding:6px 12px;border:1px solid ${TABLE_BORDER}">${tipo}</td>
      </tr>`;
    })
    .join("\n");

  return `
    <h4 style="margin:16px 0 4px 0;font-size:14px;color:#374151">Instalaciones verificadas (${rows.length})</h4>
    <table style="border-collapse:collapse;width:100%;margin-top:8px;font-size:13px">
      <tr style="background:${TABLE_HEADER_BG}">
        <th style="padding:6px 12px;border:1px solid ${TABLE_BORDER};text-align:left">Instalación</th>
        <th style="padding:6px 12px;border:1px solid ${TABLE_BORDER};text-align:left">Verificada por</th>
        <th style="padding:6px 12px;border:1px solid ${TABLE_BORDER};text-align:left">Tipo</th>
      </tr>
      ${body}
    </table>`;
}

function renderVerifyBlock(
  title: string,
  totalLine: string,
  leaderboard: LeaderboardRow[],
): string {
  const leaderboardHtml = leaderboard.length === 0
    ? ""
    : `
    <table style="border-collapse:collapse;margin-top:8px;font-size:13px">
      <tr style="background:${TABLE_HEADER_BG}">
        <th style="padding:6px 12px;border:1px solid ${TABLE_BORDER};text-align:left">Verificador</th>
        <th style="padding:6px 12px;border:1px solid ${TABLE_BORDER};text-align:right">Cantidad</th>
      </tr>
      ${leaderboard
        .map(
          (r) => `<tr>
        <td style="padding:6px 12px;border:1px solid ${TABLE_BORDER}">${escapeHtml(r.actorEmail)}</td>
        <td style="padding:6px 12px;border:1px solid ${TABLE_BORDER};text-align:right">${r.count.toLocaleString()}</td>
      </tr>`,
        )
        .join("\n")}
    </table>`;

  return `
    <h4 style="margin:16px 0 4px 0;font-size:14px;color:#374151">${escapeHtml(title)}</h4>
    <p style="margin:0;font-size:14px">${escapeHtml(totalLine)}</p>${leaderboardHtml}`;
}
