/**
 * Cron endpoint: email admins when a Shared Drive is approaching its 500K item
 * cap. Runs daily, AFTER the nightly reconcile has trued up the counts.
 *
 * Sends one consolidated email listing every drive at/over the soft threshold
 * and every project that should provision its next drive. Sends nothing when
 * all drives are healthy (no inbox noise). The threshold *events* are still
 * recorded by the reconcile worker and visible at /admin/activity + the banner;
 * this cron is purely the push notification.
 *
 * Auth: Bearer CRON_SECRET (timing-safe). No X-Forwarded-For guard — the
 * in-container cron call carries XFF in this deployment, so that guard 403'd
 * the legitimate trigger (same fix as commit 919f5ce / the reconcile route).
 * Recipients: SHARED_DRIVE_ALERT_EMAILS (csv), falling back to PORTAL_UPDATES_EMAILS.
 */

import { Resend } from "resend";
import { verifyCronSecret } from "@/lib/cron-auth";
import { log } from "@/lib/log";
import { recordEvent } from "@/lib/system-events";
import {
  getSharedDriveCapacityAlerts,
  type SharedDriveCapacityAlerts,
} from "@/lib/shared-drives";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!verifyCronSecret(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  const alerts = getSharedDriveCapacityAlerts();

  // Nothing crossed a threshold → no email, no noise.
  if (alerts.drives.length === 0 && alerts.provisionProjects.length === 0) {
    return Response.json({ ok: true, sent: false, reason: "no_alerts" });
  }

  const recipients = parseRecipients(
    process.env.SHARED_DRIVE_ALERT_EMAILS ?? process.env.PORTAL_UPDATES_EMAILS,
  );
  if (recipients.length === 0) {
    log.warn(
      "[shared-drive-alerts] No recipients (SHARED_DRIVE_ALERT_EMAILS / PORTAL_UPDATES_EMAILS) — skipping send",
    );
    await recordEvent({
      source: "cron",
      eventType: "cron_shared_drive_alert",
      severity: "warn",
      summary:
        "Drives cerca del límite pero sin destinatarios configurados (SHARED_DRIVE_ALERT_EMAILS) — email no enviado",
      durationMs: Date.now() - startTime,
      details: alertDetails(alerts),
    });
    return Response.json({ ok: false, reason: "no_recipients" }, { status: 200 });
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    log.error("[shared-drive-alerts] RESEND_API_KEY not configured");
    await recordEvent({
      source: "cron",
      eventType: "cron_shared_drive_alert",
      severity: "error",
      summary: "RESEND_API_KEY no configurado — alerta de capacidad no enviada",
      durationMs: Date.now() - startTime,
      details: alertDetails(alerts),
    });
    return Response.json({ error: "RESEND_API_KEY not configured" }, { status: 500 });
  }

  const fromEmail = process.env.RESEND_FROM_EMAIL ?? "portal@fcat-ecuador.org";
  const subject = buildSubject(alerts);
  const html = buildHtml(alerts);
  const resend = new Resend(apiKey);
  const { error: sendError } = await resend.emails.send({
    from: fromEmail,
    to: recipients,
    subject,
    html,
  });

  if (sendError) {
    log.error({ sendError }, "[shared-drive-alerts] Resend send failed");
    await recordEvent({
      source: "cron",
      eventType: "cron_shared_drive_alert",
      severity: "warn",
      summary: `Resend rechazó la alerta de capacidad: ${sendError.message ?? "unknown"}`,
      durationMs: Date.now() - startTime,
      details: { ...alertDetails(alerts), resendError: String(sendError) },
    });
    return Response.json({ ok: false, error: String(sendError) }, { status: 200 });
  }

  await recordEvent({
    source: "cron",
    eventType: "cron_shared_drive_alert",
    severity: alerts.hasCritical ? "error" : "warn",
    summary: `Alerta de capacidad enviada a ${recipients.length} destinatario(s): ${subject}`,
    durationMs: Date.now() - startTime,
    details: { ...alertDetails(alerts), recipientCount: recipients.length },
  });
  log.info(
    { elapsed: Date.now() - startTime, recipients: recipients.length },
    "[shared-drive-alerts] Email sent",
  );
  return Response.json({ ok: true, sent: true, recipientCount: recipients.length });
}

function parseRecipients(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function buildSubject(a: SharedDriveCapacityAlerts): string {
  const top = a.drives[0];
  const prefix = a.hasCritical ? "🚨 CRÍTICO" : "⚠️ Aviso";
  if (top) {
    return `${prefix} · Shared Drive ${top.name} al ${pct(top.fillPct)} de su límite`;
  }
  const p = a.provisionProjects[0];
  return `${prefix} · Aprovisionar Shared Drive para ${p?.projectName ?? "un proyecto"}`;
}

function alertDetails(a: SharedDriveCapacityAlerts) {
  return {
    hasCritical: a.hasCritical,
    drives: a.drives.map((d) => ({
      id: d.id,
      level: d.level,
      fillPct: d.fillPct,
      effectiveCount: d.effectiveCount,
      trashedCount: d.trashedCount,
    })),
    provisionProjects: a.provisionProjects.map((p) => ({
      projectId: p.projectId,
      fillPct: p.fillPct,
      hasHeadroom: p.hasHeadroom,
    })),
  };
}

function buildHtml(a: SharedDriveCapacityAlerts): string {
  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://portal.fcat-ecuador.org";
  const link = `${siteUrl.replace(/\/$/, "")}/admin/shared-drives`;

  const driveRows = a.drives
    .map((d) => {
      const color =
        d.level === "stop" ? "#b91c1c" : d.level === "hard" ? "#c2410c" : "#b45309";
      const trash =
        d.trashedCount > 0
          ? ` · <span style="color:#b45309">${d.trashedCount.toLocaleString("es-EC")} en papelera (purgables)</span>`
          : "";
      return `<tr>
        <td style="padding:6px 10px;border-bottom:1px solid #eee"><strong>${escapeHtml(d.name)}</strong>${
          d.projectName ? ` <span style="color:#666">(${escapeHtml(d.projectName)})</span>` : ""
        }</td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-variant-numeric:tabular-nums">
          <strong style="color:${color}">${pct(d.fillPct)}</strong><br>
          <span style="color:#666;font-size:12px">${d.effectiveCount.toLocaleString("es-EC")} / ${d.itemCap.toLocaleString("es-EC")}${trash}</span>
        </td>
      </tr>`;
    })
    .join("");

  const projectRows = a.provisionProjects
    .map(
      (p) =>
        `<li style="margin:4px 0">${escapeHtml(p.projectName)} — ${pct(p.fillPct)} ${
          p.hasHeadroom
            ? "(planificar el próximo drive)"
            : "<strong style=\"color:#b91c1c\">(sin capacidad — aprovisionar YA)</strong>"
        }</li>`,
    )
    .join("");

  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;color:#111">
    <h2 style="margin:0 0 4px">Capacidad de Shared Drives</h2>
    <p style="color:#444;margin:0 0 16px">
      Google limita cada Shared Drive a <strong>500.000 elementos</strong> (incluida la papelera).
      Al llegar al límite, no se pueden subir ni crear más archivos en ese drive.
    </p>
    ${
      a.drives.length > 0
        ? `<table style="width:100%;border-collapse:collapse;margin-bottom:16px">
            <thead><tr>
              <th style="text-align:left;padding:6px 10px;border-bottom:2px solid #ddd;font-size:13px;color:#666">Drive</th>
              <th style="text-align:right;padding:6px 10px;border-bottom:2px solid #ddd;font-size:13px;color:#666">Uso</th>
            </tr></thead>
            <tbody>${driveRows}</tbody>
          </table>`
        : ""
    }
    ${
      a.provisionProjects.length > 0
        ? `<p style="margin:0 0 4px"><strong>Proyectos que necesitan un nuevo drive:</strong></p>
           <ul style="margin:0 0 16px;padding-left:20px;color:#333">${projectRows}</ul>`
        : ""
    }
    <p style="margin:16px 0">
      <strong>Qué hacer:</strong> vacía la papelera del drive para recuperar espacio,
      o crea un nuevo Shared Drive, agrégale la cuenta de servicio y regístralo en el portal
      (asignándolo al proyecto correcto).
    </p>
    <p style="margin:16px 0">
      <a href="${link}" style="display:inline-block;background:#1d4ed8;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">
        Abrir Shared Drives →
      </a>
    </p>
    <p style="color:#888;font-size:12px;margin-top:24px">Mensaje automático del Portal FCAT.</p>
  </div>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
