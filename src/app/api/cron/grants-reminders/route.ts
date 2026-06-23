import { NextResponse, type NextRequest } from "next/server";
import { verifyCronSecret } from "@/lib/cron-auth";
import { log } from "@/lib/log";
import { recordEvent } from "@/lib/system-events";
import {
  getGrantsRecipients,
  getGrantsResend,
  getGrantsFromEmail,
  getDueReminders,
  markReminded,
  renderRemindersHtml,
} from "@/lib/grants/emails";

export const dynamic = "force-dynamic";

/**
 * Cron: daily two-tier deadline reminders. Emails active grants that have crossed
 * a new reminder threshold (30 then 14 days out) since they were last notified.
 * Send-then-mark: remindersSent/lastNotifiedAt are stamped only after a successful
 * send, so a crash re-sends next day rather than silently skipping.
 * Auth: Bearer CRON_SECRET only (no XFF guard).
 */
export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  const portalUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://portal.fcat-ecuador.org";

  const due = getDueReminders();
  if (due.length === 0) {
    return NextResponse.json({ ok: true, reminded: 0 });
  }

  const to = await getGrantsRecipients();
  if (to.length === 0) {
    await recordEvent({
      source: "grants",
      projectId: "grants",
      eventType: "grants_reminders",
      severity: "warn",
      summary: `${due.length} grant(s) with an upcoming deadline but no recipients`,
      durationMs: Date.now() - startTime,
    });
    return NextResponse.json({ ok: true, reminded: 0, skipped: "no recipients" });
  }

  const html = renderRemindersHtml(due, portalUrl);

  try {
    const resend = getGrantsResend();
    const { error } = await resend.emails.send({
      from: getGrantsFromEmail(),
      to,
      subject: `⏰ ${due.length} grant(s) with an upcoming deadline`,
      html,
    });
    if (error) {
      log.error({ err: error }, "[grants-reminders] Resend error");
      // Do NOT mark as notified — let the next run retry.
      await recordEvent({
        source: "grants",
        projectId: "grants",
        eventType: "grants_reminders",
        severity: "error",
        summary: "Failed to send grant reminders",
        durationMs: Date.now() - startTime,
        details: { error: String(error) },
      });
      return NextResponse.json({ ok: false, error: "send failed" }, { status: 502 });
    }
  } catch (err) {
    log.error({ err }, "[grants-reminders] exception");
    return NextResponse.json({ ok: false, error: "exception" }, { status: 500 });
  }

  // Mark only after a confirmed successful send — record the level each grant
  // reached so the next (more urgent) threshold can still fire later.
  await markReminded(due.map((g) => ({ id: g.id, level: g.targetLevel })));

  await recordEvent({
    source: "grants",
    projectId: "grants",
    eventType: "grants_reminders",
    severity: "success",
    summary: `Reminders sent: ${due.length} grant(s) to ${to.length} recipient(s)`,
    durationMs: Date.now() - startTime,
    details: { grants: due.length, recipients: to.length },
  });

  return NextResponse.json({ ok: true, reminded: due.length });
}
