/**
 * Shared financial calculation functions.
 *
 * Ported from server.R — budget proration, runway, projected balance.
 */

import {
  MONTHLY_EXPENSE_PROPORTIONS,
  DAYS_IN_MONTHS,
} from "../constants";

/**
 * Calculate the cumulative proportion of annual budget spent by a given day of year.
 * Uses per-day interpolation within each month's proportion (not linear).
 * Ported from server.R lines 1165-1189.
 */
export function budgetProportionByDay(dayOfYear: number): number {
  if (dayOfYear < 1 || dayOfYear > 366) return 0;
  if (dayOfYear === 366) return 1;

  const cumulativeDays = DAYS_IN_MONTHS.reduce<number[]>((acc, d) => {
    acc.push((acc.length > 0 ? acc[acc.length - 1] : 0) + d);
    return acc;
  }, []);

  const monthIndex = cumulativeDays.findIndex((cd) => cd >= dayOfYear);
  const daysBefore =
    monthIndex > 0 ? cumulativeDays[monthIndex - 1] : 0;
  const dayOfMonth = dayOfYear - daysBefore;

  const dailyProportion =
    MONTHLY_EXPENSE_PROPORTIONS[monthIndex] / DAYS_IN_MONTHS[monthIndex];

  const cumulativeBefore =
    monthIndex > 0
      ? MONTHLY_EXPENSE_PROPORTIONS.slice(0, monthIndex).reduce(
          (a, b) => a + b,
          0
        )
      : 0;

  return cumulativeBefore + dailyProportion * dayOfMonth;
}

/**
 * Get the day of year for a given date string (YYYY-MM-DD).
 */
export function dayOfYear(dateStr: string): number {
  const d = new Date(dateStr + "T00:00:00Z");
  const start = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return (
    Math.floor((d.getTime() - start.getTime()) / 86400000) + 1
  );
}

/**
 * Cash runway calculation: months of cash on hand.
 * runway_months = last_bank_balance / (annual_operating_expenses / 12)
 */
export function calculateRunwayMonths(
  bankBalance: number,
  annualOperatingExpenses: number
): number {
  if (annualOperatingExpenses <= 0) return 0;
  return Math.round((bankBalance / (annualOperatingExpenses / 12)) * 100) / 100;
}

/**
 * Generate a sequence of month strings from start to end (inclusive).
 * e.g., "2025-01-01" to "2025-06-01" → ["2025-01-01", "2025-02-01", ..., "2025-06-01"]
 */
export function monthSequence(startMonth: string, endMonth: string): string[] {
  const months: string[] = [];
  const [sy, sm] = startMonth.split("-").map(Number);
  const [ey, em] = endMonth.split("-").map(Number);

  let y = sy;
  let m = sm;
  while (y < ey || (y === ey && m <= em)) {
    months.push(`${y}-${String(m).padStart(2, "0")}-01`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return months;
}

/**
 * Get the date range for a preset.
 */
export function getDateRangeForPreset(
  preset: string
): { from: string; to: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-indexed

  switch (preset) {
    case "this-year":
      return {
        from: `${y}-01-01`,
        to: `${y}-12-31`,
      };
    case "last-year":
      return {
        from: `${y - 1}-01-01`,
        to: `${y - 1}-12-31`,
      };
    case "this-month": {
      const lastDay = new Date(y, m + 1, 0).getDate();
      return {
        from: `${y}-${String(m + 1).padStart(2, "0")}-01`,
        to: `${y}-${String(m + 1).padStart(2, "0")}-${lastDay}`,
      };
    }
    case "last-month": {
      const pm = m === 0 ? 11 : m - 1;
      const py = m === 0 ? y - 1 : y;
      const lastDay = new Date(py, pm + 1, 0).getDate();
      return {
        from: `${py}-${String(pm + 1).padStart(2, "0")}-01`,
        to: `${py}-${String(pm + 1).padStart(2, "0")}-${lastDay}`,
      };
    }
    default:
      // Default to this year
      return {
        from: `${y}-01-01`,
        to: `${y}-12-31`,
      };
  }
}
