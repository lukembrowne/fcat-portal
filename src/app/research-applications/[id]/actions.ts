"use server";

import crypto from "crypto";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/db";
import {
  researchApplications,
  researchApplicationReferences,
  researchApplicationComments,
  researchReports,
  type ResearchApplicationStatus,
} from "@/db/schema";
import { requirePermission, getCurrentUser } from "@/lib/auth";
import { assertTransition } from "@/lib/research-applications/transitions";
import type { ActionResult } from "@/lib/types";
import { log } from "@/lib/log";

export async function getApplicationDetail(id: number) {
  await requirePermission("researcher-applications", "viewer");

  const app = db
    .select()
    .from(researchApplications)
    .where(eq(researchApplications.id, id))
    .get();

  if (!app) return null;

  const references = db
    .select()
    .from(researchApplicationReferences)
    .where(eq(researchApplicationReferences.applicationId, id))
    .all();

  const comments = db
    .select()
    .from(researchApplicationComments)
    .where(eq(researchApplicationComments.applicationId, id))
    .orderBy(researchApplicationComments.createdAt)
    .all();

  const reports = db
    .select()
    .from(researchReports)
    .where(eq(researchReports.applicationId, id))
    .all();

  return { ...app, references, comments, reports };
}

export type ApplicationDetail = NonNullable<
  Awaited<ReturnType<typeof getApplicationDetail>>
>;

export async function updateApplicationStatus(
  id: number,
  newStatus: ResearchApplicationStatus,
  notes: string | null
): Promise<ActionResult> {
  await requirePermission("researcher-applications", "editor");

  const app = db
    .select({
      status: researchApplications.status,
      piEmail: researchApplications.piEmail,
      referenceCode: researchApplications.referenceCode,
      projectTitle: researchApplications.projectTitle,
      projectEndDate: researchApplications.projectEndDate,
      finalReportDueDate: researchApplications.finalReportDueDate,
    })
    .from(researchApplications)
    .where(eq(researchApplications.id, id))
    .get();

  if (!app) return { success: false, error: "Aplicación no encontrada" };

  try {
    assertTransition(app.status, newStatus);
  } catch {
    return { success: false, error: "Transición de estado inválida" };
  }

  const isTerminal = ["accepted", "rejected"].includes(newStatus);

  // Auto-set final report due date to 3 months after project end date on acceptance
  let autoReportDueDate: string | undefined;
  if (newStatus === "accepted" && !app.finalReportDueDate && app.projectEndDate) {
    const endDate = new Date(app.projectEndDate);
    endDate.setMonth(endDate.getMonth() + 3);
    autoReportDueDate = endDate.toISOString().split("T")[0];
  }

  // Auto-generate report token on acceptance
  let reportToken: string | undefined;
  let reportTokenExpiresAt: string | undefined;
  if (newStatus === "accepted") {
    reportToken = crypto.randomBytes(32).toString("base64url");
    const dueMs = autoReportDueDate
      ? new Date(autoReportDueDate).getTime()
      : app.finalReportDueDate
        ? new Date(app.finalReportDueDate).getTime()
        : Date.now();
    reportTokenExpiresAt = new Date(
      dueMs + 60 * 24 * 60 * 60 * 1000
    ).toISOString(); // due + 60 days
  }

  db.update(researchApplications)
    .set({
      status: newStatus,
      decisionNotes: notes ?? app.status,
      ...(isTerminal ? { decidedAt: new Date() } : {}),
      ...(autoReportDueDate ? { finalReportDueDate: autoReportDueDate } : {}),
      ...(reportToken
        ? {
            reportSubmitToken: reportToken,
            reportSubmitTokenExpiresAt: reportTokenExpiresAt,
          }
        : {}),
      updatedAt: new Date(),
      // Clear reminder timestamps when moving back to under_review
      ...(newStatus === "under_review"
        ? {
            reminder30SentAt: null,
            reminder0SentAt: null,
            reminderOverdueSentAt: null,
            reportSubmitToken: null,
            reportSubmitTokenExpiresAt: null,
          }
        : {}),
    })
    .where(eq(researchApplications.id, id))
    .run();

  // Send decision email only for accepted applications
  if (newStatus === "accepted") {
    const siteUrl =
      process.env.NEXT_PUBLIC_SITE_URL ?? "https://portal.fcat-ecuador.org";
    const reportLink = reportToken
      ? `${siteUrl}/public/report/${reportToken}`
      : null;
    const reportDueDate = autoReportDueDate ?? app.finalReportDueDate ?? null;

    try {
      const { sendDecisionNotification } = await import(
        "@/lib/research-applications/emails"
      );
      await sendDecisionNotification(
        app.piEmail,
        app.referenceCode ?? `#${id}`,
        app.projectTitle,
        "accepted",
        null,
        reportLink,
        reportDueDate
      );
    } catch (err) {
      log.error({ err }, "[ResearchApp] Decision email failed");
    }
  }

  revalidatePath(`/research-applications/${id}`);
  revalidatePath("/research-applications");
  return { success: true, data: undefined };
}

export async function setPrimaryReviewer(
  id: number,
  email: string
): Promise<ActionResult> {
  await requirePermission("researcher-applications", "editor");

  db.update(researchApplications)
    .set({ primaryReviewerEmail: email, updatedAt: new Date() })
    .where(eq(researchApplications.id, id))
    .run();

  revalidatePath(`/research-applications/${id}`);
  return { success: true, data: undefined };
}

export async function setFinalReportDueDate(
  id: number,
  date: string
): Promise<ActionResult> {
  await requirePermission("researcher-applications", "editor");

  // Reset reminder timestamps when due date changes
  db.update(researchApplications)
    .set({
      finalReportDueDate: date,
      reminder30SentAt: null,
      reminder0SentAt: null,
      reminderOverdueSentAt: null,
      reportSubmitToken: null,
      reportSubmitTokenExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(eq(researchApplications.id, id))
    .run();

  revalidatePath(`/research-applications/${id}`);
  return { success: true, data: undefined };
}

export async function addComment(
  id: number,
  body: string
): Promise<ActionResult> {
  await requirePermission("researcher-applications", "editor");
  const user = await getCurrentUser();
  if (!user) return { success: false, error: "No autorizado" };

  if (!body.trim()) {
    return { success: false, error: "El comentario no puede estar vacío" };
  }

  db.insert(researchApplicationComments)
    .values({
      applicationId: id,
      authorEmail: user.email,
      body: body.trim(),
    })
    .run();

  revalidatePath(`/research-applications/${id}`);
  return { success: true, data: undefined };
}

/**
 * Generate (or refresh) a report submission token for this application.
 * Returns the full public URL so the committee can copy/share it.
 */
export async function generateReportLink(
  id: number
): Promise<ActionResult<{ url: string }>> {
  await requirePermission("researcher-applications", "editor");

  const app = db
    .select({
      status: researchApplications.status,
      finalReportDueDate: researchApplications.finalReportDueDate,
      reportSubmitToken: researchApplications.reportSubmitToken,
      reportSubmitTokenExpiresAt: researchApplications.reportSubmitTokenExpiresAt,
    })
    .from(researchApplications)
    .where(eq(researchApplications.id, id))
    .get();

  if (!app) return { success: false, error: "Aplicación no encontrada" };
  if (app.status !== "accepted") {
    return {
      success: false,
      error: "Solo se puede generar un enlace para aplicaciones aceptadas",
    };
  }

  // Check if a report already exists
  const existing = db
    .select({ id: researchReports.id })
    .from(researchReports)
    .where(eq(researchReports.applicationId, id))
    .get();

  if (existing) {
    return { success: false, error: "Ya se entregó el informe final" };
  }

  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://portal.fcat-ecuador.org";

  // Reuse existing token if it hasn't expired yet
  if (app.reportSubmitToken && app.reportSubmitTokenExpiresAt) {
    const expiresAt = new Date(app.reportSubmitTokenExpiresAt);
    if (expiresAt > new Date()) {
      const url = `${siteUrl}/public/report/${app.reportSubmitToken}`;
      return { success: true, data: { url } };
    }
  }

  // Generate a new token only if none exists or the existing one expired
  const token = crypto.randomBytes(32).toString("base64url");
  const dueMs = app.finalReportDueDate
    ? new Date(app.finalReportDueDate).getTime()
    : Date.now();
  const expiresAt = new Date(
    dueMs + 60 * 24 * 60 * 60 * 1000
  ).toISOString(); // due + 60 days

  db.update(researchApplications)
    .set({
      reportSubmitToken: token,
      reportSubmitTokenExpiresAt: expiresAt,
      updatedAt: new Date(),
    })
    .where(eq(researchApplications.id, id))
    .run();

  const url = `${siteUrl}/public/report/${token}`;

  revalidatePath(`/research-applications/${id}`);
  return { success: true, data: { url } };
}

/**
 * Re-send the report submission link to the applicant's email.
 */
export async function resendReportLink(
  id: number
): Promise<ActionResult> {
  await requirePermission("researcher-applications", "editor");

  const app = db
    .select({
      piEmail: researchApplications.piEmail,
      referenceCode: researchApplications.referenceCode,
      projectTitle: researchApplications.projectTitle,
      reportSubmitToken: researchApplications.reportSubmitToken,
      finalReportDueDate: researchApplications.finalReportDueDate,
    })
    .from(researchApplications)
    .where(eq(researchApplications.id, id))
    .get();

  if (!app) return { success: false, error: "Aplicación no encontrada" };
  if (!app.reportSubmitToken) {
    return { success: false, error: "No hay enlace generado. Genere uno primero." };
  }

  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://portal.fcat-ecuador.org";
  const reportLink = `${siteUrl}/public/report/${app.reportSubmitToken}`;

  const dueDate = app.finalReportDueDate
    ? new Date(app.finalReportDueDate)
    : null;
  const diffDays = dueDate
    ? Math.round((dueDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : 0;

  try {
    const { sendReportReminder } = await import(
      "@/lib/research-applications/emails"
    );
    await sendReportReminder(
      app.piEmail,
      app.referenceCode ?? `#${id}`,
      app.projectTitle,
      reportLink,
      diffDays
    );
  } catch (err) {
    log.error({ err, id }, "[ResearchApp] Resend report link failed");
    return { success: false, error: "Error al enviar el email" };
  }

  return { success: true, data: undefined };
}

export async function deleteApplication(id: number): Promise<ActionResult> {
  await requirePermission("researcher-applications", "editor");

  const app = db
    .select({ id: researchApplications.id, referenceCode: researchApplications.referenceCode })
    .from(researchApplications)
    .where(eq(researchApplications.id, id))
    .get();

  if (!app) return { success: false, error: "Aplicación no encontrada" };

  // Cascade deletes handle references, comments, reports via FK constraints
  db.delete(researchApplications)
    .where(eq(researchApplications.id, id))
    .run();

  log.info({ id, referenceCode: app.referenceCode }, "[ResearchApp] Application deleted");

  revalidatePath("/research-applications");
  return { success: true, data: undefined };
}
