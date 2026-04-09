import { describe, it, expect } from "vitest";
import { computeWindowQc } from "@/lib/deployment-window-qc";

describe("computeWindowQc", () => {
  const window = {
    odkDeployAt: "2026-03-01 09:00:00",
    odkRetrieveAt: "2026-03-15 17:00:00",
  };

  it("returns hasWindow=false when ODK datetimes are missing", () => {
    const r = computeWindowQc({
      odkDeployAt: null,
      odkRetrieveAt: null,
      firstFileAt: "2026-03-02 10:00:00",
      lastFileAt: "2026-03-14 12:00:00",
      totalFiles: 100,
      outsideCount: 0,
    });
    expect(r.hasWindow).toBe(false);
    expect(r.hasOutOfWindow).toBe(false);
    expect(r.insidePct).toBe(null);
  });

  it("flags clean coverage as not out-of-window", () => {
    const r = computeWindowQc({
      ...window,
      firstFileAt: "2026-03-01 10:00:00",
      lastFileAt: "2026-03-15 16:00:00",
      totalFiles: 500,
      outsideCount: 0,
    });
    expect(r.hasWindow).toBe(true);
    expect(r.hasOutOfWindow).toBe(false);
    expect(r.insidePct).toBe(100);
  });

  it("flags first-before-deploy", () => {
    const r = computeWindowQc({
      ...window,
      firstFileAt: "2026-02-28 23:00:00",
      lastFileAt: "2026-03-15 16:00:00",
      totalFiles: 200,
      outsideCount: 5,
    });
    expect(r.hasOutOfWindow).toBe(true);
    expect(r.insidePct).toBe(98);
  });

  it("flags last-after-retrieve", () => {
    const r = computeWindowQc({
      ...window,
      firstFileAt: "2026-03-02 09:00:00",
      lastFileAt: "2026-03-16 09:00:00",
      totalFiles: 100,
      outsideCount: 3,
    });
    expect(r.hasOutOfWindow).toBe(true);
    expect(r.insidePct).toBe(97);
  });

  it("flags both ends out", () => {
    const r = computeWindowQc({
      ...window,
      firstFileAt: "2026-02-20 00:00:00",
      lastFileAt: "2026-03-20 00:00:00",
      totalFiles: 50,
      outsideCount: 12,
    });
    expect(r.hasOutOfWindow).toBe(true);
    expect(r.insidePct).toBe(76);
  });

  it("handles zero files cleanly", () => {
    const r = computeWindowQc({
      ...window,
      firstFileAt: null,
      lastFileAt: null,
      totalFiles: 0,
      outsideCount: 0,
    });
    expect(r.hasWindow).toBe(true);
    expect(r.hasOutOfWindow).toBe(false);
    expect(r.insidePct).toBe(null);
  });

  it("returns null insidePct when outsideCount is null", () => {
    const r = computeWindowQc({
      ...window,
      firstFileAt: "2026-03-02 09:00:00",
      lastFileAt: "2026-03-14 09:00:00",
      totalFiles: 100,
      outsideCount: null,
    });
    expect(r.hasOutOfWindow).toBe(false);
    expect(r.insidePct).toBe(null);
  });
});
