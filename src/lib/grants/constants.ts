/**
 * Client-safe constants + formatters for the grant tracking module.
 * No runtime imports from the Drizzle schema (type-only) — safe in Client Components.
 *
 * NOTE: The grant tracking module is intentionally in ENGLISH (a deliberate exception
 * to the portal's Spanish-UI convention) so it can be shared with English-speaking
 * collaborators. Do not "fix" these strings back to Spanish.
 */
import type {
  GrantStatus,
  FunderPriority,
  GrantFundingEntity,
} from "@/db/schema";

export const GRANT_STATUS_LABELS: Record<GrantStatus, string> = {
  to_research: "To Research",
  in_prep: "In Preparation",
  pending_decision: "Pending Decision",
  funded: "Funded",
  rejected: "Rejected",
  passed: "Passed",
  completed: "Completed",
};

export const GRANT_STATUS_COLORS: Record<GrantStatus, string> = {
  to_research: "bg-slate-100 text-slate-800",
  in_prep: "bg-blue-100 text-blue-800",
  pending_decision: "bg-yellow-100 text-yellow-800",
  funded: "bg-green-100 text-green-800",
  rejected: "bg-red-100 text-red-800",
  passed: "bg-gray-100 text-gray-600",
  completed: "bg-emerald-100 text-emerald-800",
};

/** Pipeline order for selects + status columns. */
export const GRANT_STATUS_ORDER: GrantStatus[] = [
  "to_research",
  "in_prep",
  "pending_decision",
  "funded",
  "rejected",
  "passed",
  "completed",
];

/** Statuses considered decided (no longer active in the pipeline). */
export const GRANT_DECIDED_STATUSES: GrantStatus[] = [
  "funded",
  "rejected",
  "passed",
  "completed",
];

/**
 * Statuses that count toward the success rate — grants we actually applied to
 * and received a verdict on. Excludes "passed" (opportunities we deliberately
 * chose not to pursue, so they shouldn't drag down the win rate).
 */
export const GRANT_SUCCESS_DENOMINATOR_STATUSES: GrantStatus[] = [
  "funded",
  "rejected",
  "completed",
];

/**
 * Which FCAT entity received the money. Unset is a legitimate state — a grant
 * that isn't funded yet has no entity, so the cell and the form both keep an
 * empty choice.
 */
export const GRANT_FUNDING_ENTITY_LABELS: Record<GrantFundingEntity, string> = {
  fcat_ecuador: "FCAT-Ecuador",
  fcat_usa: "FCAT-USA",
};

/** Badge colors per entity — distinct hues, not a severity ramp. */
export const GRANT_FUNDING_ENTITY_COLORS: Record<GrantFundingEntity, string> = {
  fcat_ecuador: "bg-sky-100 text-sky-800",
  fcat_usa: "bg-violet-100 text-violet-800",
};

/** Display order for selects. */
export const GRANT_FUNDING_ENTITY_ORDER: GrantFundingEntity[] = [
  "fcat_ecuador",
  "fcat_usa",
];

export const FUNDER_PRIORITY_LABELS: Record<FunderPriority, string> = {
  highest: "Highest",
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** Badge colors per priority level (hottest = highest). */
export const FUNDER_PRIORITY_COLORS: Record<FunderPriority, string> = {
  highest: "bg-red-100 text-red-800",
  high: "bg-orange-100 text-orange-800",
  medium: "bg-amber-100 text-amber-800",
  low: "bg-slate-100 text-slate-700",
};

/**
 * Two-tier automatic reminder thresholds (descending), in days before the due
 * date. Every active grant emails the team once when it crosses each threshold —
 * no per-grant config. Replaces the old per-grant `notifyBeforeDays` window.
 */
export const GRANT_REMINDER_DAYS = [30, 14] as const;

/**
 * How many reminder thresholds the grant has entered (0 if not due yet or
 * overdue). e.g. days=40 → 0, 30 → 1, 25 → 1, 14 → 2, 8 → 2, 0 → 2, -2 → 0.
 * The cron emails a grant iff this level exceeds the count already sent.
 */
export function reminderLevel(days: number | null): number {
  if (days == null || days < 0) return 0;
  return GRANT_REMINDER_DAYS.filter((t) => days <= t).length;
}

/**
 * Fields the inline row editor on /grants is allowed to write. Whitelisted so a
 * crafted call can't touch columns the table doesn't expose (id, createdAt, …).
 * Lives here (not in the "use server" actions file, which may only export async
 * functions) so both the action and the client cells can import it.
 */
export const EDITABLE_GRANT_FIELDS = [
  "name",
  "projectTitle",
  "status",
  "amountRequested",
  "amountAwarded",
  "fundingEntity",
  "dueDate",
  "startDate",
  "endDate",
  "notes",
  "website",
  "folderLink",
  "budgetLink",
  "proposalLink",
  "funderId",
  "funderNameRaw",
] as const;
export type EditableGrantField = (typeof EDITABLE_GRANT_FIELDS)[number];

/**
 * Fields the inline row editor on /grants/funders is allowed to write. Same
 * whitelist rationale as {@link EDITABLE_GRANT_FIELDS}. Non-displayed funder
 * fields (research links, funding history) stay on the detail/edit form.
 */
export const EDITABLE_FUNDER_FIELDS = [
  "name",
  "priority",
  "funderType",
  "focusAreas",
  "relationshipManager",
  "relationshipStatus",
  "nextSteps",
  "nextStepDue",
  "contactName",
  "contactEmail",
  "description",
  "notes",
  "website",
  "fundingHistory",
  "irs990Link",
  "guidestarLink",
  "foundationDirectoryLink",
] as const;
export type EditableFunderField = (typeof EDITABLE_FUNDER_FIELDS)[number];

/** Analytics matrix column key for the all-years "Total" column. */
export const TOTAL_KEY = "__total__";
/** Analytics matrix bucket key for grants with no due date. */
export const NO_DATE_KEY = "No date";

export function formatUsd(amount: number | null | undefined): string {
  if (amount == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}

export function formatDate(d: Date | null | undefined): string {
  if (!d) return "—";
  // Date-only fields are stored at UTC midnight; format in UTC to avoid day drift.
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** Date + time, e.g. "Jun 22, 2026, 8:43 PM" (local time). For audit subtext. */
export function formatDateTime(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Date → "YYYY-MM-DD" (UTC) for <input type="date"> values. */
export function toDateInput(d: Date | null | undefined): string | null {
  if (!d) return null;
  return d.toISOString().slice(0, 10);
}

/** Whole days from now until `due` (negative = overdue). null if no date. */
export function daysUntil(due: Date | null | undefined, now: Date = new Date()): number | null {
  if (!due) return null;
  return Math.round((due.getTime() - now.getTime()) / 86_400_000);
}
