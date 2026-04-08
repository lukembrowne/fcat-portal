import { describe, it, expect } from "vitest";
import { parseSampleRateSeconds } from "@/app/biochoco/ibutton/sample-rate";

describe("parseSampleRateSeconds", () => {
  it("parses HH:MM:SS", () => {
    expect(parseSampleRateSeconds("00:30:00")).toBe(1800);
    expect(parseSampleRateSeconds("01:00:00")).toBe(3600);
    expect(parseSampleRateSeconds("00:00:15")).toBe(15);
  });

  it("parses minute shorthand", () => {
    expect(parseSampleRateSeconds("30 min")).toBe(1800);
    expect(parseSampleRateSeconds("5 minutes")).toBe(300);
    expect(parseSampleRateSeconds("1 minute")).toBe(60);
  });

  it("parses hour shorthand", () => {
    expect(parseSampleRateSeconds("1 hr")).toBe(3600);
    expect(parseSampleRateSeconds("2 hours")).toBe(7200);
  });

  it("parses second shorthand", () => {
    expect(parseSampleRateSeconds("45 sec")).toBe(45);
    expect(parseSampleRateSeconds("10 seconds")).toBe(10);
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(parseSampleRateSeconds("  30 MIN  ")).toBe(1800);
    expect(parseSampleRateSeconds("1 HR")).toBe(3600);
  });

  it("returns null for null, empty, or garbage", () => {
    expect(parseSampleRateSeconds(null)).toBeNull();
    expect(parseSampleRateSeconds("")).toBeNull();
    expect(parseSampleRateSeconds("   ")).toBeNull();
    expect(parseSampleRateSeconds("abc")).toBeNull();
    expect(parseSampleRateSeconds("30")).toBeNull();
  });
});
