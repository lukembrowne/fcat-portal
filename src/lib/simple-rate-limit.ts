/**
 * Minimal in-memory fixed-window rate limiter.
 *
 * The portal runs as a single Node process per container, so a module-level Map
 * is sufficient — no Redis needed. Intended for low-traffic machine endpoints
 * (e.g. the field-upload deployment list) to blunt token-leak enumeration and
 * accidental polling storms. NOT a distributed limiter.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Returns true if the request for `key` is allowed, false if it exceeds `limit`
 * within `windowMs`. Counts the current request when allowed.
 */
export function rateLimitAllow(
  key: string,
  limit = 30,
  windowMs = 60_000,
): boolean {
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || now >= existing.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (existing.count >= limit) return false;
  existing.count += 1;
  return true;
}

/** Test helper: clear all buckets. */
export function __resetRateLimitForTests(): void {
  buckets.clear();
}
