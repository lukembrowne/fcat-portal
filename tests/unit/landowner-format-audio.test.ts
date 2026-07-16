import { describe, it, expect } from "vitest";
import { formatClipDuration } from "@/lib/landowner/format-audio";

describe("formatClipDuration", () => {
  it("formats whole minutes and seconds as m:ss", () => {
    expect(formatClipDuration(83)).toBe("1:23");
    expect(formatClipDuration(60)).toBe("1:00");
    expect(formatClipDuration(9)).toBe("0:09");
  });

  it("rounds fractional seconds", () => {
    expect(formatClipDuration(83.4)).toBe("1:23");
    expect(formatClipDuration(83.6)).toBe("1:24");
  });

  it("returns null for unknown or non-positive durations", () => {
    expect(formatClipDuration(null)).toBeNull();
    expect(formatClipDuration(undefined)).toBeNull();
    expect(formatClipDuration(0)).toBeNull();
    expect(formatClipDuration(-5)).toBeNull();
    expect(formatClipDuration(Number.NaN)).toBeNull();
    expect(formatClipDuration(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
