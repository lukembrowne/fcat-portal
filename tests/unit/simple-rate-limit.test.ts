/**
 * Fixed-window in-memory rate limiter.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { rateLimitAllow, __resetRateLimitForTests } from "@/lib/simple-rate-limit";

beforeEach(() => {
  __resetRateLimitForTests();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("rateLimitAllow", () => {
  it("allows up to the limit then blocks", () => {
    for (let i = 0; i < 5; i++) {
      expect(rateLimitAllow("k", 5, 1000)).toBe(true);
    }
    expect(rateLimitAllow("k", 5, 1000)).toBe(false);
  });

  it("isolates keys", () => {
    expect(rateLimitAllow("a", 1, 1000)).toBe(true);
    expect(rateLimitAllow("a", 1, 1000)).toBe(false);
    expect(rateLimitAllow("b", 1, 1000)).toBe(true);
  });

  it("resets after the window elapses", () => {
    expect(rateLimitAllow("k", 1, 1000)).toBe(true);
    expect(rateLimitAllow("k", 1, 1000)).toBe(false);
    vi.advanceTimersByTime(1001);
    expect(rateLimitAllow("k", 1, 1000)).toBe(true);
  });
});
