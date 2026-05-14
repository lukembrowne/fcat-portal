/**
 * URL search-param whitelist parsers for the species browser.
 *
 * All callers MUST run params through these helpers before any Drizzle
 * query, so that hand-crafted URLs cannot trigger type coercion against
 * untrusted strings.
 */

export const VERIFICATION_STATUSES = [
  "unverified",
  "verified",
  "corrected",
  "rejected",
] as const;

export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/** Default: every status except rejected. */
export const DEFAULT_STATUSES: readonly VerificationStatus[] = [
  "unverified",
  "verified",
  "corrected",
];

function first(value: string | string[] | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

export function parseStatuses(
  raw: string | string[] | undefined | null
): VerificationStatus[] {
  const value = first(raw);
  if (!value) return [...DEFAULT_STATUSES];
  const parts = value.split(",").map((p) => p.trim()).filter(Boolean);
  const filtered = parts.filter((p): p is VerificationStatus =>
    VERIFICATION_STATUSES.includes(p as VerificationStatus)
  );
  return filtered.length > 0 ? filtered : [...DEFAULT_STATUSES];
}

/**
 * Parses a numeric camera-trap project ID and intersects it with the
 * user's accessible projects. Returns null when missing, malformed, or
 * outside the user's scope.
 */
export function parseProjectId(
  raw: string | string[] | undefined | null,
  userProjects: number[] | "all"
): number | null {
  const value = first(raw);
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  if (!Number.isInteger(n) || n < 1) return null;
  if (userProjects !== "all" && !userProjects.includes(n)) return null;
  return n;
}

export function parsePositiveInt(
  raw: string | string[] | undefined | null,
  fallback = 1,
  max = 1_000_000
): number {
  const value = first(raw);
  const n = Number.parseInt(value ?? "", 10);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/**
 * Clamps a `?seek=` (or similar) seconds param into [0, maxDuration].
 * Returns 0 for missing, malformed, or negative input.
 */
export function clampSeekSeconds(
  raw: string | string[] | undefined | null,
  maxDuration: number
): number {
  const value = first(raw);
  const n = Number.parseFloat(value ?? "");
  if (!Number.isFinite(n) || n < 0) return 0;
  if (!Number.isFinite(maxDuration) || maxDuration <= 0) return 0;
  return Math.min(n, maxDuration);
}
