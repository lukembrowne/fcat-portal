import "server-only";

import { Resend } from "resend";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { userPermissions } from "@/db/schema";
import { log } from "@/lib/log";
import { buildWhatsappReplyLink } from "@/lib/landowner/phone";

function getResend() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY not configured");
  return new Resend(apiKey);
}

function getFromEmail(): string {
  return process.env.RESEND_FROM_EMAIL ?? "portal@fcat-ecuador.org";
}

/** BioChoco team recipients: env override, else project editors/admins. */
async function getTeamEmails(): Promise<string[]> {
  const override = process.env.BIOCHOCO_CONTACT_EMAILS;
  if (override) {
    return override
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean);
  }
  const rows = db
    .select({ email: userPermissions.userEmail })
    .from(userPermissions)
    .where(
      and(
        eq(userPermissions.projectId, "biochoco"),
        inArray(userPermissions.role, ["editor", "admin"]),
      ),
    )
    .all();
  return rows.map((r: { email: string }) => r.email);
}

export interface LandownerContactPayload {
  siteId: string;
  message: string;
  prefersCall: boolean;
  landownerName: string;
  landownerPhone: string;
}

/** Send the landowner's message to the BioChoco team. Returns whether it sent. */
export async function sendLandownerContactEmail(
  payload: LandownerContactPayload,
): Promise<boolean> {
  const to = await getTeamEmails();
  if (to.length === 0) {
    log.error(
      { siteId: payload.siteId },
      "[landowner-contact] No team recipients configured",
    );
    return false;
  }

  const resend = getResend();
  const from = getFromEmail();
  const waLink = payload.landownerPhone
    ? buildWhatsappReplyLink(payload.landownerPhone)
    : null;

  const name = payload.landownerName || "(desconocido)";
  const subject = `Mensaje de propietario — ${payload.siteId}`;

  const html = `
    <h2>Nuevo mensaje de un propietario</h2>
    <p><strong>Sitio:</strong> ${escapeHtml(payload.siteId)}</p>
    <p><strong>Propietario:</strong> ${escapeHtml(name)}</p>
    <p><strong>Prefiere que le llamen:</strong> ${payload.prefersCall ? "Sí" : "No"}</p>
    <p><strong>Mensaje:</strong></p>
    <blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#333;">${escapeHtml(
      payload.message,
    ).replace(/\n/g, "<br>")}</blockquote>
    ${
      waLink
        ? `<p><a href="${escapeHtml(waLink)}">Responder por WhatsApp</a> (${escapeHtml(
            payload.landownerPhone,
          )})</p>`
        : "<p><em>Sin número de teléfono registrado para responder.</em></p>"
    }
  `;

  const text = [
    `Nuevo mensaje de un propietario`,
    `Sitio: ${payload.siteId}`,
    `Propietario: ${name}`,
    `Prefiere que le llamen: ${payload.prefersCall ? "Sí" : "No"}`,
    ``,
    payload.message,
    ``,
    waLink ? `Responder por WhatsApp: ${waLink}` : `Sin teléfono registrado.`,
  ].join("\n");

  try {
    const { error } = await resend.emails.send({ from, to, subject, html, text });
    if (error) {
      log.error({ err: error, siteId: payload.siteId }, "[landowner-contact] Resend error");
      return false;
    }
    return true;
  } catch (err) {
    log.error({ err, siteId: payload.siteId }, "[landowner-contact] Email send failed");
    return false;
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
