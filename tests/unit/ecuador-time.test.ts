import { describe, it, expect } from "vitest";
import { ecuadorWallClock, ecuadorDay, ecuadorParts } from "@/lib/ecuador-time";

// Runs under whatever TZ the process has; `npm` scripts and prod use different
// ones, which is the whole point — the result must not move.
describe("ecuador-time", () => {
  it("formats the QA-window wall clock in Ecuador time during US daylight saving", () => {
    // CCN-010_V1's first photo: 2026-03-17 15:33 UTC = 10:33 Ecuador (NY would say 11:33).
    expect(ecuadorWallClock(new Date("2026-03-17T15:33:00Z"))).toBe("2026-03-17T10:33");
  });

  it("is also right in winter, when New York and Ecuador agree", () => {
    expect(ecuadorWallClock(new Date("2026-02-18T16:04:00Z"))).toBe("2026-02-18T11:04");
  });

  it("rolls the day back for UTC times before 05:00", () => {
    const late = new Date("2026-04-25T02:30:00Z");
    expect(ecuadorDay(late)).toBe("2026-04-24");
    expect(ecuadorParts(late)).toEqual({ year: 2026, month: 4, day: 24 });
  });

  it("orders correctly against stored window strings (export filter)", () => {
    const start = "2026-03-17T10:33";
    expect(ecuadorWallClock(new Date("2026-03-17T15:20:00Z")) < start).toBe(true); // 10:20 local, before
    expect(ecuadorWallClock(new Date("2026-03-17T15:40:00Z")) >= start).toBe(true); // 10:40 local, inside
  });
});
