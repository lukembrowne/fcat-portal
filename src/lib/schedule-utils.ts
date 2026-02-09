/**
 * Schedule manipulation utilities — TypeScript port of schedule_utils.py.
 *
 * BIOCHOCO-specific scheduling logic for sensor deployments.
 */

import type { ScheduleRow, SlotRow, ScheduleChange } from "./schedule-types";

// Work day constraints (days 11-30 of each month)
const WORK_DAY_START = 11;
const WORK_DAY_END = 30;

// First month of project has special start day (January 2026)
const FIRST_MONTH_YEAR = 2026;
const FIRST_MONTH_MONTH = 1;
const FIRST_MONTH_START_DAY = 20;

// Monthly limits
const MAX_DEPLOYS_PER_MONTH = 20;
const MAX_RETRIEVES_PER_MONTH = 20;

// Site scheduling constants
const DEPLOYMENT_DURATION_DAYS = 30;
const MONTHS_BETWEEN_VISITS = 6;
const VISITS_PER_SITE = 3;

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function parseDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// ─── Working Day Logic ───────────────────────────────────────

function getWorkDayRange(year: number, month: number): [number, number] {
  const lastDay = daysInMonth(year, month);
  const end = Math.min(WORK_DAY_END, lastDay);

  if (year === FIRST_MONTH_YEAR && month === FIRST_MONTH_MONTH) {
    return [FIRST_MONTH_START_DAY, end];
  }
  return [WORK_DAY_START, end];
}

export function isValidWorkDay(date: Date): boolean {
  const [start, end] = getWorkDayRange(date.getFullYear(), date.getMonth() + 1);
  return date.getDate() >= start && date.getDate() <= end;
}

function getWorkingDays(year: number, month: number): Date[] {
  const [start, end] = getWorkDayRange(year, month);
  const days: Date[] = [];
  for (let d = start; d <= end; d++) {
    days.push(new Date(year, month - 1, d));
  }
  return days;
}

function generateWorkingCalendar(startYear: number, startMonth: number, numMonths = 24): Date[] {
  const days: Date[] = [];
  let y = startYear;
  let m = startMonth;

  for (let i = 0; i < numMonths; i++) {
    days.push(...getWorkingDays(y, m));
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return days;
}

function findNextValidWorkDay(
  target: Date,
  usedDates: Set<string>,
  monthlyCounts: Map<string, number>,
  maxPerMonth: number,
  precomputedCalendar?: Date[],
): Date {
  const calendar = precomputedCalendar ?? generateWorkingCalendar(target.getFullYear(), target.getMonth() + 1, 12);

  for (const day of calendar) {
    if (day >= target && !usedDates.has(dateStr(day))) {
      const mk = monthKey(day);
      if ((monthlyCounts.get(mk) ?? 0) < maxPerMonth) {
        return day;
      }
    }
  }
  return target; // fallback
}

// ─── Season Assignment ───────────────────────────────────────

export function assignSeason(date: Date): string {
  const month = date.getMonth() + 1;
  if ([12, 1, 2, 3, 4].includes(month)) return "wet_peak";
  if ([5, 6, 11].includes(month)) return "wet_transition";
  return "dry";
}

// ─── Shift Schedule (date-based) ─────────────────────────────

export function shiftSchedule(
  rows: ScheduleRow[],
  shiftDays: number,
): { rows: ScheduleRow[]; changes: ScheduleChange[] } {
  const changes: ScheduleChange[] = [];

  const scheduled = rows.filter((r) => r.status === "scheduled");
  const nonScheduled = rows.filter((r) => r.status !== "scheduled");

  if (scheduled.length === 0) return { rows: [...rows], changes };

  // Sort scheduled by deploy date
  const sorted = [...scheduled].sort((a, b) =>
    (a.plannedDeployDate ?? "").localeCompare(b.plannedDeployDate ?? "")
  );

  // Seed used dates and monthly counts from non-scheduled rows
  const deployUsed = new Set<string>();
  const retrieveUsed = new Set<string>();
  const deployMonthly = new Map<string, number>();
  const retrieveMonthly = new Map<string, number>();

  for (const r of nonScheduled) {
    if (r.plannedDeployDate) {
      deployUsed.add(r.plannedDeployDate);
      const mk = monthKey(parseDate(r.plannedDeployDate));
      deployMonthly.set(mk, (deployMonthly.get(mk) ?? 0) + 1);
    }
    if (r.plannedRetrieveDate) {
      retrieveUsed.add(r.plannedRetrieveDate);
      const mk = monthKey(parseDate(r.plannedRetrieveDate));
      retrieveMonthly.set(mk, (retrieveMonthly.get(mk) ?? 0) + 1);
    }
  }

  // Pre-compute calendar once for all iterations
  const firstDate = sorted.find((r) => r.plannedDeployDate)?.plannedDeployDate;
  const calendarStart = firstDate ? parseDate(firstDate) : new Date();
  const calendar = generateWorkingCalendar(calendarStart.getFullYear(), calendarStart.getMonth() + 1, 24);

  const updatedScheduled: ScheduleRow[] = [];

  for (const row of sorted) {
    if (!row.plannedDeployDate) {
      updatedScheduled.push(row);
      continue;
    }

    const oldDeploy = parseDate(row.plannedDeployDate);
    const targetDeploy = new Date(oldDeploy);
    targetDeploy.setDate(targetDeploy.getDate() + shiftDays);

    const newDeploy = findNextValidWorkDay(targetDeploy, deployUsed, deployMonthly, MAX_DEPLOYS_PER_MONTH, calendar);
    const newDeployStr = dateStr(newDeploy);
    deployUsed.add(newDeployStr);
    const mk = monthKey(newDeploy);
    deployMonthly.set(mk, (deployMonthly.get(mk) ?? 0) + 1);

    if (newDeployStr !== row.plannedDeployDate) {
      changes.push({
        deploymentId: row.deploymentId,
        field: "plannedDeployDate",
        oldValue: row.plannedDeployDate,
        newValue: newDeployStr,
      });
    }

    let newRetrieveStr = row.plannedRetrieveDate;
    if (row.plannedRetrieveDate) {
      const oldRetrieve = parseDate(row.plannedRetrieveDate);
      const duration = Math.round((oldRetrieve.getTime() - oldDeploy.getTime()) / 86_400_000);
      const targetRetrieve = new Date(newDeploy);
      targetRetrieve.setDate(targetRetrieve.getDate() + duration);

      const newRetrieve = findNextValidWorkDay(targetRetrieve, retrieveUsed, retrieveMonthly, MAX_RETRIEVES_PER_MONTH, calendar);
      newRetrieveStr = dateStr(newRetrieve);
      retrieveUsed.add(newRetrieveStr);
      const rmk = monthKey(newRetrieve);
      retrieveMonthly.set(rmk, (retrieveMonthly.get(rmk) ?? 0) + 1);

      if (newRetrieveStr !== row.plannedRetrieveDate) {
        changes.push({
          deploymentId: row.deploymentId,
          field: "plannedRetrieveDate",
          oldValue: row.plannedRetrieveDate,
          newValue: newRetrieveStr,
        });
      }
    }

    updatedScheduled.push({
      ...row,
      plannedDeployDate: newDeployStr,
      plannedRetrieveDate: newRetrieveStr,
      season: assignSeason(newDeploy),
    });
  }

  const result = [...nonScheduled, ...updatedScheduled].sort((a, b) =>
    (a.plannedDeployDate ?? "").localeCompare(b.plannedDeployDate ?? "")
  );

  return { rows: result, changes };
}

// ─── Shift Schedule (slot-based) ─────────────────────────────

export function shiftScheduleBySlots(
  rows: ScheduleRow[],
  slots: SlotRow[],
  shiftSlots: number,
): { rows: ScheduleRow[]; changes: ScheduleChange[] } {
  const changes: ScheduleChange[] = [];

  const slotMap = new Map(slots.map((s) => [s.slotId, s.slotDate]));
  const minSlot = Math.min(...slots.map((s) => s.slotId));
  const maxSlot = Math.max(...slots.map((s) => s.slotId));

  const result = rows.map((row) => {
    if (row.status !== "scheduled" || row.deploySlotId === null) return row;

    const updated = { ...row };

    // Deploy slot
    const oldDeploySlot = row.deploySlotId;
    let newDeploySlot = Math.max(minSlot, Math.min(maxSlot, oldDeploySlot + shiftSlots));

    if (newDeploySlot !== oldDeploySlot) {
      const oldDate = slotMap.get(oldDeploySlot) ?? "unknown";
      const newDate = slotMap.get(newDeploySlot) ?? "unknown";
      changes.push({
        deploymentId: row.deploymentId,
        field: "deploySlotId",
        oldValue: `${oldDeploySlot} (${oldDate})`,
        newValue: `${newDeploySlot} (${newDate})`,
      });
      updated.deploySlotId = newDeploySlot;
      updated.plannedDeployDate = newDate !== "unknown" ? newDate : row.plannedDeployDate;
      if (newDate !== "unknown") updated.season = assignSeason(parseDate(newDate));
    }

    // Retrieve slot
    if (row.retrieveSlotId !== null) {
      const oldRetrieveSlot = row.retrieveSlotId;
      let newRetrieveSlot = Math.max(minSlot, Math.min(maxSlot, oldRetrieveSlot + shiftSlots));

      if (newRetrieveSlot !== oldRetrieveSlot) {
        const oldDate = slotMap.get(oldRetrieveSlot) ?? "unknown";
        const newDate = slotMap.get(newRetrieveSlot) ?? "unknown";
        changes.push({
          deploymentId: row.deploymentId,
          field: "retrieveSlotId",
          oldValue: `${oldRetrieveSlot} (${oldDate})`,
          newValue: `${newRetrieveSlot} (${newDate})`,
        });
        updated.retrieveSlotId = newRetrieveSlot;
        updated.plannedRetrieveDate = newDate !== "unknown" ? newDate : row.plannedRetrieveDate;
      }
    }

    return updated;
  });

  result.sort((a, b) =>
    (a.plannedDeployDate ?? "").localeCompare(b.plannedDeployDate ?? "")
  );

  return { rows: result, changes };
}

// ─── Swap Deployment Dates ───────────────────────────────────

export function swapDeploymentDates(
  rows: ScheduleRow[],
  id1: string,
  id2: string,
): { rows: ScheduleRow[]; changes: ScheduleChange[] } {
  const changes: ScheduleChange[] = [];

  const idx1 = rows.findIndex((r) => r.deploymentId === id1);
  const idx2 = rows.findIndex((r) => r.deploymentId === id2);

  if (idx1 === -1) throw new Error(`Deployment ${id1} not found`);
  if (idx2 === -1) throw new Error(`Deployment ${id2} not found`);
  if (rows[idx1].status !== "scheduled") throw new Error(`${id1} is not scheduled`);
  if (rows[idx2].status !== "scheduled") throw new Error(`${id2} is not scheduled`);

  const result = [...rows];
  const r1 = { ...result[idx1] };
  const r2 = { ...result[idx2] };

  const swapFields: (keyof ScheduleRow)[] = [
    "plannedDeployDate",
    "plannedRetrieveDate",
    "deploySlotId",
    "retrieveSlotId",
  ];

  for (const field of swapFields) {
    const v1 = String(r1[field] ?? "N/A");
    const v2 = String(r2[field] ?? "N/A");
    if (v1 !== v2) {
      changes.push({ deploymentId: id1, field, oldValue: v1, newValue: v2 });
      changes.push({ deploymentId: id2, field, oldValue: v2, newValue: v1 });
    }
    const tmp = r1[field];
    (r1 as Record<string, unknown>)[field] = r2[field];
    (r2 as Record<string, unknown>)[field] = tmp;
  }

  // Recalculate seasons
  if (r1.plannedDeployDate) {
    const newSeason = assignSeason(parseDate(r1.plannedDeployDate));
    if (r1.season !== newSeason) {
      changes.push({ deploymentId: id1, field: "season", oldValue: r1.season, newValue: newSeason });
      r1.season = newSeason;
    }
  }
  if (r2.plannedDeployDate) {
    const newSeason = assignSeason(parseDate(r2.plannedDeployDate));
    if (r2.season !== newSeason) {
      changes.push({ deploymentId: id2, field: "season", oldValue: r2.season, newValue: newSeason });
      r2.season = newSeason;
    }
  }

  result[idx1] = r1;
  result[idx2] = r2;

  return { rows: result, changes };
}

// ─── Add New Site ────────────────────────────────────────────

export function addSiteToSchedule(
  rows: ScheduleRow[],
  siteInfo: { siteId: string; siteName: string; habitatType: string },
): { rows: ScheduleRow[]; newDeployments: ScheduleRow[] } {
  // Build date usage sets from existing rows
  const deployUsed = new Set<string>();
  const retrieveUsed = new Set<string>();
  const deployMonthly = new Map<string, number>();
  const retrieveMonthly = new Map<string, number>();

  for (const r of rows) {
    if (r.plannedDeployDate) {
      deployUsed.add(r.plannedDeployDate);
      const mk = monthKey(parseDate(r.plannedDeployDate));
      deployMonthly.set(mk, (deployMonthly.get(mk) ?? 0) + 1);
    }
    if (r.plannedRetrieveDate) {
      retrieveUsed.add(r.plannedRetrieveDate);
      const mk = monthKey(parseDate(r.plannedRetrieveDate));
      retrieveMonthly.set(mk, (retrieveMonthly.get(mk) ?? 0) + 1);
    }
  }

  // Earliest deploy date from existing schedule, or project start
  const deployDates = rows.map((r) => r.plannedDeployDate).filter(Boolean) as string[];
  const firstAvailable = deployDates.length > 0
    ? parseDate(deployDates.sort()[0])
    : new Date(FIRST_MONTH_YEAR, FIRST_MONTH_MONTH - 1, FIRST_MONTH_START_DAY);

  // Pre-compute calendar once for all visits
  const calendar = generateWorkingCalendar(firstAvailable.getFullYear(), firstAvailable.getMonth() + 1, 24);

  const newDeployments: ScheduleRow[] = [];

  for (let visit = 1; visit <= VISITS_PER_SITE; visit++) {
    let targetDate: Date;
    if (visit === 1) {
      targetDate = firstAvailable;
    } else {
      const prev = parseDate(newDeployments[visit - 2].plannedDeployDate!);
      const targetMonth = prev.getMonth() + MONTHS_BETWEEN_VISITS;
      targetDate = new Date(prev.getFullYear(), targetMonth, WORK_DAY_START);
    }

    const deployDate = findNextValidWorkDay(targetDate, deployUsed, deployMonthly, MAX_DEPLOYS_PER_MONTH, calendar);
    deployUsed.add(dateStr(deployDate));
    const dmk = monthKey(deployDate);
    deployMonthly.set(dmk, (deployMonthly.get(dmk) ?? 0) + 1);

    const targetRetrieve = new Date(deployDate);
    targetRetrieve.setDate(targetRetrieve.getDate() + DEPLOYMENT_DURATION_DAYS);
    const retrieveDate = findNextValidWorkDay(targetRetrieve, retrieveUsed, retrieveMonthly, MAX_RETRIEVES_PER_MONTH, calendar);
    retrieveUsed.add(dateStr(retrieveDate));
    const rmk = monthKey(retrieveDate);
    retrieveMonthly.set(rmk, (retrieveMonthly.get(rmk) ?? 0) + 1);

    newDeployments.push({
      deploymentId: `${siteInfo.siteId}_V${visit}`,
      siteId: siteInfo.siteId,
      siteName: siteInfo.siteName,
      habitatType: siteInfo.habitatType,
      visitNumber: visit,
      season: assignSeason(deployDate),
      plannedDeployDate: dateStr(deployDate),
      plannedRetrieveDate: dateStr(retrieveDate),
      actualDeployDate: null,
      actualRetrieveDate: null,
      status: "scheduled",
      deploySlotId: null,
      retrieveSlotId: null,
      notes: "Auto-generated",
    });
  }

  const result = [...rows, ...newDeployments].sort((a, b) =>
    (a.plannedDeployDate ?? "").localeCompare(b.plannedDeployDate ?? "")
  );

  return { rows: result, newDeployments };
}

// ─── Validate Schedule ───────────────────────────────────────

export function validateSchedule(rows: ScheduleRow[]): string[] {
  const errors: string[] = [];

  for (const row of rows) {
    if (row.plannedDeployDate) {
      const d = parseDate(row.plannedDeployDate);
      if (!isValidWorkDay(d)) {
        errors.push(
          `${row.deploymentId}: Fecha instalación ${row.plannedDeployDate} no es día hábil (día ${d.getDate()}, debe ser 11-30)`,
        );
      }
    }
    if (row.plannedRetrieveDate) {
      const d = parseDate(row.plannedRetrieveDate);
      if (!isValidWorkDay(d)) {
        errors.push(
          `${row.deploymentId}: Fecha recuperación ${row.plannedRetrieveDate} no es día hábil (día ${d.getDate()}, debe ser 11-30)`,
        );
      }
    }
  }

  // Check duplicate deploy dates
  const deployDates = new Map<string, string[]>();
  for (const r of rows) {
    if (r.plannedDeployDate) {
      const arr = deployDates.get(r.plannedDeployDate) ?? [];
      arr.push(r.deploymentId);
      deployDates.set(r.plannedDeployDate, arr);
    }
  }
  for (const [date, ids] of deployDates) {
    if (ids.length > 1) {
      errors.push(`Múltiples instalaciones (${ids.length}) programadas para ${date}: ${ids.join(", ")}`);
    }
  }

  // Check duplicate retrieve dates
  const retrieveDates = new Map<string, string[]>();
  for (const r of rows) {
    if (r.plannedRetrieveDate) {
      const arr = retrieveDates.get(r.plannedRetrieveDate) ?? [];
      arr.push(r.deploymentId);
      retrieveDates.set(r.plannedRetrieveDate, arr);
    }
  }
  for (const [date, ids] of retrieveDates) {
    if (ids.length > 1) {
      errors.push(`Múltiples recuperaciones (${ids.length}) programadas para ${date}: ${ids.join(", ")}`);
    }
  }

  return errors;
}

// ─── Validate Slot Schedule ──────────────────────────────────

export function validateSlotSchedule(rows: ScheduleRow[], slots: SlotRow[]): string[] {
  const errors: string[] = [];

  const minSlot = Math.min(...slots.map((s) => s.slotId));
  const maxSlot = Math.max(...slots.map((s) => s.slotId));
  const slotMap = new Map(slots.map((s) => [s.slotId, s.slotDate]));

  for (const row of rows) {
    if (row.deploySlotId !== null) {
      if (row.deploySlotId < minSlot || row.deploySlotId > maxSlot) {
        errors.push(`${row.deploymentId}: deploy_slot_id ${row.deploySlotId} fuera de rango (${minSlot}-${maxSlot})`);
      }
      const expected = slotMap.get(row.deploySlotId);
      if (expected && row.plannedDeployDate && expected !== row.plannedDeployDate) {
        errors.push(`${row.deploymentId}: fecha no coincide - ranura ${row.deploySlotId} = ${expected}, pero fecha es ${row.plannedDeployDate}`);
      }
    }
    if (row.retrieveSlotId !== null) {
      if (row.retrieveSlotId < minSlot || row.retrieveSlotId > maxSlot) {
        errors.push(`${row.deploymentId}: retrieve_slot_id ${row.retrieveSlotId} fuera de rango (${minSlot}-${maxSlot})`);
      }
    }
  }

  // Duplicate slots among scheduled items
  const scheduled = rows.filter((r) => r.status === "scheduled");
  const deploySlotCounts = new Map<number, number>();
  for (const r of scheduled) {
    if (r.deploySlotId !== null) {
      deploySlotCounts.set(r.deploySlotId, (deploySlotCounts.get(r.deploySlotId) ?? 0) + 1);
    }
  }
  for (const [slot, count] of deploySlotCounts) {
    if (count > 1) errors.push(`Ranura ${slot} tiene ${count} instalaciones asignadas`);
  }

  return errors;
}
