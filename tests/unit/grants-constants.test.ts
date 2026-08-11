import { describe, it, expect } from "vitest";
import { grantStatusEnum, grantFundingEntityEnum } from "@/db/schema";
import {
  GRANT_STATUS_LABELS,
  GRANT_STATUS_COLORS,
  GRANT_REMINDER_DAYS,
  reminderLevel,
  GRANT_DECIDED_STATUSES,
  GRANT_SUCCESS_DENOMINATOR_STATUSES,
  EDITABLE_GRANT_FIELDS,
  EDITABLE_FUNDER_FIELDS,
  formatUsd,
  formatDate,
  toDateInput,
  daysUntil,
  GRANT_FUNDING_ENTITY_LABELS,
  GRANT_FUNDING_ENTITY_COLORS,
  GRANT_FUNDING_ENTITY_ORDER,
} from "@/lib/grants/constants";

describe("grant status maps are exhaustive", () => {
  it("labels + colors cover every status", () => {
    for (const s of grantStatusEnum) {
      expect(GRANT_STATUS_LABELS[s]).toBeTruthy();
      expect(GRANT_STATUS_COLORS[s]).toBeTruthy();
    }
  });
});

describe("funding entity maps are exhaustive", () => {
  it("labels + colors cover every entity", () => {
    for (const e of grantFundingEntityEnum) {
      expect(GRANT_FUNDING_ENTITY_LABELS[e]).toBeTruthy();
      expect(GRANT_FUNDING_ENTITY_COLORS[e]).toBeTruthy();
    }
  });
  it("order lists every entity exactly once", () => {
    expect([...GRANT_FUNDING_ENTITY_ORDER].sort()).toEqual(
      [...grantFundingEntityEnum].sort()
    );
  });
});

describe("EDITABLE_GRANT_FIELDS covers the project/period/entity columns", () => {
  // The whitelist is a server-side guard in updateGrantField: a cell rendered
  // for a field missing here looks editable and fails every save with
  // "Unknown field." — a silent half-failure no type check catches.
  it("whitelists every field the grants table edits inline", () => {
    for (const f of [
      "projectTitle",
      "startDate",
      "endDate",
      "fundingEntity",
      "amountAwarded",
    ]) {
      expect(EDITABLE_GRANT_FIELDS).toContain(f);
    }
  });
});

describe("formatUsd", () => {
  it("formats whole-dollar USD", () => {
    expect(formatUsd(50000)).toBe("$50,000");
    expect(formatUsd(0)).toBe("$0");
  });
  it("renders dash for null", () => {
    expect(formatUsd(null)).toBe("—");
    expect(formatUsd(undefined)).toBe("—");
  });
});

describe("toDateInput / formatDate (UTC, no day drift)", () => {
  it("toDateInput emits UTC YYYY-MM-DD", () => {
    expect(toDateInput(new Date(Date.UTC(2026, 7, 1)))).toBe("2026-08-01");
    expect(toDateInput(null)).toBeNull();
  });
  it("formatDate uses UTC so a UTC-midnight date keeps its day", () => {
    // Would be Jul 31 if formatted in a negative-offset local tz.
    expect(formatDate(new Date("2026-08-01T00:00:00Z"))).toContain("2026");
  });
});

describe("daysUntil", () => {
  it("computes signed whole days", () => {
    const now = new Date("2026-06-22T12:00:00Z");
    expect(daysUntil(new Date("2026-06-29T12:00:00Z"), now)).toBe(7);
    expect(daysUntil(new Date("2026-06-20T12:00:00Z"), now)).toBe(-2);
    expect(daysUntil(null, now)).toBeNull();
  });
});

describe("reminderLevel (two-tier 30 + 14 day thresholds)", () => {
  it("uses descending thresholds", () => {
    expect([...GRANT_REMINDER_DAYS]).toEqual([30, 14]);
  });
  it("counts how many thresholds the days-remaining has entered", () => {
    expect(reminderLevel(40)).toBe(0); // not due yet
    expect(reminderLevel(30)).toBe(1); // just crossed 30-day
    expect(reminderLevel(25)).toBe(1); // still only the 30-day
    expect(reminderLevel(14)).toBe(2); // crossed 14-day
    expect(reminderLevel(8)).toBe(2);
    expect(reminderLevel(0)).toBe(2); // due today
  });
  it("treats overdue and missing dates as level 0 (no reminder)", () => {
    expect(reminderLevel(-2)).toBe(0);
    expect(reminderLevel(null)).toBe(0);
  });
});

describe("success-rate denominator excludes passed grants", () => {
  it("counts only grants we applied to and got a verdict on", () => {
    expect([...GRANT_SUCCESS_DENOMINATOR_STATUSES].sort()).toEqual(
      ["completed", "funded", "rejected"].sort()
    );
  });
  it("excludes 'passed' (opportunities we chose not to pursue)", () => {
    expect(GRANT_SUCCESS_DENOMINATOR_STATUSES).not.toContain("passed");
    // ...even though 'passed' still counts as decided/out-of-pipeline elsewhere.
    expect(GRANT_DECIDED_STATUSES).toContain("passed");
  });
});

describe("editable field whitelists", () => {
  it("grant fields no longer expose the removed notify/RFP columns", () => {
    expect(EDITABLE_GRANT_FIELDS).not.toContain("notifyBeforeDays");
    expect(EDITABLE_GRANT_FIELDS).not.toContain("checkRfpDate");
    expect(EDITABLE_GRANT_FIELDS).toContain("status");
    expect(EDITABLE_GRANT_FIELDS).toContain("dueDate");
  });
  it("funder fields whitelist the displayed columns, not derived/internal ones", () => {
    expect(EDITABLE_FUNDER_FIELDS).toContain("name");
    expect(EDITABLE_FUNDER_FIELDS).toContain("priority");
    expect(EDITABLE_FUNDER_FIELDS).toContain("nextStepDue");
    expect(EDITABLE_FUNDER_FIELDS).not.toContain("grantCount");
    expect(EDITABLE_FUNDER_FIELDS).not.toContain("nameNormalized");
  });
});
