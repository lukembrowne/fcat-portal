import { NextResponse, type NextRequest } from "next/server";
import { verifyCronSecret } from "@/lib/cron-auth";
import { log } from "@/lib/log";
import { recordEvent } from "@/lib/system-events";
import {
  getGrantsRecipients,
  getGrantsResend,
  getGrantsFromEmail,
  buildMonthlyDigestData,
  renderMonthlyDigestHtml,
} from "@/lib/grants/emails";

export const dynamic = "force-dynamic";

/**
 * Cron: monthly grants digest (1st of month). Reproduces the retired n8n email —
 * pending/funded summary, In Prep, Due in 30 days, Awaiting Decision, yearly stats.
 * Auth: Bearer CRON_SECRET only (no XFF guard — the in-container call carries XFF).
 */
export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTime = Date.now();
  const portalUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://portal.fcat-ecuador.org";

  const to = await getGrantsRecipients();
  if (to.length === 0) {
    await recordEvent({
      source: "grants",
      projectId: "grants",
      eventType: "grants_monthly_digest",
      severity: "warn",
      summary: "Monthly grant digest skipped — no recipients",
      durationMs: Date.now() - startTime,
    });
    return NextResponse.json({ ok: true, skipped: "no recipients" });
  }

  const data = buildMonthlyDigestData();
  const html = renderMonthlyDigestHtml(data, portalUrl);

  try {
    const resend = getGrantsResend();
    const { error } = await resend.emails.send({
      from: getGrantsFromEmail(),
      to,
      subject: `Monthly Grant Summary — ${new Date().toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })}`,
      html,
    });
    if (error) {
      log.error({ err: error }, "[grants-monthly] Resend error");
      await recordEvent({
        source: "grants",
        projectId: "grants",
        eventType: "grants_monthly_digest",
        severity: "error",
        summary: "Failed to send the monthly grant digest",
        durationMs: Date.now() - startTime,
        details: { error: String(error) },
      });
      return NextResponse.json({ ok: false, error: "send failed" }, { status: 502 });
    }
  } catch (err) {
    log.error({ err }, "[grants-monthly] exception");
    return NextResponse.json({ ok: false, error: "exception" }, { status: 500 });
  }

  await recordEvent({
    source: "grants",
    projectId: "grants",
    eventType: "grants_monthly_digest",
    severity: "success",
    summary: `Monthly grant digest sent to ${to.length} recipient(s)`,
    durationMs: Date.now() - startTime,
    details: {
      recipients: to.length,
      pending: data.pendingCount,
      dueSoon: data.dueSoon.length,
    },
  });

  return NextResponse.json({ ok: true, recipients: to.length });
}
