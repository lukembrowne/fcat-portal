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
    <p>The FCAT Scientific Committee will review your application and notify you of their decision. You will receive an email when a decision has been made. Please keep your reference code for future correspondence.</p>
    <p><strong>Final Report Requirement:</strong> If your application is approved, you will be required to submit a final report within 3 months of your project's completion date. A link to the report submission form will be included in your approval email and reminder emails will be sent as your deadline approaches.</p>
    <p>If you have any questions, please contact Luis Carrasco at <a href="mailto:luis.carrasco@fcat-ecuador.org">luis.carrasco@fcat-ecuador.org</a>.</p>
    <p style="color: #666; font-size: 12px;">This is an automated message from the FCAT Research Portal.</p>
    <p>\u2014 FCAT (Fundaci\u00f3n para la Conservaci\u00f3n de los Andes Tropicales)</p>
  `;

  const text = `Application Received\n\nThank you for submitting your research application to FCAT.\n\nReference Code: ${referenceCode}\nProject: ${projectTitle}\n\nThe FCAT Scientific Committee will review your application and notify you of their decision. You will receive an email when a decision has been made. Please keep your reference code for future correspondence.\n\nFinal Report Requirement: If your application is approved, you will be required to submit a final report within 3 months of your project's completion date. A link to the report submission form will be included in your approval email and reminder emails will be sent as your deadline approaches.\n\nIf you have any questions, please contact Luis Carrasco at luis.carrasco@fcat-ecuador.org.\n\nThis is an automated message from the FCAT Research Portal.\n\n\u2014 FCAT (Fundaci\u00f3n para la Conservaci\u00f3n de los Andes Tropicales)`;

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
  decision: "accepted",
  _notes: string | null,
  reportLink?: string | null,
  reportDueDate?: string | null
) {
  const resend = getResend();
  const from = getFromEmail();

  const reportSection = reportLink
    ? `
    <h3>Final Report Requirement</h3>
    <p>As part of your approval, you are required to submit a final report within 3 months of your project's completion date${reportDueDate ? ` (due by ${escapeHtml(reportDueDate)})` : ""}. Your report should summarize your methods, results, and conclusions in a format accessible to a general audience. When possible, please provide copies in both English and Spanish.</p>
    <p>You can submit your final report using this link:</p>
    <p><a href="${escapeHtml(reportLink)}">Submit Final Report</a></p>
    <p>You will also receive reminder emails as your deadline approaches.</p>`
    : "";

  const reportTextSection = reportLink
    ? `\n\nFinal Report Requirement\nAs part of your approval, you are required to submit a final report within 3 months of your project's completion date${reportDueDate ? ` (due by ${reportDueDate})` : ""}. Your report should summarize your methods, results, and conclusions in a format accessible to a general audience. When possible, please provide copies in both English and Spanish.\n\nSubmit your final report: ${reportLink}\n\nYou will also receive reminder emails as your deadline approaches.`
    : "";

  const html = `
    <h2>Application Approved</h2>
    <p>Your research application has been approved by the FCAT Scientific Committee.</p>
    <p><strong>Reference:</strong> ${escapeHtml(referenceCode)}</p>
    <p><strong>Project:</strong> ${escapeHtml(projectTitle)}</p>
    ${reportSection}
    <p>If you have any questions, please contact Luis Carrasco at <a href="mailto:luis.carrasco@fcat-ecuador.org">luis.carrasco@fcat-ecuador.org</a>.</p>
    <p style="color: #666; font-size: 12px;">This is an automated message from the FCAT Research Portal.</p>
    <p>\u2014 FCAT (Fundaci\u00f3n para la Conservaci\u00f3n de los Andes Tropicales)</p>
  `;

  const text = `Application Approved\n\nYour research application has been approved by the FCAT Scientific Committee.\n\nReference: ${referenceCode}\nProject: ${projectTitle}${reportTextSection}\n\nIf you have any questions, please contact Luis Carrasco at luis.carrasco@fcat-ecuador.org.\n\nThis is an automated message from the FCAT Research Portal.\n\n\u2014 FCAT (Fundaci\u00f3n para la Conservaci\u00f3n de los Andes Tropicales)`;

  try {
    const { error } = await resend.emails.send({
      from,
      to: [toEmail],
      subject: `FCAT Application Approved \u2014 ${referenceCode}`,
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
    <p>If you have questions about the report requirements, please contact Luis Carrasco at <a href="mailto:luis.carrasco@fcat-ecuador.org">luis.carrasco@fcat-ecuador.org</a>.</p>
    <p style="color: #666; font-size: 12px;">This is an automated message from the FCAT Research Portal.</p>
    <p>\u2014 FCAT (Fundaci\u00f3n para la Conservaci\u00f3n de los Andes Tropicales)</p>
  `;

  const text = `Final Report Reminder\n\n${urgency}\n\nProject: ${projectTitle} (${referenceCode})\n\nSubmit your final report: ${reportLink}\n\nIf you have questions about the report requirements, please contact Luis Carrasco at luis.carrasco@fcat-ecuador.org.\n\nThis is an automated message from the FCAT Research Portal.\n\n\u2014 FCAT (Fundaci\u00f3n para la Conservaci\u00f3n de los Andes Tropicales)`;

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
