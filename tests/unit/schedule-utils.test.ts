import { describe, it, expect } from "vitest";
import {
  isValidWorkDay,
  assignSeason,
  shiftSchedule,
  shiftScheduleBySlots,
  swapDeploymentDates,
  editDeploymentDate,
  addSiteToSchedule,
  validateSchedule,
  validateSlotSchedule,
} from "@/lib/schedule-utils";
import type { ScheduleRow, SlotRow } from "@/lib/schedule-types";

function makeRow(overrides: Partial<ScheduleRow>): ScheduleRow {
  return {
    deploymentId: "TEST-001_V1",
    siteId: "TEST-001",
    siteName: "Test Site",
    habitatType: "bosque_maduro",
    visitNumber: 1,
    season: "wet_peak",
    plannedDeployDate: "2026-03-15",
    plannedRetrieveDate: "2026-04-15",
    actualDeployDate: null,
    actualRetrieveDate: null,
    status: "scheduled",
    deploySlotId: null,
    retrieveSlotId: null,
    driveFolderLink: "",
    ...overrides,
  };
}

// ─── isValidWorkDay ──────────────────────────────────────────

describe("isValidWorkDay", () => {
  it("returns true for day 15 of a regular month", () => {
    expect(isValidWorkDay(new Date(2026, 2, 15))).toBe(true); // March 15
  });

  it("returns false for day 5 (before work day range)", () => {
    expect(isValidWorkDay(new Date(2026, 2, 5))).toBe(false);
  });

  it("returns false for day 10 (just before work days)", () => {
    expect(isValidWorkDay(new Date(2026, 2, 10))).toBe(false);
  });

  it("returns true for day 11 (first work day)", () => {
    expect(isValidWorkDay(new Date(2026, 2, 11))).toBe(true);
  });

  it("returns true for day 30", () => {
    expect(isValidWorkDay(new Date(2026, 2, 30))).toBe(true);
  });

  it("returns false for day 31 when WORK_DAY_END is 30", () => {
    // March has 31 days but work day end is 30
    expect(isValidWorkDay(new Date(2026, 2, 31))).toBe(false);
  });

  it("uses special start day for January 2026 (day 20)", () => {
    expect(isValidWorkDay(new Date(2026, 0, 15))).toBe(false); // day 15 < 20
    expect(isValidWorkDay(new Date(2026, 0, 20))).toBe(true);  // day 20 OK
    expect(isValidWorkDay(new Date(2026, 0, 30))).toBe(true);  // day 30 OK
  });
});

// ─── assignSeason ────────────────────────────────────────────

describe("assignSeason", () => {
  it("returns wet_peak for Dec-Apr", () => {
    expect(assignSeason(new Date(2026, 11, 15))).toBe("wet_peak"); // Dec
    expect(assignSeason(new Date(2026, 0, 15))).toBe("wet_peak");  // Jan
    expect(assignSeason(new Date(2026, 3, 15))).toBe("wet_peak");  // Apr
  });

  it("returns wet_transition for May, Jun, Nov", () => {
    expect(assignSeason(new Date(2026, 4, 15))).toBe("wet_transition"); // May
    expect(assignSeason(new Date(2026, 5, 15))).toBe("wet_transition"); // Jun
    expect(assignSeason(new Date(2026, 10, 15))).toBe("wet_transition"); // Nov
  });

  it("returns dry for Jul-Oct", () => {
    expect(assignSeason(new Date(2026, 6, 15))).toBe("dry");  // Jul
    expect(assignSeason(new Date(2026, 9, 15))).toBe("dry");  // Oct
  });
});

// ─── validateSchedule ───────────────────────────────────────

describe("validateSchedule", () => {
  it("returns no errors for valid schedule", () => {
    const rows = [
      makeRow({ deploymentId: "A_V1", plannedDeployDate: "2026-03-15", plannedRetrieveDate: "2026-04-15" }),
      makeRow({ deploymentId: "B_V1", plannedDeployDate: "2026-03-16", plannedRetrieveDate: "2026-04-16" }),
    ];
    expect(validateSchedule(rows)).toEqual([]);
  });

  it("detects invalid work day", () => {
    const rows = [makeRow({ plannedDeployDate: "2026-03-05" })]; // day 5 not valid
    const errors = validateSchedule(rows);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("día hábil");
  });

  it("detects duplicate deploy dates", () => {
    const rows = [
      makeRow({ deploymentId: "A_V1", plannedDeployDate: "2026-03-15" }),
      makeRow({ deploymentId: "B_V1", plannedDeployDate: "2026-03-15" }),
    ];
    const errors = validateSchedule(rows);
    expect(errors.some((e) => e.includes("Múltiples instalaciones"))).toBe(true);
  });

  it("detects duplicate retrieve dates", () => {
    const rows = [
      makeRow({ deploymentId: "A_V1", plannedRetrieveDate: "2026-04-15" }),
      makeRow({ deploymentId: "B_V1", plannedRetrieveDate: "2026-04-15" }),
    ];
    const errors = validateSchedule(rows);
    expect(errors.some((e) => e.includes("Múltiples recuperaciones"))).toBe(true);
  });
});

// ─── shiftSchedule ──────────────────────────────────────────

describe("shiftSchedule", () => {
  it("shifts scheduled rows by given days", () => {
    const rows = [
      makeRow({ deploymentId: "A_V1", plannedDeployDate: "2026-03-15", plannedRetrieveDate: "2026-04-15" }),
    ];
    const result = shiftSchedule(rows, 5);
    expect(result.changes.length).toBeGreaterThan(0);
    expect(result.rows[0].plannedDeployDate).toBe("2026-03-20");
  });

  it("does not shift non-scheduled rows", () => {
    const rows = [
      makeRow({ deploymentId: "A_V1", status: "deployed", plannedDeployDate: "2026-03-15" }),
    ];
    const result = shiftSchedule(rows, 5);
    expect(result.changes).toEqual([]);
    expect(result.rows[0].plannedDeployDate).toBe("2026-03-15");
  });

  it("returns empty changes when shift is 0", () => {
    const rows = [makeRow({})];
    const result = shiftSchedule(rows, 0);
    expect(result.changes).toEqual([]);
  });

  it("enforces work day constraints when shifting", () => {
    // Shift to day 5 (invalid) should find next valid day
    const rows = [
      makeRow({ plannedDeployDate: "2026-03-11", plannedRetrieveDate: "2026-04-11" }),
    ];
    const result = shiftSchedule(rows, -10); // Would land on March 1
    const newDate = result.rows[0].plannedDeployDate;
    if (newDate) {
      const day = parseInt(newDate.split("-")[2], 10);
      expect(day).toBeGreaterThanOrEqual(11);
    }
  });
});

// ─── swapDeploymentDates ────────────────────────────────────

describe("swapDeploymentDates", () => {
  it("swaps deploy and retrieve dates between two scheduled rows", () => {
    const rows = [
      makeRow({ deploymentId: "A_V1", plannedDeployDate: "2026-03-15", plannedRetrieveDate: "2026-04-15" }),
      makeRow({ deploymentId: "B_V1", plannedDeployDate: "2026-06-15", plannedRetrieveDate: "2026-07-15" }),
    ];
    const result = swapDeploymentDates(rows, "A_V1", "B_V1");

    const a = result.rows.find((r) => r.deploymentId === "A_V1")!;
    const b = result.rows.find((r) => r.deploymentId === "B_V1")!;
    expect(a.plannedDeployDate).toBe("2026-06-15");
    expect(b.plannedDeployDate).toBe("2026-03-15");
    expect(a.plannedRetrieveDate).toBe("2026-07-15");
    expect(b.plannedRetrieveDate).toBe("2026-04-15");
  });

  it("throws when deployment not found", () => {
    const rows = [makeRow({ deploymentId: "A_V1" })];
    expect(() => swapDeploymentDates(rows, "A_V1", "MISSING")).toThrow("not found");
  });

  it("throws when deployment is not scheduled", () => {
    const rows = [
      makeRow({ deploymentId: "A_V1", status: "deployed" }),
      makeRow({ deploymentId: "B_V1" }),
    ];
    expect(() => swapDeploymentDates(rows, "A_V1", "B_V1")).toThrow("not scheduled");
  });

  it("recalculates seasons after swap", () => {
    const rows = [
      makeRow({ deploymentId: "A_V1", plannedDeployDate: "2026-01-15", season: "wet_peak" }),
      makeRow({ deploymentId: "B_V1", plannedDeployDate: "2026-08-15", season: "dry" }),
    ];
    const result = swapDeploymentDates(rows, "A_V1", "B_V1");
    const a = result.rows.find((r) => r.deploymentId === "A_V1")!;
    const b = result.rows.find((r) => r.deploymentId === "B_V1")!;
    expect(a.season).toBe("dry");      // now in August
    expect(b.season).toBe("wet_peak"); // now in January
  });

  it("throws when swapping a deployment with itself", () => {
    const rows = [makeRow({ deploymentId: "A_V1" })];
    expect(() => swapDeploymentDates(rows, "A_V1", "A_V1")).toThrow(
      "Cannot swap a deployment with itself",
    );
  });
});

// ─── editDeploymentDate ─────────────────────────────────────

describe("editDeploymentDate", () => {
  it("shifts both dates by the same interval (30 days)", () => {
    const rows = [
      makeRow({
        deploymentId: "A_V1",
        plannedDeployDate: "2026-03-15",
        plannedRetrieveDate: "2026-04-14",
      }),
    ];
    const result = editDeploymentDate(rows, "A_V1", "2026-04-15");
    const a = result.rows.find((r) => r.deploymentId === "A_V1")!;
    expect(a.plannedDeployDate).toBe("2026-04-15");
    expect(a.plannedRetrieveDate).toBe("2026-05-15"); // +30 days from new deploy
  });

  it("preserves the deploy↔retrieve interval exactly", () => {
    const rows = [
      makeRow({
        deploymentId: "A_V1",
        plannedDeployDate: "2026-03-12",
        plannedRetrieveDate: "2026-04-11",
      }),
    ];
    const result = editDeploymentDate(rows, "A_V1", "2026-06-17");
    const a = result.rows.find((r) => r.deploymentId === "A_V1")!;
    const newDep = new Date(a.plannedDeployDate!);
    const newRet = new Date(a.plannedRetrieveDate!);
    const days = Math.round((newRet.getTime() - newDep.getTime()) / 86_400_000);
    expect(days).toBe(30);
  });

  it("recalculates season when crossing a season boundary", () => {
    const rows = [
      makeRow({
        deploymentId: "A_V1",
        plannedDeployDate: "2026-03-15",
        plannedRetrieveDate: "2026-04-15",
        season: "wet_peak",
      }),
    ];
    const result = editDeploymentDate(rows, "A_V1", "2026-08-15"); // dry
    const a = result.rows.find((r) => r.deploymentId === "A_V1")!;
    expect(a.season).toBe("dry");
    expect(result.changes.some((c) => c.field === "season")).toBe(true);
  });

  it("clears deploySlotId and retrieveSlotId", () => {
    const rows = [
      makeRow({
        deploymentId: "A_V1",
        plannedDeployDate: "2026-03-15",
        plannedRetrieveDate: "2026-04-15",
        deploySlotId: 7,
        retrieveSlotId: 12,
      }),
    ];
    const result = editDeploymentDate(rows, "A_V1", "2026-04-12");
    const a = result.rows.find((r) => r.deploymentId === "A_V1")!;
    expect(a.deploySlotId).toBeNull();
    expect(a.retrieveSlotId).toBeNull();
  });

  it("leaves plannedRetrieveDate null if source row's retrieve is null", () => {
    const rows = [
      makeRow({
        deploymentId: "A_V1",
        plannedDeployDate: "2026-03-15",
        plannedRetrieveDate: null,
      }),
    ];
    const result = editDeploymentDate(rows, "A_V1", "2026-04-12");
    const a = result.rows.find((r) => r.deploymentId === "A_V1")!;
    expect(a.plannedRetrieveDate).toBeNull();
  });

  it("throws on malformed date strings", () => {
    const rows = [makeRow({ deploymentId: "A_V1" })];
    expect(() => editDeploymentDate(rows, "A_V1", "06/12/2026")).toThrow("Invalid date format");
    expect(() => editDeploymentDate(rows, "A_V1", "")).toThrow("Invalid date format");
    expect(() => editDeploymentDate(rows, "A_V1", "2026-13-1")).toThrow("Invalid date format");
  });

  it("throws on unknown deployment ID", () => {
    const rows = [makeRow({ deploymentId: "A_V1" })];
    expect(() => editDeploymentDate(rows, "MISSING", "2026-05-15")).toThrow("not found");
  });

  it("throws on non-scheduled status", () => {
    const rows = [makeRow({ deploymentId: "A_V1", status: "deployed" })];
    expect(() => editDeploymentDate(rows, "A_V1", "2026-05-15")).toThrow("not scheduled");
  });

  it("does not mutate the input rows array", () => {
    const original = [
      makeRow({
        deploymentId: "A_V1",
        plannedDeployDate: "2026-03-15",
        plannedRetrieveDate: "2026-04-15",
        deploySlotId: 3,
      }),
    ];
    const snapshot = JSON.parse(JSON.stringify(original));
    editDeploymentDate(original, "A_V1", "2026-05-15");
    expect(original).toEqual(snapshot);
  });

  it("emits change records only for fields that actually changed", () => {
    const rows = [
      makeRow({
        deploymentId: "A_V1",
        plannedDeployDate: "2026-03-15",
        plannedRetrieveDate: "2026-04-15",
        season: "wet_peak",
        deploySlotId: null,
        retrieveSlotId: null,
      }),
    ];
    // Edit to a date still in wet_peak so season doesn't change
    const result = editDeploymentDate(rows, "A_V1", "2026-03-20");
    const fields = result.changes.map((c) => c.field);
    expect(fields).toContain("plannedDeployDate");
    expect(fields).toContain("plannedRetrieveDate");
    expect(fields).not.toContain("season");
    expect(fields).not.toContain("deploySlotId");
    expect(fields).not.toContain("retrieveSlotId");
  });
});

// ─── addSiteToSchedule ─────────────────────────────────────

describe("addSiteToSchedule", () => {
  it("creates 3 visits for a new site", () => {
    const rows = [
      makeRow({ deploymentId: "A_V1", plannedDeployDate: "2026-03-15", plannedRetrieveDate: "2026-04-15" }),
    ];
    const result = addSiteToSchedule(rows, { siteId: "NEW-001", siteName: "New Site", habitatType: "bosque" });

    expect(result.newDeployments).toHaveLength(3);
    expect(result.newDeployments[0].deploymentId).toBe("NEW-001_V1");
    expect(result.newDeployments[1].deploymentId).toBe("NEW-001_V2");
    expect(result.newDeployments[2].deploymentId).toBe("NEW-001_V3");
  });

  it("spaces visits ~6 months apart", () => {
    const rows: ScheduleRow[] = [];
    const result = addSiteToSchedule(rows, { siteId: "X", siteName: "X", habitatType: "t" });

    const d1 = new Date(result.newDeployments[0].plannedDeployDate!);
    const d2 = new Date(result.newDeployments[1].plannedDeployDate!);
    const d3 = new Date(result.newDeployments[2].plannedDeployDate!);

    const monthDiff12 = (d2.getFullYear() - d1.getFullYear()) * 12 + d2.getMonth() - d1.getMonth();
    const monthDiff23 = (d3.getFullYear() - d2.getFullYear()) * 12 + d3.getMonth() - d2.getMonth();

    expect(monthDiff12).toBeGreaterThanOrEqual(5);
    expect(monthDiff12).toBeLessThanOrEqual(7);
    expect(monthDiff23).toBeGreaterThanOrEqual(5);
    expect(monthDiff23).toBeLessThanOrEqual(7);
  });

  it("includes new deployments in returned rows", () => {
    const rows = [makeRow({})];
    const result = addSiteToSchedule(rows, { siteId: "Y", siteName: "Y", habitatType: "t" });
    expect(result.rows.length).toBe(4); // 1 existing + 3 new
  });
});

// ─── shiftScheduleBySlots ───────────────────────────────────

describe("shiftScheduleBySlots", () => {
  const slots: SlotRow[] = [
    { slotId: 1, slotDate: "2026-01-20", yearMonth: "2026-01", dayOfMonth: 20 },
    { slotId: 2, slotDate: "2026-01-21", yearMonth: "2026-01", dayOfMonth: 21 },
    { slotId: 3, slotDate: "2026-01-22", yearMonth: "2026-01", dayOfMonth: 22 },
    { slotId: 4, slotDate: "2026-01-23", yearMonth: "2026-01", dayOfMonth: 23 },
    { slotId: 5, slotDate: "2026-01-24", yearMonth: "2026-01", dayOfMonth: 24 },
  ];

  it("shifts slot IDs by given amount", () => {
    const rows = [makeRow({ deploySlotId: 2, retrieveSlotId: 4 })];
    const result = shiftScheduleBySlots(rows, slots, 2);
    expect(result.rows[0].deploySlotId).toBe(4);
    expect(result.changes.length).toBeGreaterThan(0);
  });

  it("clamps to slot bounds", () => {
    const rows = [makeRow({ deploySlotId: 4, retrieveSlotId: 5 })];
    const result = shiftScheduleBySlots(rows, slots, 5); // Would go to 9, clamped to 5
    expect(result.rows[0].deploySlotId).toBe(5);
  });

  it("skips non-scheduled rows", () => {
    const rows = [makeRow({ status: "deployed", deploySlotId: 2 })];
    const result = shiftScheduleBySlots(rows, slots, 2);
    expect(result.changes).toEqual([]);
  });
});

// ─── validateSlotSchedule ───────────────────────────────────

describe("validateSlotSchedule", () => {
  const slots: SlotRow[] = [
    { slotId: 1, slotDate: "2026-01-20", yearMonth: "2026-01", dayOfMonth: 20 },
    { slotId: 2, slotDate: "2026-01-21", yearMonth: "2026-01", dayOfMonth: 21 },
    { slotId: 3, slotDate: "2026-01-22", yearMonth: "2026-01", dayOfMonth: 22 },
  ];

  it("returns no errors for valid slot schedule", () => {
    const rows = [makeRow({ deploySlotId: 1, plannedDeployDate: "2026-01-20" })];
    expect(validateSlotSchedule(rows, slots)).toEqual([]);
  });

  it("detects out-of-range slot IDs", () => {
    const rows = [makeRow({ deploySlotId: 99 })];
    const errors = validateSlotSchedule(rows, slots);
    expect(errors.some((e) => e.includes("fuera de rango"))).toBe(true);
  });

  it("detects date mismatch with slot", () => {
    const rows = [makeRow({ deploySlotId: 1, plannedDeployDate: "2026-03-15" })];
    const errors = validateSlotSchedule(rows, slots);
    expect(errors.some((e) => e.includes("fecha no coincide"))).toBe(true);
  });

  it("detects duplicate slot assignments among scheduled items", () => {
    const rows = [
      makeRow({ deploymentId: "A_V1", deploySlotId: 2 }),
      makeRow({ deploymentId: "B_V1", deploySlotId: 2 }),
    ];
    const errors = validateSlotSchedule(rows, slots);
    expect(errors.some((e) => e.includes("instalaciones asignadas"))).toBe(true);
  });
});
