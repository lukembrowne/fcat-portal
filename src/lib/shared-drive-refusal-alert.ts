/**
 * Immediate email when routing REFUSES to create a deployment folder because a
 * project has no Shared Drive with room (or no active drive at all).
 *
 * Why this exists separately from the daily `/api/cron/shared-drive-alerts`
 * email: that cron reads fill at 6 AM, after the nightly reconcile has released
 * the day's reservations, so it only sees slow growth. A burst of folder
 * creation (each folder reserves DEPLOYMENT_QUOTA items until 3:15 AM) can push
 * a drive past the hard threshold within one afternoon and the cron never
 * notices — on 2026-11-19 nine BioChoco folders filled FCAT-BIOCHOCO-4's
 * headroom, the next four were refused, and the only trace was an error row in
 * /admin/activity. A refusal is a user-facing failure, so it is pushed now.
 *
 * Deduped to one email per project per 24 h (the create-folders panel calls the
 * action once per deployment, sequentially, so a batch would otherwise send one
 * email per refused folder). Never throws: an email problem must not change the
 * action's result.
 */
import "server-only";

import { Resend } from "resend";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { log } from "@/lib/log";
import { recordEvent } from "@/lib/system-events";
import { escapeHtml, SITE_URL } from "@/lib/email/format";
import { getHardPct } from "@/lib/shared-drives";

const EVENT_TYPE = "folder_create_refused_email";

/** Recipients for every Shared Drive capacity email (cron + refusal). */
export function getSharedDriveAlertRecipients(): string[] {
  const value =
    process.env.SHARED_DRIVE_ALERT_EMAILS ?? process.env.PORTAL_UPDATES_EMAILS;
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function alreadyNotified(projectId: number): boolean {
  const row = db.get(sql`
    SELECT 1 AS x FROM system_events
    WHERE source = 'shared-drives'
      AND event_type = ${EVENT_TYPE}
      AND target_id = ${String(projectId)}
      AND occurred_at >= unixepoch('now', '-1 day')
    LIMIT 1
  `) as { x: number } | undefined;
  return !!row;
}

type DriveRow = {
  name: string;
  status: string;
  item_cap: number;
  reconciled_count: number;
  pending_reservations_count: number;
};

export async function notifyFolderCreateRefused(input: {
  projectId: number;
  projectName: string;
  deploymentId: string;
  reason: "no_capacity" | "no_active_drives";
}): Promise<void> {
  try {
    if (alreadyNotified(input.projectId)) return;

    const drives = db.all(sql`
      SELECT name, status, item_cap, reconciled_count, pending_reservations_count
      FROM shared_drives
      WHERE archived_at IS NULL AND camera_trap_project_id = ${input.projectId}
      ORDER BY name
    `) as DriveRow[];

    const subject =
      input.reason === "no_capacity"
        ? `🚨 CRÍTICO · ${input.projectName}: no se pudo crear la carpeta ${input.deploymentId} — sin capacidad en Shared Drives`
        : `🚨 CRÍTICO · ${input.projectName}: no se pudo crear la carpeta ${input.deploymentId} — no hay Shared Drives activos`;

    const details = {
      projectId: input.projectId,
      deploymentId: input.deploymentId,
      reason: input.reason,
      drives: drives.map((d) => ({
        name: d.name,
        status: d.status,
        reconciled: d.reconciled_count,
        pending: d.pending_reservations_count,
      })),
    };

    const recipients = getSharedDriveAlertRecipients();
    const apiKey = process.env.RESEND_API_KEY;
    if (recipients.length === 0 || !apiKey) {
      // Recorded under the dedupe event type so a batch logs this once, not
      // once per refused folder.
      await recordEvent({
        source: "shared-drives",
        eventType: EVENT_TYPE,
        severity: "warn",
        summary: `Carpeta rechazada por capacidad — email no enviado (${
          recipients.length === 0 ? "sin destinatarios" : "RESEND_API_KEY no configurado"
        })`,
        targetType: "ct_project",
        targetId: input.projectId,
        details,
      });
      return;
    }

    const resend = new Resend(apiKey);
    const { error } = await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL ?? "portal@fcat-ecuador.org",
      to: recipients,
      subject,
      html: buildHtml(input, drives),
    });

    await recordEvent({
      source: "shared-drives",
      eventType: EVENT_TYPE,
      severity: "error",
      summary: error
        ? `Resend rechazó el aviso de carpeta rechazada: ${error.message ?? "unknown"}`
        : `Aviso enviado a ${recipients.length} destinatario(s): ${subject}`,
      targetType: "ct_project",
      targetId: input.projectId,
      details: error ? { ...details, resendError: String(error) } : details,
    });
  } catch (err) {
    log.error({ err, input }, "[shared-drives] refusal alert email failed");
  }
}

function buildHtml(
  input: { projectName: string; deploymentId: string; reason: string },
  drives: DriveRow[],
): string {
  const hard = getHardPct();
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const rows = drives
    .map((d) => {
      const effective = d.reconciled_count + d.pending_reservations_count;
      const reserved =
        d.pending_reservations_count > 0
          ? ` <span style="color:#666">(${d.pending_reservations_count.toLocaleString("es-EC")} reservados)</span>`
          : "";
      return `<tr>
        <td style="padding:6px 10px;border-bottom:1px solid #eee"><strong>${escapeHtml(d.name)}</strong> <span style="color:#666">· ${escapeHtml(d.status)}</span></td>
        <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;font-variant-numeric:tabular-nums">
          ${pct(d.item_cap > 0 ? effective / d.item_cap : 0)}<br>
          <span style="color:#666;font-size:12px">${effective.toLocaleString("es-EC")} / ${d.item_cap.toLocaleString("es-EC")}${reserved}</span>
        </td>
      </tr>`;
    })
    .join("");

  const why =
    input.reason === "no_capacity"
      ? `Ningún Shared Drive activo del proyecto tiene espacio por debajo del ${pct(hard)}.
         Cada carpeta nueva reserva espacio hasta la reconciliación nocturna (3:15 a. m. ET),
         así que crear muchas carpetas en un día puede agotar el margen aunque los archivos aún no se hayan subido.`
      : "El proyecto no tiene ningún Shared Drive activo asignado.";

  const link = `${SITE_URL.replace(/\/$/, "")}/admin/shared-drives`;

  return `<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:640px;margin:0 auto;color:#111">
    <h2 style="margin:0 0 4px">No se pudo crear una carpeta de instalación</h2>
    <p style="color:#444;margin:0 0 16px">
      La carpeta de <strong>${escapeHtml(input.deploymentId)}</strong> (${escapeHtml(input.projectName)})
      fue rechazada. ${why}
    </p>
    ${
      drives.length > 0
        ? `<table style="width:100%;border-collapse:collapse;margin-bottom:16px"><tbody>${rows}</tbody></table>`
        : ""
    }
    <p style="margin:16px 0">
      <strong>Qué hacer:</strong> registra un nuevo Shared Drive para este proyecto, o espera a la
      reconciliación nocturna, que libera las reservas, y vuelve a intentar mañana.
      Las demás carpetas rechazadas hoy no generan otro aviso.
    </p>
    <p style="margin:16px 0">
      <a href="${link}" style="display:inline-block;background:#1d4ed8;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">
        Abrir Shared Drives →
      </a>
    </p>
    <p style="color:#888;font-size:12px;margin-top:24px">Mensaje automático del Portal FCAT.</p>
  </div>`;
}
