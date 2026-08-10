import { describe, it, expect } from "vitest";
import { canMarkNoData, canUndoNoData } from "@/lib/camera-trap-status";

describe("canMarkNoData", () => {
  it("allows unscanned and scanned deployments with zero media", () => {
    expect(canMarkNoData("unscanned", 0, 0, false)).toBe(true);
    expect(canMarkNoData("scanned", 0, 0, false)).toBe(true);
  });

  it("refuses any deployment with files", () => {
    expect(canMarkNoData("scanned", 1, 0, false)).toBe(false);
    expect(canMarkNoData("scanned", 0, 1, false)).toBe(false);
    expect(canMarkNoData("scanned", 250, 3, false)).toBe(false);
  });

  it("refuses while a job is processing", () => {
    expect(canMarkNoData("scanned", 0, 0, true)).toBe(false);
  });

  it("refuses every non-pre-processing status", () => {
    for (const status of ["processing", "processed", "verified", "verified_empty", "no_data"]) {
      expect(canMarkNoData(status, 0, 0, false)).toBe(false);
    }
  });
});

describe("canUndoNoData", () => {
  it("allows only no_data deployments", () => {
    expect(canUndoNoData("no_data")).toBe(true);
    for (const status of ["unscanned", "scanned", "processing", "processed", "verified", "verified_empty"]) {
      expect(canUndoNoData(status)).toBe(false);
    }
  });
});
