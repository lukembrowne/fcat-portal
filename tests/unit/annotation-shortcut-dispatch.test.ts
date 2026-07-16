/**
 * Unit tests for resolveDigitKeyAction — the pure digit-key resolver behind
 * the camera-trap annotation shortcuts. Node environment (no DOM) — the whole
 * point of extracting the resolver is to test the branch table directly.
 */

import { describe, expect, it } from "vitest";
import { resolveDigitKeyAction } from "@/hooks/use-annotation-shortcuts";

describe("resolveDigitKeyAction", () => {
  it("0 with a detection selected → repeat last species on that box", () => {
    expect(
      resolveDigitKeyAction("0", { selectedDetectionId: 42, detectionCount: 3 })
    ).toEqual({ type: "assignLast" });
  });

  it("0 with NO detection selected → assign last species to all (new branch)", () => {
    expect(
      resolveDigitKeyAction("0", { selectedDetectionId: null, detectionCount: 3 })
    ).toEqual({ type: "assignLastToAll" });
  });

  it("1 with a detection selected → assign frecuente slot 0", () => {
    expect(
      resolveDigitKeyAction("1", { selectedDetectionId: 42, detectionCount: 3 })
    ).toEqual({ type: "assignByIndex", index: 0 });
  });

  it("1 with no selection and >=1 detection → select detection 0", () => {
    expect(
      resolveDigitKeyAction("1", { selectedDetectionId: null, detectionCount: 3 })
    ).toEqual({ type: "selectDetection", index: 0 });
  });

  it("5 with no selection but only 2 detections → none (out of range)", () => {
    expect(
      resolveDigitKeyAction("5", { selectedDetectionId: null, detectionCount: 2 })
    ).toEqual({ type: "none" });
  });

  it("1 with no selection and zero detections → none", () => {
    expect(
      resolveDigitKeyAction("1", { selectedDetectionId: null, detectionCount: 0 })
    ).toEqual({ type: "none" });
  });

  it("non-digit key → none", () => {
    expect(
      resolveDigitKeyAction("a", { selectedDetectionId: null, detectionCount: 3 })
    ).toEqual({ type: "none" });
  });

  it("0 with no selection is independent of detectionCount", () => {
    // The assign-all path does not depend on count; the handler guards the
    // empty-animal case downstream.
    expect(
      resolveDigitKeyAction("0", { selectedDetectionId: null, detectionCount: undefined })
    ).toEqual({ type: "assignLastToAll" });
  });
});
