import { describe, it, expect } from "vitest";
import { reminderLevel } from "@/lib/grants/constants";

/**
 * Pure simulation of the cron's reminder decision (mirrors getDueReminders +
 * markReminded in src/lib/grants/emails.ts) without touching the DB. A grant is
 * emailed iff its current reminderLevel exceeds the count already sent; on send,
 * remindersSent jumps to that level so each threshold fires at most once.
 */
function runReminder(grant: { days: number | null; remindersSent: number }) {
  const level = reminderLevel(grant.days);
  const emailed = level > grant.remindersSent;
  return { emailed, remindersSent: emailed ? level : grant.remindersSent };
}

describe("two-tier reminder decision", () => {
  it("fires once at 30 days, then once at 14 days, never twice", () => {
    let g = { days: 30, remindersSent: 0 };

    let r = runReminder({ ...g, days: 30 }); // crosses 30-day
    expect(r.emailed).toBe(true);
    expect(r.remindersSent).toBe(1);
    g = { ...g, remindersSent: r.remindersSent };

    r = runReminder({ ...g, days: 25 }); // still inside 30-day window
    expect(r.emailed).toBe(false); // no duplicate
    g = { ...g, remindersSent: r.remindersSent };

    r = runReminder({ ...g, days: 14 }); // crosses 14-day
    expect(r.emailed).toBe(true);
    expect(r.remindersSent).toBe(2);
    g = { ...g, remindersSent: r.remindersSent };

    r = runReminder({ ...g, days: 8 }); // still inside 14-day window
    expect(r.emailed).toBe(false);
  });

  it("a grant first seen inside 14 days gets exactly one (the 14-day) email", () => {
    const r = runReminder({ days: 8, remindersSent: 0 });
    expect(r.emailed).toBe(true);
    expect(r.remindersSent).toBe(2); // jumps straight to 2 — no late 30-day blast
  });

  it("pushing the due date out after both reminders sent does not re-send", () => {
    const r = runReminder({ days: 40, remindersSent: 2 });
    expect(r.emailed).toBe(false);
  });

  it("overdue grants are never reminded", () => {
    expect(runReminder({ days: -2, remindersSent: 0 }).emailed).toBe(false);
    expect(runReminder({ days: -2, remindersSent: 1 }).emailed).toBe(false);
  });

  it("a grant far from its deadline is not reminded", () => {
    expect(runReminder({ days: 60, remindersSent: 0 }).emailed).toBe(false);
  });
});
