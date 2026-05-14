import { describe, expect, it } from "vitest";
import {
  DEFAULT_STATUSES,
  clampSeekSeconds,
  parsePositiveInt,
  parseProjectId,
  parseStatuses,
} from "@/lib/species-search-params";

describe("parseStatuses", () => {
  it("returns the default set for missing input", () => {
    expect(parseStatuses(undefined)).toEqual([...DEFAULT_STATUSES]);
    expect(parseStatuses(null)).toEqual([...DEFAULT_STATUSES]);
    expect(parseStatuses("")).toEqual([...DEFAULT_STATUSES]);
  });

  it("accepts a single whitelisted status", () => {
    expect(parseStatuses("verified")).toEqual(["verified"]);
    expect(parseStatuses("rejected")).toEqual(["rejected"]);
  });

  it("accepts a comma-separated list", () => {
    expect(parseStatuses("verified,unverified")).toEqual(["verified", "unverified"]);
    expect(parseStatuses("corrected, rejected")).toEqual(["corrected", "rejected"]);
  });

  it("drops unknown values", () => {
    expect(parseStatuses("verified,bogus")).toEqual(["verified"]);
    expect(parseStatuses("DROP TABLE,verified")).toEqual(["verified"]);
  });

  it("falls back to defaults when no valid value remains", () => {
    expect(parseStatuses("bogus")).toEqual([...DEFAULT_STATUSES]);
    expect(parseStatuses(",,,")).toEqual([...DEFAULT_STATUSES]);
  });

  it("handles the Next.js array search-param shape", () => {
    expect(parseStatuses(["verified"])).toEqual(["verified"]);
  });
});

describe("parseProjectId", () => {
  it("returns null for missing input", () => {
    expect(parseProjectId(undefined, "all")).toBeNull();
    expect(parseProjectId("", "all")).toBeNull();
    expect(parseProjectId(null, [1, 2])).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(parseProjectId("abc", "all")).toBeNull();
    expect(parseProjectId("-1", "all")).toBeNull();
    expect(parseProjectId("0", "all")).toBeNull();
    expect(parseProjectId("1.5", [1])).toBe(1);
  });

  it("intersects with the user's accessible projects", () => {
    expect(parseProjectId("5", [1, 5, 9])).toBe(5);
    expect(parseProjectId("7", [1, 5, 9])).toBeNull();
  });

  it("super admins ('all') bypass the intersection", () => {
    expect(parseProjectId("99", "all")).toBe(99);
  });
});

describe("parsePositiveInt", () => {
  it("returns the fallback on missing or malformed", () => {
    expect(parsePositiveInt(undefined)).toBe(1);
    expect(parsePositiveInt("abc")).toBe(1);
    expect(parsePositiveInt("0")).toBe(1);
    expect(parsePositiveInt("-3")).toBe(1);
  });

  it("accepts the value verbatim within bounds", () => {
    expect(parsePositiveInt("5")).toBe(5);
    expect(parsePositiveInt("100")).toBe(100);
  });

  it("clamps to the maximum", () => {
    expect(parsePositiveInt("99999999", 1, 50)).toBe(50);
  });

  it("respects a custom fallback", () => {
    expect(parsePositiveInt(undefined, 10)).toBe(10);
    expect(parsePositiveInt("bad", 7)).toBe(7);
  });
});

describe("clampSeekSeconds", () => {
  it("returns 0 for missing or malformed", () => {
    expect(clampSeekSeconds(undefined, 60)).toBe(0);
    expect(clampSeekSeconds("nope", 60)).toBe(0);
    expect(clampSeekSeconds("-5", 60)).toBe(0);
    expect(clampSeekSeconds("Infinity", 60)).toBe(0);
  });

  it("clamps to maxDuration", () => {
    expect(clampSeekSeconds("70", 60)).toBe(60);
    expect(clampSeekSeconds("0", 60)).toBe(0);
  });

  it("accepts in-range values", () => {
    expect(clampSeekSeconds("12.5", 60)).toBe(12.5);
    expect(clampSeekSeconds("3", 60)).toBe(3);
  });

  it("returns 0 when maxDuration is unusable", () => {
    expect(clampSeekSeconds("5", 0)).toBe(0);
    expect(clampSeekSeconds("5", Number.NaN)).toBe(0);
    expect(clampSeekSeconds("5", -10)).toBe(0);
  });
});
