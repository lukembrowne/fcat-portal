"use server";

import crypto from "crypto";
import { headers } from "next/headers";
import { eq, and, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  researchApplications,
  researchReports,
} from "@/db/schema";
import { validateUploads } from "@/lib/upload-validation";
import {
  uploadFileToSharedDrive,
  getOrCreateApplicationFolder,
  deleteDriveFile,
  type UploadedFileInfo,
} from "@/lib/drive-client";
import type { ActionResult } from "@/lib/types";
import { log } from "@/lib/log";

/**
 * Validate a report token and return the application if valid.
 * Does NOT consume the token (allows page reloads).
 */
export async function validateReportToken(token: string) {
  const now = new Date().toISOString();

  const app = db
    .select()
    .from(researchApplications)
    .where(
      and(
        eq(researchApplications.reportSubmitToken, token),
        sql`${researchApplications.reportSubmitTokenExpiresAt} > ${now}`
      )
    )
    .get();

  if (!app) return null;

  // Check if report already submitted
  const existing = db
    .select({ id: researchReports.id })
    .from(researchReports)
    .where(eq(researchReports.applicationId, app.id))
    .get();

  return { app, hasReport: !!existing };
}

/**
 * Submit a final report via the magic token link.
 */
export async function submitFinalReport(
  formData: FormData,
  token: string
): Promise<ActionResult> {
  try {
    const headerList = await headers();
    const ip =
      headerList.get("x-real-ip") ??
      headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      null;

    const now = new Date().toISOString();

    // Validate token in a single query (prevents TOCTOU)
    const app = db
      .select()
      .from(researchApplications)
      .where(
        and(
          eq(researchApplications.reportSubmitToken, token),
          sql`${researchApplications.reportSubmitTokenExpiresAt} > ${now}`,
          eq(researchApplications.status, "accepted")
        )
      )
      .get();

    if (!app) {
      return { success: false, error: "Invalid or expired link." };
    }

    // Check no report already submitted
    const existing = db
      .select({ id: researchReports.id })
      .from(researchReports)
      .where(eq(researchReports.applicationId, app.id))
      .get();

    if (existing) {
      return { success: false, error: "A report has already been submitted." };
    }

    const summary = formData.get("summary");
    const summaryText = typeof summary === "string" ? summary.trim() : null;

    // Validate files
    const fileEntries: File[] = [];
    for (const entry of formData.getAll("reportFiles")) {
      if (entry instanceof File && entry.size > 0) {
        fileEntries.push(entry);
      }
    }

    if (fileEntries.length === 0) {
      return {
        success: false,
        error: "At least one PDF file is required for the final report.",
      };
    }

    const validation = await validateUploads(fileEntries, "reportFiles");
    if ("errors" in validation) {
      return {
        success: false,
        error: validation.errors[0]?.message ?? "File validation failed",
      };
    }

    // Upload files to Drive (into the application's folder)
    const folderName = app.referenceCode ?? `app-${app.id}`;
    let parentFolderId: string;
    try {
      parentFolderId = await getOrCreateApplicationFolder(folderName);
    } catch (err) {
      log.error({ err }, "[ReportSubmit] Failed to get Drive folder");
      return {
        success: false,
        error: "Unable to process your report. Please try again.",
      };
    }

    const uploadedFiles: UploadedFileInfo[] = [];
    const uploadedIds: string[] = [];

    for (const file of validation.files) {
      try {
        const driveFile = await uploadFileToSharedDrive(
          file.buffer,
          `Final Report - ${file.sanitizedName}`,
          file.mimeType,
          parentFolderId
        );
        uploadedFiles.push(driveFile);
        uploadedIds.push(driveFile.id);
      } catch (err) {
        log.error({ err }, "[ReportSubmit] Drive upload failed");
        for (const id of uploadedIds) {
          try { await deleteDriveFile(id); } catch { /* best-effort */ }
        }
        return {
          success: false,
          error: "Unable to process your report. Please try again.",
        };
      }
    }

    // Insert report + consume token (sync transaction)
    db.transaction(() => {
      db.insert(researchReports)
        .values({
          applicationId: app.id,
          summary: summaryText,
          driveFilesJson: JSON.stringify(uploadedFiles),
          submitterIp: ip,
        })
        .run();

      // Consume token
      db.update(researchApplications)
        .set({
          reportSubmitToken: null,
          reportSubmitTokenExpiresAt: null,
          updatedAt: new Date(),
        })
        .where(eq(researchApplications.id, app.id))
        .run();
    });

    // Send confirmation email (best-effort)
    try {
      const { Resend } = await import("resend");
      const resend = new Resend(process.env.RESEND_API_KEY);
      const from =
        process.env.RESEARCH_APP_FROM_EMAIL ??
        process.env.RESEND_FROM_EMAIL ??
        "portal@fcat-ecuador.org";

      await resend.emails.send({
        from,
        to: [app.piEmail],
        subject: `Final Report Received — ${app.referenceCode}`,
        html: `<h2>Final Report Received</h2><p>Thank you for submitting your final report for "${app.projectTitle}" (${app.referenceCode}).</p><p>��� FCAT</p>`,
        text: `Final Report Received\n\nThank you for submitting your final report for "${app.projectTitle}" (${app.referenceCode}).\n\n— FCAT`,
      });
    } catch (err) {
      log.error({ err }, "[ReportSubmit] Confirmation email failed");
    }

    log.info(
      { applicationId: app.id, referenceCode: app.referenceCode },
      "[ReportSubmit] Final report submitted"
    );

    return { success: true, data: undefined };
  } catch (err) {
    log.error({ err }, "[ReportSubmit] Unexpected error");
    return {
      success: false,
      error: "Unable to process your report. Please try again.",
    };
  }
}

/**
 * Re-issue a report token for an applicant who lost their link.
 */
export async function reissueReportToken(
  email: string
): Promise<ActionResult<{ sent: boolean }>> {
  const apps = db
    .select()
    .from(researchApplications)
    .where(
      and(
        eq(researchApplications.piEmail, email.toLowerCase().trim()),
        eq(researchApplications.status, "accepted")
      )
    )
    .all();

  // Filter to apps without a report
  const reportedIds = new Set(
    db
      .select({ applicationId: researchReports.applicationId })
      .from(researchReports)
      .all()
      .map((r: { applicationId: number }) => r.applicationId)
  );

  const eligible = apps.filter((a) => !reportedIds.has(a.id));

  if (eligible.length === 0) {
    // Don't reveal whether the email exists
    return { success: true, data: { sent: true } };
  }

  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://portal.fcat-ecuador.org";

  for (const app of eligible) {
    const token = crypto.randomBytes(32).toString("base64url");
    const dueMs = app.finalReportDueDate
      ? new Date(app.finalReportDueDate).getTime()
      : Date.now();
    const expiresAt = new Date(dueMs + 60 * 24 * 60 * 60 * 1000).toISOString();

    db.update(researchApplications)
      .set({ reportSubmitToken: token, reportSubmitTokenExpiresAt: expiresAt })
      .where(eq(researchApplications.id, app.id))
      .run();

    try {
      const { sendReportReminder } = await import(
        "@/lib/research-applications/emails"
      );
      await sendReportReminder(
        app.piEmail,
        app.referenceCode ?? `#${app.id}`,
        app.projectTitle,
        `${siteUrl}/public/report/${token}`,
        0
      );
    } catch (err) {
      log.error({ err }, "[ReportSubmit] Re-issue email failed");
    }
  }

  return { success: true, data: { sent: true } };
}
