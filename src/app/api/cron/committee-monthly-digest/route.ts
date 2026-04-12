import { NextResponse, type NextRequest } from "next/server";
import { sql, eq, and, gte, lte, between } from "drizzle-orm";
import { Resend } from "resend";
import { db } from "@/db";
import { researchApplications, researchReports } from "@/db/schema";
import { verifyCronSecret } from "@/lib/cron-auth";
import { getCommitteeEmails } from "@/lib/research-applications/emails";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/**
 * Cron: monthly committee digest.
 *
 * Runs on the 1st of each month. Summarizes:
 * - Applications submitted last month
 * - Reports due this month
 * - Reports submitted last month
 * - Overdue reports
 */
export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const thisMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

  const lastMonthStartStr = lastMonthStart.toISOString().split("T")[0];
  const thisMonthStartStr = thisMonthStart.toISOString().split("T")[0];
  const thisMonthEndStr = thisMonthEnd.toISOString().split("T")[0];

  // Applications submitted last month
  const newApps = db
    .select()
    .from(researchApplications)
    .where(
      and(
        gte(researchApplications.createdAt, lastMonthStart),
        lte(researchApplications.createdAt, thisMonthStart)
      )
    )
    .all();

  // Reports due this month
  const reportsDueThisMonth = db
    .select()
    .from(researchApplications)
    .where(
      sql`${researchApplications.finalReportDueDate} BETWEEN ${thisMonthStartStr} AND ${thisMonthEndStr}`
    )
    .all();

  // Reports submitted last month
  const reportsSubmitted = db
    .select()
    .from(researchReports)
    .where(
      and(
        gte(researchReports.submittedAt, lastMonthStart),
        lte(researchReports.submittedAt, thisMonthStart)
      )
    )
    .all();

  // Overdue reports (accepted, due date past, no report)
  const reportedAppIds = new Set(
    db
      .select({ applicationId: researchReports.applicationId })
      .from(researchReports)
      .all()
      .map((r: { applicationId: number }) => r.applicationId)
  );

  const overdueApps = db
    .select()
    .from(researchApplications)
    .where(
      and(
        eq(researchApplications.status, "accepted"),
        sql`${researchApplications.finalReportDueDate} < ${thisMonthStartStr}`
      )
    )
    .all()
    .filter((a) => !reportedAppIds.has(a.id));

  // Send digest
  const to = await getCommitteeEmails();
  if (to.length === 0) {
    log.warn("[monthly-digest] No committee emails found");
    return NextResponse.json({ ok: true, skipped: "no recipients" });
  }

  const monthName = lastMonthStart.toLocaleDateString("es-EC", {
    month: "long",
    year: "numeric",
  });

  const html = `
    <h2>Resumen Mensual — Aplicaciones de Investigadores</h2>
    <p>Resumen para: <strong>${monthName}</strong></p>

    <h3>Nuevas Aplicaciones (${newApps.length})</h3>
    ${
      newApps.length > 0
        ? `<ul>${newApps.map((a) => `<li>${esc(a.projectTitle)} — ${esc(a.piFullName)} (${a.referenceCode ?? "#" + a.id})</li>`).join("")}</ul>`
        : "<p>Ninguna</p>"
    }

    <h3>Informes que Vencen este Mes (${reportsDueThisMonth.length})</h3>
    ${
      reportsDueThisMonth.length > 0
        ? `<ul>${reportsDueThisMonth.map((a) => `<li>${esc(a.projectTitle)} — vence: ${a.finalReportDueDate}</li>`).join("")}</ul>`
        : "<p>Ninguno</p>"
    }

    <h3>Informes Entregados (${reportsSubmitted.length})</h3>
    ${reportsSubmitted.length > 0 ? `<p>${reportsSubmitted.length} informe(s) recibido(s)</p>` : "<p>Ninguno</p>"}

    <h3>Informes Vencidos (${overdueApps.length})</h3>
    ${
      overdueApps.length > 0
        ? `<ul>${overdueApps.map((a) => `<li>${esc(a.projectTitle)} — vencido: ${a.finalReportDueDate}</li>`).join("")}</ul>`
        : "<p>Ninguno</p>"
    }

    <p><a href="${process.env.NEXT_PUBLIC_SITE_URL ?? "https://portal.fcat-ecuador.org"}/research-applications">Ver todas las aplicaciones</a></p>
  `;

  const text = `Resumen Mensual — Aplicaciones de Investigadores\n\nNuevas: ${newApps.length}\nInformes por vencer: ${reportsDueThisMonth.length}\nEntregados: ${reportsSubmitted.length}\nVencidos: ${overdueApps.length}`;

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const from =
      process.env.RESEARCH_APP_FROM_EMAIL ??
      process.env.RESEND_FROM_EMAIL ??
      "portal@fcat-ecuador.org";

    const { error } = await resend.emails.send({
      from,
      to,
      subject: `Resumen mensual — Aplicaciones de Investigadores (${monthName})`,
      html,
      text,
    });

    if (error) {
      log.error({ err: error }, "[monthly-digest] Resend error");
    } else {
      log.info({ to }, "[monthly-digest] Digest sent");
    }
  } catch (err) {
    log.error({ err }, "[monthly-digest] Email failed");
  }

  return NextResponse.json({
    ok: true,
    stats: {
      newApps: newApps.length,
      reportsDue: reportsDueThisMonth.length,
      reportsSubmitted: reportsSubmitted.length,
      overdue: overdueApps.length,
    },
  });
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
