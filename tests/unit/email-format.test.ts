import { describe, it, expect } from "vitest";
import { formatBytes, formatDuration } from "@/lib/email/format";

describe("formatDuration", () => {
  it("returns em-dash for null or negative input", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(-5)).toBe("—");
  });

  it("formats sub-minute durations in seconds", () => {
    expect(formatDuration(0)).toBe("0 s");
    expect(formatDuration(42_000)).toBe("42 s");
    expect(formatDuration(59_400)).toBe("59 s");
  });

  it("formats sub-hour durations as minutes (+ seconds)", () => {
    expect(formatDuration(60_000)).toBe("1 min");
    expect(formatDuration(4 * 60_000 + 12_000)).toBe("4 min 12 s");
    expect(formatDuration(59 * 60_000)).toBe("59 min");
  });

  it("formats hour-plus durations as hours (+ minutes)", () => {
    expect(formatDuration(60 * 60_000)).toBe("1 h");
    expect(formatDuration(66 * 60_000)).toBe("1 h 6 min");
    expect(formatDuration(2 * 60 * 60_000 + 30 * 60_000)).toBe("2 h 30 min");
  });
});

describe("formatBytes", () => {
  it("formats common magnitudes", () => {
    // B/KB use 0 decimals; MB and larger use 1 decimal (existing behavior).
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1.5 * 1024 * 1024 * 1024 * 1024)).toBe("1.5 TB");
  });
});
