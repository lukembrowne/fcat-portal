import "server-only";

import { Resend } from "resend";
import { and, eq, inArray, isNotNull, not } from "drizzle-orm";
import { db } from "@/db";
import { userPermissions, grants, funders, type GrantStatus } from "@/db/schema";
import {
  GRANT_STATUS_LABELS,
  GRANT_DECIDED_STATUSES,
  formatUsd,
  formatDate,
  daysUntil,
  reminderLevel,
} from "@/lib/grants/constants";

export function getGrantsResend() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY not configured");
  return new Resend(apiKey);
}

export function getGrantsFromEmail(): string {
  return (
    process.env.GRANTS_FROM_EMAIL ??
    process.env.RESEND_FROM_EMAIL ??
    "portal@fcat-ecuador.org"
  );
}

/** Editors + admins on the `grants` project. */
export async function getGrantsRecipients(): Promise<string[]> {
  const rows = db
    .select({ email: userPermissions.userEmail })
    .from(userPermissions)
    .where(
      and(
        eq(userPermissions.projectId, "grants"),
        inArray(userPermissions.role, ["editor", "admin"])
      )
    )
    .all();
  return rows.map((r: { email: string }) => r.email);
}

// ---------------------------------------------------------------------------
// Shared row shape
// ---------------------------------------------------------------------------

interface GrantRow {
  id: number;
  name: string;
  funderLabel: string | null;
  status: GrantStatus;
  amountRequested: number | null;
  dueDate: Date | null;
}

function selectGrantsWithFunder() {
  return db
    .select({
      id: grants.id,
      name: grants.name,
      funderName: funders.name,
      funderNameRaw: grants.funderNameRaw,
      status: grants.status,
      amountRequested: grants.amountRequested,
      dueDate: grants.dueDate,
    })
    .from(grants)
    .leftJoin(funders, eq(grants.funderId, funders.id));
}

function toRow(g: {
  id: number;
  name: string;
  funderName: string | null;
  funderNameRaw: string | null;
  status: GrantStatus;
  amountRequested: number | null;
  dueDate: Date | null;
}): GrantRow {
  return {
    id: g.id,
    name: g.name,
    funderLabel: g.funderName ?? g.funderNameRaw,
    status: g.status,
    amountRequested: g.amountRequested,
    dueDate: g.dueDate,
  };
}

// ---------------------------------------------------------------------------
// Monthly digest
// ---------------------------------------------------------------------------

export interface MonthlyDigestData {
  pendingCount: number;
  pendingAmount: number;
  fundedCount: number;
  fundedAmount: number;
  inPrep: GrantRow[];
  dueSoon: GrantRow[]; // active, due in next 30 days
  awaitingDecision: GrantRow[];
  awaitingTotal: number;
  byYear: {
    year: string;
    funded: number;
    rejected: number;
    passed: number;
    completed: number;
    totalRequested: number;
  }[];
}

export function buildMonthlyDigestData(now: Date = new Date()): MonthlyDigestData {
  const all = selectGrantsWithFunder().all().map(toRow);

  const d: MonthlyDigestData = {
    pendingCount: 0,
    pendingAmount: 0,
    fundedCount: 0,
    fundedAmount: 0,
    inPrep: [],
    dueSoon: [],
    awaitingDecision: [],
    awaitingTotal: 0,
    byYear: [],
  };

  const yearMap = new Map<string, MonthlyDigestData["byYear"][number]>();
  const decided = new Set<GrantStatus>(GRANT_DECIDED_STATUSES);

  for (const g of all) {
    const amt = g.amountRequested ?? 0;
    if (g.status === "pending_decision") {
      d.pendingCount++;
      d.pendingAmount += amt;
      d.awaitingDecision.push(g);
      d.awaitingTotal += amt;
    } else if (g.status === "funded") {
      d.fundedCount++;
      d.fundedAmount += amt;
    } else if (g.status === "in_prep") {
      d.inPrep.push(g);
    }

    const days = daysUntil(g.dueDate, now);
    if (days != null && days >= 0 && days <= 30 && !decided.has(g.status)) {
      d.dueSoon.push(g);
    }

    const yKey = g.dueDate ? String(g.dueDate.getUTCFullYear()) : "Sin fecha";
    let y = yearMap.get(yKey);
    if (!y) {
      y = { year: yKey, funded: 0, rejected: 0, passed: 0, completed: 0, totalRequested: 0 };
      yearMap.set(yKey, y);
    }
    y.totalRequested += amt;
    if (g.status === "funded") y.funded++;
    else if (g.status === "rejected") y.rejected++;
    else if (g.status === "passed") y.passed++;
    else if (g.status === "completed") y.completed++;
  }

  d.inPrep.sort((a, b) => (a.dueDate?.getTime() ?? Infinity) - (b.dueDate?.getTime() ?? Infinity));
  d.dueSoon.sort((a, b) => (a.dueDate?.getTime() ?? 0) - (b.dueDate?.getTime() ?? 0));
  d.byYear = [...yearMap.values()].sort((a, b) => {
    if (a.year === "Sin fecha") return 1;
    if (b.year === "Sin fecha") return -1;
    return Number(b.year) - Number(a.year);
  });

  return d;
}

const C = {
  blue: "#1F4E79",
  green: "#2E7D32",
  amber: "#F57C00",
};

function table(headers: string[], rows: string[][], totalRow?: string[]): string {
  const head = headers.map((h) => `<th align="left" style="padding:8px;border-bottom:2px solid #ddd;color:#555">${h}</th>`).join("");
  const body = rows
    .map(
      (r) =>
        `<tr>${r.map((c) => `<td style="padding:8px;border-bottom:1px solid #eee">${c}</td>`).join("")}</tr>`
    )
    .join("");
  const total = totalRow
    ? `<tr style="font-weight:600;background:#f0f4f8">${totalRow.map((c) => `<td style="padding:8px;border-top:2px solid ${C.blue}">${c}</td>`).join("")}</tr>`
    : "";
  return `<table style="width:100%;border-collapse:collapse;margin:8px 0 20px">${head ? `<tr>${head}</tr>` : ""}${body}${total}</table>`;
}

export function renderMonthlyDigestHtml(d: MonthlyDigestData, portalUrl: string): string {
  const box = (n: string, label: string, color: string) =>
    `<div style="border:1px solid #e0e0e0;border-radius:8px;padding:14px 18px;flex:1;min-width:150px"><div style="font-size:26px;font-weight:700;color:${color}">${n}</div><div style="font-size:12px;color:#666">${label}</div></div>`;

  const link = (id: number, name: string) =>
    `<a href="${portalUrl}/grants/${id}" style="color:${C.blue}">${name}</a>`;

  const grantRows = (rows: GrantRow[], withDue: boolean) =>
    rows.map((g) => {
      const cells = [link(g.id, g.name), g.funderLabel ?? "—", formatUsd(g.amountRequested)];
      if (withDue) {
        const days = daysUntil(g.dueDate);
        const badge = days != null && days <= 7 ? ` <span style="background:#F8D7DA;color:#721C24;padding:1px 6px;border-radius:10px;font-size:11px">${days}d</span>` : "";
        cells.push(`${formatDate(g.dueDate)}${badge}`);
      }
      return cells;
    });

  const yearRows = d.byYear.map((y) => [
    y.year,
    String(y.funded),
    String(y.rejected),
    String(y.passed),
    String(y.completed),
    formatUsd(y.totalRequested),
  ]);

  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5;color:#333;max-width:860px;margin:0 auto;padding:20px">
    <h1 style="color:${C.blue};border-bottom:3px solid ${C.blue};padding-bottom:10px">📊 Monthly Grant Summary — FCAT</h1>
    <div style="display:flex;gap:12px;flex-wrap:wrap;margin:20px 0">
      ${box(String(d.pendingCount), "Awaiting decision", C.amber)}
      ${box(formatUsd(d.pendingAmount), "Pending amount", C.amber)}
      ${box(String(d.fundedCount), "Grants funded", C.green)}
      ${box(formatUsd(d.fundedAmount), "Total funded", C.green)}
    </div>

    <h2 style="color:${C.green}">✏️ In Preparation</h2>
    ${d.inPrep.length ? table(["Grant", "Funder", "Amount", "Due date"], grantRows(d.inPrep, true)) : `<p style="color:#888;font-style:italic">None in preparation.</p>`}

    <h2 style="color:${C.green}">🗓️ Due in the Next 30 Days</h2>
    ${d.dueSoon.length ? table(["Grant", "Funder", "Amount", "Due date"], grantRows(d.dueSoon, true)) : `<p style="color:#888;font-style:italic">None due in 30 days.</p>`}

    <h2 style="color:${C.green}">⏳ Awaiting Decision</h2>
    ${
      d.awaitingDecision.length
        ? table(
            ["Grant", "Funder", "Amount"],
            grantRows(d.awaitingDecision, false),
            ["Total pending", "", formatUsd(d.awaitingTotal)]
          )
        : `<p style="color:#888;font-style:italic">None awaiting decision.</p>`
    }

    <h2 style="color:${C.green}">📈 Statistics by Year</h2>
    ${table(["Year", "Funded", "Rejected", "Passed", "Completed", "Requested"], yearRows)}

    <p style="margin-top:30px"><a href="${portalUrl}/grants" style="background:${C.blue};color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Open the portal</a></p>
  </div>`;
}

// ---------------------------------------------------------------------------
// Per-deadline reminders
// ---------------------------------------------------------------------------

/** A due grant plus the reminder level it has now reached (1 = 30-day, 2 = 14-day). */
export interface DueReminder extends GrantRow {
  targetLevel: number;
}

/**
 * Active grants that have crossed a new reminder threshold since they were last
 * emailed. Each grant is included iff its current `reminderLevel` (count of
 * GRANT_REMINDER_DAYS thresholds entered) exceeds `remindersSent`, so every
 * threshold fires exactly once and a grant entered late only gets the still-
 * applicable (most urgent) reminder. Overdue grants (level 0) are excluded.
 */
export function getDueReminders(now: Date = new Date()): DueReminder[] {
  const candidates = db
    .select({
      id: grants.id,
      name: grants.name,
      funderName: funders.name,
      funderNameRaw: grants.funderNameRaw,
      status: grants.status,
      amountRequested: grants.amountRequested,
      dueDate: grants.dueDate,
      remindersSent: grants.remindersSent,
    })
    .from(grants)
    .leftJoin(funders, eq(grants.funderId, funders.id))
    .where(
      and(
        isNotNull(grants.dueDate),
        not(inArray(grants.status, GRANT_DECIDED_STATUSES))
      )
    )
    .all();

  return candidates
    .flatMap((g) => {
      const level = reminderLevel(daysUntil(g.dueDate, now));
      if (level <= g.remindersSent) return [];
      return [{ ...toRow(g), targetLevel: level }];
    })
    .sort((a, b) => (a.dueDate?.getTime() ?? 0) - (b.dueDate?.getTime() ?? 0));
}

/**
 * Stamp each grant with the reminder level it reached (so the next still-higher
 * threshold can fire later) and the send time. Sequential updates — small N.
 */
export async function markReminded(
  updates: { id: number; level: number }[],
  now: Date = new Date()
): Promise<void> {
  for (const u of updates) {
    await db
      .update(grants)
      .set({ remindersSent: u.level, lastNotifiedAt: now })
      .where(eq(grants.id, u.id));
  }
}

export function renderRemindersHtml(rows: GrantRow[], portalUrl: string): string {
  const items = rows
    .map((g) => {
      const days = daysUntil(g.dueDate);
      return `<li style="margin-bottom:10px"><a href="${portalUrl}/grants/${g.id}" style="color:${C.blue};font-weight:600">${g.name}</a> — ${g.funderLabel ?? "—"}<br/><span style="color:#721C24">Due ${formatDate(g.dueDate)} (in ${days} day(s))</span> · ${GRANT_STATUS_LABELS[g.status]} · ${formatUsd(g.amountRequested)}</li>`;
    })
    .join("");

  return `
  <div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;line-height:1.5;color:#333;max-width:700px;margin:0 auto;padding:20px">
    <h1 style="color:${C.blue}">⏰ Grant Deadline Reminder</h1>
    <p>The following grants are approaching their deadline:</p>
    <ul style="padding-left:18px">${items}</ul>
    <p style="margin-top:24px"><a href="${portalUrl}/grants" style="background:${C.blue};color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none">Open the portal</a></p>
  </div>`;
}
