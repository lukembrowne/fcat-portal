import { NextResponse, type NextRequest } from "next/server";
import { sql, eq, and, gte, lte } from "drizzle-orm";
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
 * - Reports due this month (excluding already-submitted)
 * - Reports submitted last month
 * - Overdue reports
 * - Active projects (accepted, report pending)
 * - Completed projects (report submitted)
 */
export async function POST(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const portalUrl =
    process.env.NEXT_PUBLIC_SITE_URL ?? "https://portal.fcat-ecuador.org";
  const now = new Date();
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const thisMonthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);

  const lastMonthStartStr = lastMonthStart.toISOString().split("T")[0];
  const thisMonthStartStr = thisMonthStart.toISOString().split("T")[0];
  const thisMonthEndStr = thisMonthEnd.toISOString().split("T")[0];

  // IDs of applications that have a submitted report — used to filter multiple sections
  const reportedAppIds = new Set(
    db
      .select({ applicationId: researchReports.applicationId })
      .from(researchReports)
      .all()
      .map((r: { applicationId: number }) => r.applicationId)
  );

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

  // Reports due this month (excluding already-submitted)
  const reportsDueThisMonth = db
    .select()
    .from(researchApplications)
    .where(
      sql`${researchApplications.finalReportDueDate} BETWEEN ${thisMonthStartStr} AND ${thisMonthEndStr}`
    )
    .all()
    .filter((a) => !reportedAppIds.has(a.id));

  // Reports submitted last month
  const reportsSubmittedRaw = db
    .select()
    .from(researchReports)
    .where(
      and(
        gte(researchReports.submittedAt, lastMonthStart),
        lte(researchReports.submittedAt, thisMonthStart)
      )
    )
    .all();

  // Enrich submitted reports with application data
  const reportsSubmitted = reportsSubmittedRaw.map((r) => {
    const app = db
      .select()
      .from(researchApplications)
      .where(eq(researchApplications.id, r.applicationId))
      .get();
    return { report: r, app };
  });

  // Overdue reports (accepted, due date past, no report)
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

  // Active projects (accepted, no report yet)
  const activeProjects = db
    .select()
    .from(researchApplications)
    .where(eq(researchApplications.status, "accepted"))
    .all()
    .filter((a) => !reportedAppIds.has(a.id));

  // Completed projects (have a submitted report)
  const completedProjects = db
    .select()
    .from(researchApplications)
    .all()
    .filter((a) => reportedAppIds.has(a.id));

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

  // Helper: link to an application
  const appLink = (id: number, text: string) =>
    `<a href="${portalUrl}/research-applications/${id}" style="color: #1F4E79; text-decoration: none;">${esc(text)}</a>`;

  // Helper: format date nicely
  const fmtDate = (d: string | null) => {
    if (!d) return "—";
    const date = new Date(d);
    return date.toLocaleDateString("es-EC", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  };

  // --- Build HTML email ---
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; max-width: 800px; margin: 0 auto; padding: 20px; background: #f5f5f5;">
  <div style="background: #fff; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">

    <!-- Header -->
    <div style="background: #1F4E79; color: #fff; padding: 24px 30px;">
      <h1 style="margin: 0; font-size: 22px; font-weight: 600;">Resumen Mensual &mdash; Aplicaciones de Investigadores</h1>
      <p style="margin: 8px 0 0; opacity: 0.85; font-size: 14px;">Resumen para: ${esc(monthName)}</p>
    </div>

    <!-- Summary boxes -->
    <div style="padding: 20px 30px 10px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr>
          <td style="padding: 0 6px 12px 0; width: 25%;">
            <div style="background: #EBF5FB; border-radius: 8px; padding: 16px; text-align: center;">
              <div style="font-size: 28px; font-weight: 700; color: #1F4E79;">${newApps.length}</div>
              <div style="font-size: 12px; color: #666; margin-top: 2px;">Nuevas</div>
            </div>
          </td>
          <td style="padding: 0 6px 12px; width: 25%;">
            <div style="background: #E8F5E9; border-radius: 8px; padding: 16px; text-align: center;">
              <div style="font-size: 28px; font-weight: 700; color: #2E7D32;">${activeProjects.length}</div>
              <div style="font-size: 12px; color: #666; margin-top: 2px;">Activas</div>
            </div>
          </td>
          <td style="padding: 0 6px 12px; width: 25%;">
            <div style="background: #FFF3E0; border-radius: 8px; padding: 16px; text-align: center;">
              <div style="font-size: 28px; font-weight: 700; color: #F57C00;">${reportsDueThisMonth.length}</div>
              <div style="font-size: 12px; color: #666; margin-top: 2px;">Vencen este mes</div>
            </div>
          </td>
          <td style="padding: 0 0 12px 6px; width: 25%;">
            <div style="background: ${overdueApps.length > 0 ? "#FFEBEE" : "#F5F5F5"}; border-radius: 8px; padding: 16px; text-align: center;">
              <div style="font-size: 28px; font-weight: 700; color: ${overdueApps.length > 0 ? "#C62828" : "#999"};">${overdueApps.length}</div>
              <div style="font-size: 12px; color: #666; margin-top: 2px;">Vencidas</div>
            </div>
          </td>
        </tr>
      </table>
    </div>

    <div style="padding: 0 30px 30px;">

      <!-- New Applications -->
      <h2 style="color: #1F4E79; font-size: 16px; margin: 24px 0 12px; padding-bottom: 8px; border-bottom: 2px solid #1F4E79;">
        Nuevas Aplicaciones (${newApps.length})
      </h2>
      ${
        newApps.length > 0
          ? `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size: 14px;">
              <tr style="background: #f8f9fa;">
                <th style="padding: 8px 12px; text-align: left; font-weight: 600; color: #555;">Proyecto</th>
                <th style="padding: 8px 12px; text-align: left; font-weight: 600; color: #555;">Investigador</th>
                <th style="padding: 8px 12px; text-align: left; font-weight: 600; color: #555;">Estado</th>
                <th style="padding: 8px 12px; text-align: left; font-weight: 600; color: #555;">Fecha</th>
              </tr>
              ${newApps
                .map(
                  (a) => `
              <tr style="border-bottom: 1px solid #eee;">
                <td style="padding: 10px 12px; border-bottom: 1px solid #eee;">${appLink(a.id, a.projectTitle)}</td>
                <td style="padding: 10px 12px; border-bottom: 1px solid #eee;">${esc(a.piFullName)}${a.piInstitution ? `<br><span style="color: #888; font-size: 12px;">${esc(a.piInstitution)}</span>` : ""}</td>
                <td style="padding: 10px 12px; border-bottom: 1px solid #eee;"><span style="display: inline-block; background: #E3F2FD; color: #1565C0; padding: 2px 8px; border-radius: 12px; font-size: 12px;">Enviada</span></td>
                <td style="padding: 10px 12px; border-bottom: 1px solid #eee; white-space: nowrap;">${fmtDate(a.createdAt.toISOString())}</td>
              </tr>`
                )
                .join("")}
            </table>`
          : `<p style="color: #888; font-style: italic; padding: 12px; background: #f8f9fa; border-radius: 6px;">Ninguna aplicaci\u00f3n nueva este mes.</p>`
      }

      <!-- Reports Due This Month -->
      <h2 style="color: #F57C00; font-size: 16px; margin: 28px 0 12px; padding-bottom: 8px; border-bottom: 2px solid #F57C00;">
        Informes que Vencen este Mes (${reportsDueThisMonth.length})
      </h2>
      ${
        reportsDueThisMonth.length > 0
          ? `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size: 14px;">
              <tr style="background: #FFF3E0;">
                <th style="padding: 8px 12px; text-align: left; font-weight: 600; color: #555;">Proyecto</th>
                <th style="padding: 8px 12px; text-align: left; font-weight: 600; color: #555;">Investigador</th>
                <th style="padding: 8px 12px; text-align: left; font-weight: 600; color: #555;">Vence</th>
              </tr>
              ${reportsDueThisMonth
                .map(
                  (a) => `
              <tr>
                <td style="padding: 10px 12px; border-bottom: 1px solid #eee;">${appLink(a.id, a.projectTitle)}<br><span style="color: #888; font-size: 12px;">${esc(a.referenceCode ?? `#${a.id}`)}</span></td>
                <td style="padding: 10px 12px; border-bottom: 1px solid #eee;">${esc(a.piFullName)}</td>
                <td style="padding: 10px 12px; border-bottom: 1px solid #eee; white-space: nowrap;"><span style="display: inline-block; background: #FFF3CD; color: #856404; padding: 2px 8px; border-radius: 12px; font-size: 12px;">${fmtDate(a.finalReportDueDate)}</span></td>
              </tr>`
                )
                .join("")}
            </table>`
          : `<p style="color: #888; font-style: italic; padding: 12px; background: #f8f9fa; border-radius: 6px;">Ning\u00fan informe por vencer este mes.</p>`
      }

      <!-- Overdue Reports -->
      ${
        overdueApps.length > 0
          ? `
      <h2 style="color: #C62828; font-size: 16px; margin: 28px 0 12px; padding-bottom: 8px; border-bottom: 2px solid #C62828;">
        Informes Vencidos (${overdueApps.length})
      </h2>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size: 14px;">
        <tr style="background: #FFEBEE;">
          <th style="padding: 8px 12px; text-align: left; font-weight: 600; color: #555;">Proyecto</th>
          <th style="padding: 8px 12px; text-align: left; font-weight: 600; color: #555;">Investigador</th>
          <th style="padding: 8px 12px; text-align: left; font-weight: 600; color: #555;">Ven\u00eda</th>
        </tr>
        ${overdueApps
          .map(
            (a) => `
        <tr>
          <td style="padding: 10px 12px; border-bottom: 1px solid #eee;">${appLink(a.id, a.projectTitle)}<br><span style="color: #888; font-size: 12px;">${esc(a.referenceCode ?? `#${a.id}`)}</span></td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #eee;">${esc(a.piFullName)}</td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #eee; white-space: nowrap;"><span style="display: inline-block; background: #F8D7DA; color: #721C24; padding: 2px 8px; border-radius: 12px; font-size: 12px;">${fmtDate(a.finalReportDueDate)}</span></td>
        </tr>`
          )
          .join("")}
      </table>`
          : ""
      }

      <!-- Reports Submitted Last Month -->
      <h2 style="color: #2E7D32; font-size: 16px; margin: 28px 0 12px; padding-bottom: 8px; border-bottom: 2px solid #2E7D32;">
        Informes Entregados el Mes Pasado (${reportsSubmitted.length})
      </h2>
      ${
        reportsSubmitted.length > 0
          ? `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size: 14px;">
              <tr style="background: #E8F5E9;">
                <th style="padding: 8px 12px; text-align: left; font-weight: 600; color: #555;">Proyecto</th>
                <th style="padding: 8px 12px; text-align: left; font-weight: 600; color: #555;">Investigador</th>
                <th style="padding: 8px 12px; text-align: left; font-weight: 600; color: #555;">Entregado</th>
              </tr>
              ${reportsSubmitted
                .map(
                  (r) => `
              <tr>
                <td style="padding: 10px 12px; border-bottom: 1px solid #eee;">${r.app ? appLink(r.app.id, r.app.projectTitle) : `Aplicaci\u00f3n #${r.report.applicationId}`}<br><span style="color: #888; font-size: 12px;">${esc(r.app?.referenceCode ?? `#${r.report.applicationId}`)}</span></td>
                <td style="padding: 10px 12px; border-bottom: 1px solid #eee;">${esc(r.app?.piFullName ?? "—")}</td>
                <td style="padding: 10px 12px; border-bottom: 1px solid #eee; white-space: nowrap;">${fmtDate(r.report.submittedAt.toISOString())}</td>
              </tr>`
                )
                .join("")}
            </table>`
          : `<p style="color: #888; font-style: italic; padding: 12px; background: #f8f9fa; border-radius: 6px;">Ning\u00fan informe entregado el mes pasado.</p>`
      }

      <!-- Active Projects -->
      <h2 style="color: #2E7D32; font-size: 16px; margin: 28px 0 12px; padding-bottom: 8px; border-bottom: 2px solid #2E7D32;">
        Proyectos Activos (${activeProjects.length})
      </h2>
      ${
        activeProjects.length > 0
          ? `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size: 14px;">
              <tr style="background: #E8F5E9;">
                <th style="padding: 8px 12px; text-align: left; font-weight: 600; color: #555;">Proyecto</th>
                <th style="padding: 8px 12px; text-align: left; font-weight: 600; color: #555;">Investigador</th>
                <th style="padding: 8px 12px; text-align: left; font-weight: 600; color: #555;">Per\u00edodo</th>
                <th style="padding: 8px 12px; text-align: left; font-weight: 600; color: #555;">Informe</th>
              </tr>
              ${activeProjects
                .map(
                  (a) => `
              <tr>
                <td style="padding: 10px 12px; border-bottom: 1px solid #eee;">${appLink(a.id, a.projectTitle)}<br><span style="color: #888; font-size: 12px;">${esc(a.referenceCode ?? `#${a.id}`)}</span></td>
                <td style="padding: 10px 12px; border-bottom: 1px solid #eee;">${esc(a.piFullName)}${a.piInstitution ? `<br><span style="color: #888; font-size: 12px;">${esc(a.piInstitution)}</span>` : ""}</td>
                <td style="padding: 10px 12px; border-bottom: 1px solid #eee; white-space: nowrap; font-size: 13px;">${fmtDate(a.projectStartDate)} &ndash;<br>${fmtDate(a.projectEndDate)}</td>
                <td style="padding: 10px 12px; border-bottom: 1px solid #eee; white-space: nowrap;">${a.finalReportDueDate ? `Vence: ${fmtDate(a.finalReportDueDate)}` : "Sin fecha"}</td>
              </tr>`
                )
                .join("")}
            </table>`
          : `<p style="color: #888; font-style: italic; padding: 12px; background: #f8f9fa; border-radius: 6px;">Ning\u00fan proyecto activo.</p>`
      }

      <!-- Completed Projects -->
      ${
        completedProjects.length > 0
          ? `
      <h2 style="color: #666; font-size: 16px; margin: 28px 0 12px; padding-bottom: 8px; border-bottom: 2px solid #ccc;">
        Proyectos Completados (${completedProjects.length})
      </h2>
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="font-size: 14px;">
        <tr style="background: #f8f9fa;">
          <th style="padding: 8px 12px; text-align: left; font-weight: 600; color: #555;">Proyecto</th>
          <th style="padding: 8px 12px; text-align: left; font-weight: 600; color: #555;">Investigador</th>
          <th style="padding: 8px 12px; text-align: left; font-weight: 600; color: #555;">Estado</th>
        </tr>
        ${completedProjects
          .map(
            (a) => `
        <tr>
          <td style="padding: 10px 12px; border-bottom: 1px solid #eee;">${appLink(a.id, a.projectTitle)}<br><span style="color: #888; font-size: 12px;">${esc(a.referenceCode ?? `#${a.id}`)}</span></td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #eee;">${esc(a.piFullName)}</td>
          <td style="padding: 10px 12px; border-bottom: 1px solid #eee;"><span style="display: inline-block; background: #E8F5E9; color: #2E7D32; padding: 2px 8px; border-radius: 12px; font-size: 12px;">Informe entregado</span></td>
        </tr>`
          )
          .join("")}
      </table>`
          : ""
      }

    </div>

    <!-- Footer -->
    <div style="border-top: 1px solid #e0e0e0; padding: 20px 30px; background: #f8f9fa;">
      <a href="${portalUrl}/research-applications" style="display: inline-block; background: #1F4E79; color: #fff; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-size: 14px;">Ver todas las aplicaciones &rarr;</a>
      <p style="margin-top: 16px; color: #888; font-size: 12px;">
        Este resumen se genera autom\u00e1ticamente el 1\u00ba de cada mes desde el Portal FCAT.<br>
        &mdash; FCAT (Fundaci\u00f3n para la Conservaci\u00f3n de los Andes Tropicales)
      </p>
    </div>

  </div>
</body>
</html>
`;

  // Plain text version
  const textSections: string[] = [
    `Resumen Mensual \u2014 Aplicaciones de Investigadores`,
    `Resumen para: ${monthName}`,
    "",
    `Nuevas Aplicaciones: ${newApps.length}  |  Activas: ${activeProjects.length}  |  Vencen este mes: ${reportsDueThisMonth.length}  |  Vencidas: ${overdueApps.length}`,
    "",
  ];

  if (newApps.length > 0) {
    textSections.push(`--- Nuevas Aplicaciones (${newApps.length}) ---`);
    for (const a of newApps) {
      textSections.push(`  ${a.projectTitle} \u2014 ${a.piFullName} (${a.referenceCode ?? `#${a.id}`})`);
      textSections.push(`  ${portalUrl}/research-applications/${a.id}`);
    }
    textSections.push("");
  }

  if (reportsDueThisMonth.length > 0) {
    textSections.push(`--- Informes que Vencen este Mes (${reportsDueThisMonth.length}) ---`);
    for (const a of reportsDueThisMonth) {
      textSections.push(`  ${a.projectTitle} \u2014 vence: ${a.finalReportDueDate}`);
      textSections.push(`  ${portalUrl}/research-applications/${a.id}`);
    }
    textSections.push("");
  }

  if (overdueApps.length > 0) {
    textSections.push(`--- Informes Vencidos (${overdueApps.length}) ---`);
    for (const a of overdueApps) {
      textSections.push(`  ${a.projectTitle} \u2014 vencido: ${a.finalReportDueDate}`);
      textSections.push(`  ${portalUrl}/research-applications/${a.id}`);
    }
    textSections.push("");
  }

  if (reportsSubmitted.length > 0) {
    textSections.push(`--- Informes Entregados (${reportsSubmitted.length}) ---`);
    for (const r of reportsSubmitted) {
      textSections.push(`  ${r.app?.projectTitle ?? `#${r.report.applicationId}`} \u2014 ${r.app?.piFullName ?? "?"}`);
      if (r.app) textSections.push(`  ${portalUrl}/research-applications/${r.app.id}`);
    }
    textSections.push("");
  }

  if (activeProjects.length > 0) {
    textSections.push(`--- Proyectos Activos (${activeProjects.length}) ---`);
    for (const a of activeProjects) {
      textSections.push(`  ${a.projectTitle} \u2014 ${a.piFullName} (informe vence: ${a.finalReportDueDate ?? "sin fecha"})`);
      textSections.push(`  ${portalUrl}/research-applications/${a.id}`);
    }
    textSections.push("");
  }

  if (completedProjects.length > 0) {
    textSections.push(`--- Proyectos Completados (${completedProjects.length}) ---`);
    for (const a of completedProjects) {
      textSections.push(`  ${a.projectTitle} \u2014 ${a.piFullName}`);
      textSections.push(`  ${portalUrl}/research-applications/${a.id}`);
    }
    textSections.push("");
  }

  textSections.push(`Ver todas: ${portalUrl}/research-applications`);
  textSections.push("");
  textSections.push("Este resumen se genera autom\u00e1ticamente el 1\u00ba de cada mes desde el Portal FCAT.");

  const text = textSections.join("\n");

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const from =
      process.env.RESEARCH_APP_FROM_EMAIL ??
      process.env.RESEND_FROM_EMAIL ??
      "portal@fcat-ecuador.org";

    const { error } = await resend.emails.send({
      from,
      to,
      subject: `Resumen mensual \u2014 Aplicaciones de Investigadores (${monthName})`,
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
      active: activeProjects.length,
      completed: completedProjects.length,
    },
  });
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
