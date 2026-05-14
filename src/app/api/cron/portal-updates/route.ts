/**
 * Daily portal-updates email.
 *
 * Independent cron from /api/cron/nightly-refresh — that one summarizes Drive
 * uploads (raw data ingestion). This one summarizes analysis activity:
 * camera-trap ML jobs, image verifications, audio jobs, audio verifications.
 *
 * Auth: Bearer token from CRON_SECRET. Recipients: PORTAL_UPDATES_EMAILS (csv).
 */

import { Resend } from "resend";
import { verifyCronSecret } from "@/lib/cron-auth";
import { log } from "@/lib/log";
import { recordEvent } from "@/lib/system-events";
import { buildPortalUpdatesPayload } from "@/lib/portal-updates/aggregator";
import {
  buildPortalUpdatesHtml,
  buildPortalUpdatesSubject,
} from "@/lib/portal-updates/email-template";
import type { PortalUpdatesPayload } from "@/lib/portal-updates/types";

export const dynamic = "force-dynamic";

const WINDOW_MS = 24 * 60 * 60 * 1000;

export async function POST(request: Request) {
  if (!verifyCronSecret(request)) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - WINDOW_MS);

  log.info(
    { windowStart, windowEnd },
    "[portal-updates] Building daily activity payload",
  );

  let payload: PortalUpdatesPayload;
  try {
    payload = await buildPortalUpdatesPayload(windowStart, windowEnd);
  } catch (err) {
    log.error({ err }, "[portal-updates] Failed to build payload");
    await recordEvent({
      source: "cron",
      eventType: "cron_portal_updates",
      severity: "error",
      summary: `Error generando email: ${(err as Error).message}`,
      durationMs: Date.now() - startTime,
      details: { error: String(err) },
    });
    return Response.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }

  const recipients = parseRecipients(process.env.PORTAL_UPDATES_EMAILS);

  if (recipients.length === 0) {
    log.warn(
      "[portal-updates] PORTAL_UPDATES_EMAILS not configured; skipping send",
    );
    await recordEvent({
      source: "cron",
      eventType: "cron_portal_updates",
      severity: "warn",
      summary:
        "No hay destinatarios configurados (PORTAL_UPDATES_EMAILS) — email no enviado",
      durationMs: Date.now() - startTime,
      details: { totals: payloadTotals(payload), reason: "no_recipients" },
    });
    return Response.json(
      { ok: false, reason: "no_recipients", totals: payloadTotals(payload) },
      { status: 200 },
    );
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    log.error("[portal-updates] RESEND_API_KEY not configured");
    await recordEvent({
      source: "cron",
      eventType: "cron_portal_updates",
      severity: "error",
      summary: "RESEND_API_KEY no configurado — email no enviado",
      durationMs: Date.now() - startTime,
      details: { totals: payloadTotals(payload), reason: "no_api_key" },
    });
    return Response.json(
      { error: "RESEND_API_KEY not configured" },
      { status: 500 },
    );
  }

  const fromEmail =
    process.env.RESEND_FROM_EMAIL ?? "portal@fcat-ecuador.org";
  const subject = buildPortalUpdatesSubject(payload);
  const html = buildPortalUpdatesHtml(payload);

  const resend = new Resend(apiKey);
  const { error: sendError } = await resend.emails.send({
    from: fromEmail,
    to: recipients,
    subject,
    html,
  });

  if (sendError) {
    log.error({ sendError }, "[portal-updates] Resend send failed");
    await recordEvent({
      source: "cron",
      eventType: "cron_portal_updates",
      severity: "warn",
      summary: `Resend rechazó el envío: ${sendError.message ?? "unknown"}`,
      durationMs: Date.now() - startTime,
      details: {
        totals: payloadTotals(payload),
        recipientCount: recipients.length,
        resendError: String(sendError),
      },
    });
    return Response.json(
      { ok: false, error: String(sendError), totals: payloadTotals(payload) },
      { status: 200 },
    );
  }

  await recordEvent({
    source: "cron",
    eventType: "cron_portal_updates",
    severity: "success",
    summary: summarize(payload, recipients.length),
    durationMs: Date.now() - startTime,
    details: { totals: payloadTotals(payload), recipientCount: recipients.length },
  });

  log.info(
    {
      elapsed: Date.now() - startTime,
      recipients: recipients.length,
      totals: payloadTotals(payload),
    },
    "[portal-updates] Email sent",
  );

  return Response.json({
    ok: true,
    totals: payloadTotals(payload),
    recipientCount: recipients.length,
    elapsedMs: Date.now() - startTime,
  });
}

function parseRecipients(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function payloadTotals(p: PortalUpdatesPayload) {
  return {
    ctJobs: p.totalCtJobs,
    audioJobs: p.totalAudioJobs,
    ctVerifiedImages: p.totalCtVerifiedImages,
    audioVerifiedFiles: p.totalAudioVerifiedFiles,
    activeProjects: p.projects.length,
  };
}

function summarize(
  p: PortalUpdatesPayload,
  recipientCount: number,
): string {
  if (p.projects.length === 0) {
    return `Email enviado a ${recipientCount} destinatario(s) — sin actividad nueva`;
  }
  const totalJobs = p.totalCtJobs + p.totalAudioJobs;
  const totalVerifies = p.totalCtVerifiedImages + p.totalAudioVerifiedFiles;
  return `Email enviado a ${recipientCount} destinatario(s): ${totalJobs} trabajos, ${totalVerifies} verificaciones, ${p.projects.length} proyectos activos`;
}
