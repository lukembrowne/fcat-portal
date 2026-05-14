import { NextResponse, type NextRequest } from "next/server";
import crypto from "crypto";
import { sql, eq, and, isNull, lte, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { researchApplications, researchReports } from "@/db/schema";
import { verifyCronSecret } from "@/lib/cron-auth";
import { sendReportReminder } from "@/lib/research-applications/emails";
import { log } from "@/lib/log";
import { recordEvent } from "@/lib/system-events";

export const dynamic = "force-dynamic";

/**
 * Cron: daily check for final report reminders.
 *
 * Queries accepted applications whose final_report_due_date is approaching
 * and sends reminders at T-30, T-0, and T+7. Uses nullable timestamp columns
 * as sent flags — if null, the reminder hasn't been sent yet.
 */
export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  const siteUrl =
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://portal.fcat-ecuador.org";
  const now = new Date();
  const today = now.toISOString().split("T")[0]; // YYYY-MM-DD

  // Find accepted applications with a due date set, no report yet
  const reportedAppIds = db
    .select({ applicationId: researchReports.applicationId })
    .from(researchReports)
    .all()
    .map((r: { applicationId: number }) => r.applicationId);

  const apps = db
    .select()
    .from(researchApplications)
    .where(
      and(
        eq(researchApplications.status, "accepted"),
        isNotNull(researchApplications.finalReportDueDate)
      )
    )
    .all()
    .filter((a) => !reportedAppIds.includes(a.id));

  let sent30 = 0;
  let sent0 = 0;
  let sentOverdue = 0;

  for (const app of apps) {
    const dueDate = app.finalReportDueDate!;
    const dueMs = new Date(dueDate).getTime();
    const diffDays = Math.round((dueMs - now.getTime()) / (1000 * 60 * 60 * 24));

    // Generate or reuse report token
    let token = app.reportSubmitToken;
    if (!token) {
      token = crypto.randomBytes(32).toString("base64url");
      const expiresAt = new Date(dueMs + 60 * 24 * 60 * 60 * 1000) // due + 60 days
        .toISOString();
      db.update(researchApplications)
        .set({
          reportSubmitToken: token,
          reportSubmitTokenExpiresAt: expiresAt,
        })
        .where(eq(researchApplications.id, app.id))
        .run();
    }

    const reportLink = `${siteUrl}/public/report/${token}`;

    // T-30: due in <= 30 days
    if (diffDays <= 30 && !app.reminder30SentAt) {
      await sendReportReminder(
        app.piEmail,
        app.referenceCode ?? `#${app.id}`,
        app.projectTitle,
        reportLink,
        diffDays
      );
      db.update(researchApplications)
        .set({ reminder30SentAt: now })
        .where(eq(researchApplications.id, app.id))
        .run();
      sent30++;
    }

    // T-0: due today or past
    if (diffDays <= 0 && !app.reminder0SentAt) {
      await sendReportReminder(
        app.piEmail,
        app.referenceCode ?? `#${app.id}`,
        app.projectTitle,
        reportLink,
        diffDays
      );
      db.update(researchApplications)
        .set({ reminder0SentAt: now })
        .where(eq(researchApplications.id, app.id))
        .run();
      sent0++;
    }

    // T+7: overdue by 7+ days
    if (diffDays <= -7 && !app.reminderOverdueSentAt) {
      await sendReportReminder(
        app.piEmail,
        app.referenceCode ?? `#${app.id}`,
        app.projectTitle,
        reportLink,
        diffDays
      );
      db.update(researchApplications)
        .set({ reminderOverdueSentAt: now })
        .where(eq(researchApplications.id, app.id))
        .run();
      sentOverdue++;
    }
  }

  // Purge submitter_ip older than 90 days
  const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
  db.update(researchApplications)
    .set({ submitterIp: null })
    .where(
      and(
        isNotNull(researchApplications.submitterIp),
        lte(researchApplications.createdAt, ninetyDaysAgo)
      )
    )
    .run();

  const total = sent30 + sent0 + sentOverdue;
  log.info(
    { sent30, sent0, sentOverdue },
    `[research-reminders] Sent ${total} reminders`
  );

  await recordEvent({
    source: "cron",
    eventType: "cron_research_reminders",
    severity: "success",
    actorEmail: null,
    summary: `Recordatorios de informes enviados · T-30: ${sent30}, T-0: ${sent0}, vencidos: ${sentOverdue}`,
    durationMs: Date.now() - startTime,
    details: { total, sent30, sent0, sentOverdue, today },
  });

  return NextResponse.json({
    ok: true,
    sent: { t30: sent30, t0: sent0, overdue: sentOverdue },
  });
}
