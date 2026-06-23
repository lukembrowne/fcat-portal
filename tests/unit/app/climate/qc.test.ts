import { describe, it, expect } from "vitest";
import {
  QC_FLAG,
  parseQcFlags,
  serializeQcFlags,
  exportFlag,
  EXPORT_COLUMNS,
} from "@/app/climate/qc";

describe("parseQcFlags / serializeQcFlags", () => {
  it("round-trips a flag map", () => {
    const map = { airTempAvg: { flag: QC_FLAG.RANGE, raw: -8.82 } as const };
    const json = serializeQcFlags(map);
    expect(json).toBe('{"airTempAvg":{"flag":"R","raw":-8.82}}');
    expect(parseQcFlags(json)).toEqual(map);
  });

  it("keeps the column sparse: empty map serializes to null", () => {
    expect(serializeQcFlags({})).toBeNull();
  });

  it("returns an empty map for null/invalid JSON", () => {
    expect(parseQcFlags(null)).toEqual({});
    expect(parseQcFlags(undefined)).toEqual({});
    expect(parseQcFlags("not json")).toEqual({});
  });

  it("preserves a null raw value (e.g. manual null of an already-empty cell)", () => {
    const map = { humidityAvg: { flag: QC_FLAG.MANUAL, raw: null } as const };
    expect(parseQcFlags(serializeQcFlags(map))).toEqual(map);
  });
});

describe("exportFlag", () => {
  it("returns the explicit flag when an entry exists", () => {
    expect(exportFlag(null, { flag: QC_FLAG.RANGE, raw: -8.82 })).toBe("R");
    expect(exportFlag(null, { flag: QC_FLAG.MANUAL, raw: 5 })).toBe("Q");
  });

  it("returns M for a missing value with no entry", () => {
    expect(exportFlag(null, undefined)).toBe("M");
    expect(exportFlag(undefined, undefined)).toBe("M");
  });

  it("returns G for a present, unflagged value", () => {
    expect(exportFlag(24.1, undefined)).toBe("G");
    expect(exportFlag(0, undefined)).toBe("G"); // zero is a real value, not missing
  });
});

describe("EXPORT_COLUMNS", () => {
  it("covers all 22 published measured variables incl. vector wind", () => {
    expect(EXPORT_COLUMNS).toHaveLength(22);
    const fields = EXPORT_COLUMNS.map((c) => c.field);
    expect(fields).toContain("meanWindSpeed");
    expect(fields).toContain("meanWindDirection");
    expect(fields).toContain("stdWindDir");
  });

  it("has unique export keys and field names", () => {
    const keys = new Set(EXPORT_COLUMNS.map((c) => c.key));
    const fields = new Set(EXPORT_COLUMNS.map((c) => c.field));
    expect(keys.size).toBe(EXPORT_COLUMNS.length);
    expect(fields.size).toBe(EXPORT_COLUMNS.length);
  });
});
