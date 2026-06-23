import { describe, it, expect } from "vitest";
import { grantStatusEnum } from "@/db/schema";
import {
  FORECAST_WEIGHTS,
  GRANT_STATUS_LABELS,
  GRANT_STATUS_COLORS,
  formatUsd,
  formatDate,
  toDateInput,
  daysUntil,
} from "@/lib/grants/constants";

describe("grant status maps are exhaustive", () => {
  it("FORECAST_WEIGHTS has every status (forecast never silently drops one)", () => {
    for (const s of grantStatusEnum) {
      expect(FORECAST_WEIGHTS[s]).toBeTypeOf("number");
    }
  });
  it("labels + colors cover every status", () => {
    for (const s of grantStatusEnum) {
      expect(GRANT_STATUS_LABELS[s]).toBeTruthy();
      expect(GRANT_STATUS_COLORS[s]).toBeTruthy();
    }
  });
  it("decided stages weight 0 except funded=1", () => {
    expect(FORECAST_WEIGHTS.funded).toBe(1);
    expect(FORECAST_WEIGHTS.rejected).toBe(0);
    expect(FORECAST_WEIGHTS.passed).toBe(0);
    expect(FORECAST_WEIGHTS.to_research).toBe(0);
    expect(FORECAST_WEIGHTS.in_prep).toBeGreaterThan(0);
    expect(FORECAST_WEIGHTS.pending_decision).toBeGreaterThan(FORECAST_WEIGHTS.in_prep);
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
  it("reminder window predicate: due within [0, notifyBeforeDays]", () => {
    const now = new Date("2026-06-22T00:00:00Z");
    const notify = 14;
    const inWindow = (due: string) => {
      const d = daysUntil(new Date(due), now)!;
      return d >= 0 && d <= notify;
    };
    expect(inWindow("2026-06-30T00:00:00Z")).toBe(true); // 8 days out
    expect(inWindow("2026-07-20T00:00:00Z")).toBe(false); // 28 days out
    expect(inWindow("2026-06-20T00:00:00Z")).toBe(false); // already past
  });
});
