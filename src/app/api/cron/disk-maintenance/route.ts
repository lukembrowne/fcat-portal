/**
 * Cron endpoint: daily disk hygiene for the shared droplet.
 *
 *   1. Sweep orphaned ct-images cache (dirs with no active/pending job) so a
 *      failed/cancelled run can't strand disk indefinitely.
 *   2. Check free disk against warn/critical thresholds and, when low, email
 *      admins BEFORE camera-trap jobs hit the hard pre-flight guard.
 *
 * The alert email is silent when disk is healthy (no inbox noise), modeled on
 * /api/cron/shared-drive-alerts. Threshold + sweep events are always recorded to
 * system_events (visible at /admin/activity) regardless of whether email sends.
 *
 * Auth: Bearer CRON_SECRET (timing-safe). No X-Forwarded-For guard — the
 * in-container cron call carries XFF in this deployment (same fix as 919f5ce).
 * Recipients: DISK_ALERT_EMAILS (csv), falling back to PORTAL_UPDATES_EMAILS.
 */

import { Resend } from "resend";
import { verifyCronSecret } from "@/lib/cron-auth";
import { log } from "@/lib/log";
import { recordEvent } from "@/lib/system-events";
import { sweepOrphanedCache, getFreeDiskBytes } from "@/lib/drive-downloader";
import { formatBytes } from "@/lib/email/format";

export const dynamic = "force-dynamic";

const GB = 1024 * 1024 * 1024;
const WARN_FREE_BYTES = parseInt(process.env.DISK_WARN_FREE_GB || "45", 10) * GB;
const CRITICAL_FREE_BYTES =
  parseInt(process.env.DISK_CRITICAL_FREE_GB || "32", 10) * GB;

export async function POST(request: Request) {
  if (!verifyCronSecret(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();

  // --- 1. Sweep orphaned cache -------------------------------------------
  const sweep = await sweepOrphanedCache();
  if (sweep.removed > 0) {
    await recordEvent({
      source: "cron",
      eventType: "cron_disk_maintenance",
      severity: "info",
      summary: `Caché huérfano liberado: ${sweep.removed} instalación(es), ${formatBytes(sweep.bytes)}`,
      durationMs: Date.now() - startTime,
      details: { removed: sweep.removed, bytes: sweep.bytes, deployments: sweep.deployments },
    });
    log.info(
      { removed: sweep.removed, bytes: sweep.bytes, deployments: sweep.deployments },
      "[disk-maintenance] Orphaned cache swept",
    );
  }

  // --- 2. Free-disk alert -------------------------------------------------
  const free = await getFreeDiskBytes();

  let severity: "warn" | "error" | null = null;
  let summary = "";
  if (free === null) {
    // Fail-closed: a measurement glitch is itself worth surfacing.
    severity = "warn";
    summary = "No se pudo medir el disco libre (statfs falló)";
  } else if (free < CRITICAL_FREE_BYTES) {
    severity = "error";
    summary = `Disco crítico: solo ${formatBytes(free)} libres (umbral ${formatBytes(CRITICAL_FREE_BYTES)})`;
  } else if (free < WARN_FREE_BYTES) {
    severity = "warn";
    summary = `Disco bajo: ${formatBytes(free)} libres (umbral ${formatBytes(WARN_FREE_BYTES)})`;
  }

  if (!severity) {
    // Healthy → record nothing, send nothing.
    return Response.json({
      ok: true,
      swept: sweep.removed,
      freeBytes: free,
      alert: false,
    });
  }

  await recordEvent({
    source: "cron",
    eventType: "cron_disk_space_low",
    severity,
    summary,
    durationMs: Date.now() - startTime,
    details: {
      freeBytes: free,
      warnBytes: WARN_FREE_BYTES,
      criticalBytes: CRITICAL_FREE_BYTES,
      sweptBytes: sweep.bytes,
    },
  });

  const emailResult = await sendDiskAlert(severity, summary, free, sweep);

  return Response.json({
    ok: true,
    swept: sweep.removed,
    freeBytes: free,
    alert: true,
    severity,
    emailSent: emailResult.sent,
  });
}

function parseRecipients(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function sendDiskAlert(
  severity: "warn" | "error",
  summary: string,
  free: number | null,
  sweep: { removed: number; bytes: number },
): Promise<{ sent: boolean }> {
  const recipients = parseRecipients(
    process.env.DISK_ALERT_EMAILS ?? process.env.PORTAL_UPDATES_EMAILS,
  );
  if (recipients.length === 0) {
    log.warn(
      "[disk-maintenance] Disco bajo pero sin destinatarios (DISK_ALERT_EMAILS / PORTAL_UPDATES_EMAILS) — email no enviado",
    );
    return { sent: false };
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    log.error("[disk-maintenance] RESEND_API_KEY no configurado — alerta no enviada");
    return { sent: false };
  }

  const fromEmail = process.env.RESEND_FROM_EMAIL ?? "portal@fcat-ecuador.org";
  const prefix = severity === "error" ? "🚨 CRÍTICO" : "⚠️ Aviso";
  const subject = `${prefix} · Disco del servidor: ${summary}`;
  const html = buildHtml(severity, summary, free, sweep);

  const resend = new Resend(apiKey);
  const { error: sendError } = await resend.emails.send({
    from: fromEmail,
    to: recipients,
    subject,
    html,
  });
  if (sendError) {
    log.error({ sendError }, "[disk-maintenance] Resend rechazó la alerta");
    return { sent: false };
  }
  log.info({ recipients: recipients.length, severity }, "[disk-maintenance] Alerta enviada");
  return { sent: true };
}

function buildHtml(
  severity: "warn" | "error",
  summary: string,
  free: number | null,
  sweep: { removed: number; bytes: number },
): string {
  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://portal.fcat-ecuador.org";
  const link = `${siteUrl.replace(/\/$/, "")}/admin/activity`;
  const color = severity === "error" ? "#b91c1c" : "#b45309";

  const sweptLine =
    sweep.removed > 0
      ? `<p style="color:#444;margin:0 0 12px">Se liberó caché huérfano de ${sweep.removed} instalación(es) (${formatBytes(sweep.bytes)}) en esta ejecución.</p>`
      : "";

  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;color:#111">
    <h2 style="margin:0 0 4px;color:${color}">Espacio en disco bajo</h2>
    <p style="font-size:16px;margin:0 0 12px"><strong style="color:${color}">${escapeHtml(summary)}</strong></p>
    <p style="color:#444;margin:0 0 12px">
      Cuando el disco libre baja del umbral, los trabajos de detección en cámaras trampa
      empiezan a fallar en la comprobación previa (necesitan ~30 GB libres). Esta alerta
      llega <em>antes</em> de ese punto para poder actuar.
    </p>
    ${sweptLine}
    <p style="margin:16px 0"><strong>Qué hacer:</strong> revisa el uso del disco y libera espacio
      (respaldos, caché de imágenes, prune de Docker). Consulta
      <code>docs/operations/disk-space-runbook.md</code>.</p>
    <p style="margin:16px 0">
      <a href="${link}" style="display:inline-block;background:#1d4ed8;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">
        Ver actividad del sistema →
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
