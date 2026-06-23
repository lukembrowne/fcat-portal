import { describe, it, expect } from "vitest";
import {
  parseAmount,
  parseDateToSeconds,
  parseDays,
  mapStatus,
  mapPriority,
  excelSerialToDate,
} from "@/lib/grants/coerce";
import { normalizeFunderName } from "@/lib/grants/normalize";

describe("normalizeFunderName", () => {
  it("lowercases, trims, drops leading 'the', collapses whitespace", () => {
    expect(normalizeFunderName("The Nature Conservancy")).toBe("nature conservancy");
    expect(normalizeFunderName("  IUCN  ")).toBe("iucn");
    expect(normalizeFunderName("Gordon  and   Betty Moore")).toBe("gordon and betty moore");
  });
  it("matches differently-cased/spaced variants to the same key", () => {
    expect(normalizeFunderName("USFWS LATAM")).toBe(normalizeFunderName("usfws latam"));
  });
  it("does NOT collapse multi-funder strings to one funder", () => {
    expect(normalizeFunderName("The Nature Conservancy, WCS")).toBe(
      "nature conservancy, wcs"
    );
  });
});

describe("parseAmount", () => {
  it("strips currency formatting", () => {
    expect(parseAmount("$50,000")).toBe(50000);
    expect(parseAmount("2,500,000")).toBe(2500000);
  });
  it("passes through numbers", () => {
    expect(parseAmount(118000)).toBe(118000);
  });
  it("returns null for blank/garbage (never NaN or 0)", () => {
    expect(parseAmount("")).toBeNull();
    expect(parseAmount(null)).toBeNull();
    expect(parseAmount("N/A")).toBeNull();
    expect(parseAmount("-")).toBeNull();
  });
});

describe("parseDateToSeconds", () => {
  it("converts an Excel serial to the correct UTC calendar date", () => {
    // 46080 corresponds to 2026-02-04 (UTC) in Excel's 1900 system.
    const secs = parseDateToSeconds(46080)!;
    const d = new Date(secs * 1000);
    expect(d.getUTCFullYear()).toBe(2026);
  });
  it("handles JS Date instances (cellDates:true path)", () => {
    const d = new Date(Date.UTC(2026, 7, 1));
    expect(parseDateToSeconds(d)).toBe(Math.floor(d.getTime() / 1000));
  });
  it("parses M/D/YYYY strings as UTC midnight", () => {
    const secs = parseDateToSeconds("8/1/2026")!;
    expect(new Date(secs * 1000).toISOString()).toBe("2026-08-01T00:00:00.000Z");
  });
  it("returns null for empty/zero", () => {
    expect(parseDateToSeconds("")).toBeNull();
    expect(parseDateToSeconds(0)).toBeNull();
    expect(parseDateToSeconds(null)).toBeNull();
  });
  it("never produces out-of-era timestamps from real serials", () => {
    const secs = parseDateToSeconds(46080)!;
    expect(secs).toBeGreaterThan(946684800); // > year 2000
    expect(secs).toBeLessThan(4102444800); // < year 2100
  });
});

describe("excelSerialToDate", () => {
  it("round-trips the epoch reference", () => {
    // serial 25569 == 1970-01-01
    expect(excelSerialToDate(25569).toISOString().slice(0, 10)).toBe("1970-01-01");
  });
});

describe("parseDays", () => {
  it("defaults blank to 14", () => {
    expect(parseDays("")).toBe(14);
    expect(parseDays(null)).toBe(14);
  });
  it("parses valid values", () => {
    expect(parseDays("28")).toBe(28);
    expect(parseDays(30)).toBe(30);
  });
  it("rejects negatives back to default", () => {
    expect(parseDays("-5")).toBe(14);
  });
});

describe("mapStatus", () => {
  it("maps the sheet's exact labels", () => {
    expect(mapStatus("In Prep")).toBe("in_prep");
    expect(mapStatus("Pending Decision")).toBe("pending_decision");
    expect(mapStatus("To Research")).toBe("to_research");
    expect(mapStatus("Passed")).toBe("passed");
  });
  it("falls back to to_research for unknowns", () => {
    expect(mapStatus("Weird")).toBe("to_research");
    expect(mapStatus("")).toBe("to_research");
  });
});

describe("mapPriority", () => {
  it("maps known priorities, nulls unknowns", () => {
    expect(mapPriority("Highest")).toBe("highest");
    expect(mapPriority("High")).toBe("high");
    expect(mapPriority("")).toBeNull();
    expect(mapPriority("Mega")).toBeNull();
  });
});
