import "server-only";

import { Resend } from "resend";
import { eq, and, inArray } from "drizzle-orm";
import { db } from "@/db";
import { userPermissions } from "@/db/schema";
import { log } from "@/lib/log";

function getResend() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY not configured");
  return new Resend(apiKey);
}

function getFromEmail(): string {
  return (
    process.env.RESEARCH_APP_FROM_EMAIL ??
    process.env.RESEND_FROM_EMAIL ??
    "portal@fcat-ecuador.org"
  );
}

/**
 * Get email addresses of all editors and admins on the researcher-applications project.
 */
export async function getCommitteeEmails(): Promise<string[]> {
  const rows = db
    .select({ email: userPermissions.userEmail })
    .from(userPermissions)
    .where(
      and(
        eq(userPermissions.projectId, "researcher-applications"),
        inArray(userPermissions.role, ["editor", "admin"])
      )
    )
    .all();

  return rows.map((r: { email: string }) => r.email);
}

// ---------------------------------------------------------------------------
// Email templates
// ---------------------------------------------------------------------------

export async function sendSubmissionReceipt(
  toEmail: string,
  referenceCode: string,
  projectTitle: string
) {
  const resend = getResend();
  const from = getFromEmail();

  const html = `
    <h2>Application Received</h2>
    <p>Thank you for submitting your research application to FCAT.</p>
    <p><strong>Reference Code:</strong> ${escapeHtml(referenceCode)}</p>
    <p><strong>Project:</strong> ${escapeHtml(projectTitle)}</p>
    <p>The FCAT Scientific Committee will review your application and notify you of their decision. Please keep your reference code for future correspondence.</p>
    <p>— Fundación para la Conservación de los Andes Tropicales</p>
  `;

  const text = `Application Received\n\nThank you for submitting your research application to FCAT.\n\nReference Code: ${referenceCode}\nProject: ${projectTitle}\n\nThe FCAT Scientific Committee will review your application and notify you of their decision.\n\n— Fundación para la Conservación de los Andes Tropicales`;

  try {
    const { error } = await resend.emails.send({
      from,
      to: [toEmail],
      subject: `FCAT Research Application Received — ${referenceCode}`,
      html,
      text,
    });
    if (error) {
      log.error({ err: error }, "[ResearchApp] Receipt email Resend error");
    }
  } catch (err) {
    log.error({ err }, "[ResearchApp] Receipt email failed");
  }
}

export async function sendCommitteeNewAppNotification(
  referenceCode: string,
  projectTitle: string,
  piName: string,
  institution: string | null
) {
  const resend = getResend();
  const from = getFromEmail();
  const to = await getCommitteeEmails();

  if (to.length === 0) {
    log.warn("[ResearchApp] No committee emails found — skipping notification");
    return;
  }

  const portalUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://portal.fcat-ecuador.org";

  const html = `
    <h2>Nueva Aplicación de Investigación</h2>
    <p>Se ha recibido una nueva aplicación de investigación.</p>
    <table>
      <tr><td><strong>Código:</strong></td><td>${escapeHtml(referenceCode)}</td></tr>
      <tr><td><strong>Proyecto:</strong></td><td>${escapeHtml(projectTitle)}</td></tr>
      <tr><td><strong>Investigador:</strong></td><td>${escapeHtml(piName)}${institution ? ` — ${escapeHtml(institution)}` : ""}</td></tr>
    </table>
    <p><a href="${portalUrl}/research-applications">Ver en el Portal</a></p>
  `;

  const text = `Nueva Aplicación de Investigación\n\nCódigo: ${referenceCode}\nProyecto: ${projectTitle}\nInvestigador: ${piName}${institution ? ` — ${institution}` : ""}\n\nVer en el Portal: ${portalUrl}/research-applications`;

  try {
    const { error } = await resend.emails.send({
      from,
      to,
      subject: `Nueva aplicación — ${referenceCode}: ${projectTitle}`,
      html,
      text,
    });
    if (error) {
      log.error({ err: error }, "[ResearchApp] Committee notification Resend error");
    }
  } catch (err) {
    log.error({ err }, "[ResearchApp] Committee notification failed");
  }
}

export async function sendDecisionNotification(
  toEmail: string,
  referenceCode: string,
  projectTitle: string,
  decision: "accepted" | "rejected" | "revisions_requested",
  notes: string | null
) {
  const resend = getResend();
  const from = getFromEmail();

  const decisionText: Record<string, string> = {
    accepted: "Accepted",
    rejected: "Not Approved",
    revisions_requested: "Revisions Requested",
  };

  const html = `
    <h2>Application Decision — ${escapeHtml(decisionText[decision])}</h2>
    <p><strong>Reference:</strong> ${escapeHtml(referenceCode)}</p>
    <p><strong>Project:</strong> ${escapeHtml(projectTitle)}</p>
    <p><strong>Decision:</strong> ${escapeHtml(decisionText[decision])}</p>
    ${notes ? `<p><strong>Notes:</strong> ${escapeHtml(notes)}</p>` : ""}
    <p>If you have questions, please contact FCAT directly.</p>
    <p>— Fundación para la Conservación de los Andes Tropicales</p>
  `;

  const text = `Application Decision — ${decisionText[decision]}\n\nReference: ${referenceCode}\nProject: ${projectTitle}\nDecision: ${decisionText[decision]}${notes ? `\nNotes: ${notes}` : ""}\n\nIf you have questions, please contact FCAT directly.\n\n— Fundación para la Conservación de los Andes Tropicales`;

  try {
    const { error } = await resend.emails.send({
      from,
      to: [toEmail],
      subject: `FCAT Application Decision — ${referenceCode}`,
      html,
      text,
    });
    if (error) {
      log.error({ err: error }, "[ResearchApp] Decision email Resend error");
    }
  } catch (err) {
    log.error({ err }, "[ResearchApp] Decision email failed");
  }
}

export async function sendReportReminder(
  toEmail: string,
  referenceCode: string,
  projectTitle: string,
  reportLink: string,
  daysUntilDue: number
) {
  const resend = getResend();
  const from = getFromEmail();

  const urgency =
    daysUntilDue > 0
      ? `Your final report is due in ${daysUntilDue} days.`
      : daysUntilDue === 0
        ? "Your final report is due today."
        : `Your final report is ${Math.abs(daysUntilDue)} days overdue.`;

  const html = `
    <h2>Final Report Reminder</h2>
    <p>${urgency}</p>
    <p><strong>Project:</strong> ${escapeHtml(projectTitle)} (${escapeHtml(referenceCode)})</p>
    <p>Please submit your final report using the link below:</p>
    <p><a href="${escapeHtml(reportLink)}">Submit Final Report</a></p>
    <p>If you have questions about the report requirements, please contact FCAT.</p>
    <p>— Fundación para la Conservación de los Andes Tropicales</p>
  `;

  const text = `Final Report Reminder\n\n${urgency}\n\nProject: ${projectTitle} (${referenceCode})\n\nSubmit your final report: ${reportLink}\n\n— Fundación para la Conservación de los Andes Tropicales`;

  try {
    const { error } = await resend.emails.send({
      from,
      to: [toEmail],
      subject: `FCAT Final Report ${daysUntilDue <= 0 ? "Overdue" : "Reminder"} — ${referenceCode}`,
      html,
      text,
    });
    if (error) {
      log.error({ err: error }, "[ResearchApp] Report reminder Resend error");
    }
  } catch (err) {
    log.error({ err }, "[ResearchApp] Report reminder failed");
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
