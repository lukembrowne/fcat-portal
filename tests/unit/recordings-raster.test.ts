import { describe, it, expect } from "vitest";
import {
  buildCells,
  computeDomain,
  metricToFill,
  type RasterMetricKey,
} from "@/lib/recordings-raster";
import type { AudioFileRow } from "@/app/audio/actions";

function makeFile(overrides: Partial<AudioFileRow>): AudioFileRow {
  return {
    id: 1,
    filename: "2MM21798_20260209_120000.wav",
    driveFileId: null,
    fileSize: null,
    mimeType: null,
    modifiedAt: null,
    format: null,
    playable: true,
    detectionCount: 0,
    speciesCount: 0,
    recordedDate: "2026-02-09",
    recordedTime: "12:00:00",
    soundscapeSaturation: null,
    acousticComplexityIndex: null,
    frequencyEntropy: null,
    temporalEntropy: null,
    eventsPerSecond: null,
    ...overrides,
  };
}

describe("buildCells", () => {
  it("returns empty arrays for no input", () => {
    const result = buildCells([], "detectionCount");
    expect(result.cells).toEqual([]);
    expect(result.dates).toEqual([]);
    expect(result.skippedCount).toBe(0);
  });

  it("places one file at the right dayIndex/minuteOfDay", () => {
    const result = buildCells(
      [
        makeFile({
          id: 7,
          recordedDate: "2026-02-09",
          recordedTime: "06:30:00",
          detectionCount: 3,
        }),
      ],
      "detectionCount"
    );
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0]).toMatchObject({
      fileId: 7,
      dayIndex: 0,
      minuteOfDay: 6 * 60 + 30,
      metricValue: 3,
    });
    expect(result.dates).toEqual(["2026-02-09"]);
  });

  it("sorts dates ascending so dayIndex 0 is the oldest", () => {
    const result = buildCells(
      [
        makeFile({ id: 1, recordedDate: "2026-02-11", recordedTime: "00:00:00" }),
        makeFile({ id: 2, recordedDate: "2026-02-09", recordedTime: "00:00:00" }),
        makeFile({ id: 3, recordedDate: "2026-02-10", recordedTime: "00:00:00" }),
      ],
      "detectionCount"
    );
    expect(result.dates).toEqual(["2026-02-09", "2026-02-10", "2026-02-11"]);
    const byId = Object.fromEntries(result.cells.map((c) => [c.fileId, c.dayIndex]));
    expect(byId[2]).toBe(0);
    expect(byId[3]).toBe(1);
    expect(byId[1]).toBe(2);
  });

  it("fills calendar gaps so dates span min..max inclusive", () => {
    // Two recordings 5 days apart — the axis should include all 6 days, not just 2.
    const result = buildCells(
      [
        makeFile({ id: 1, recordedDate: "2026-02-09", recordedTime: "00:00:00" }),
        makeFile({ id: 2, recordedDate: "2026-02-14", recordedTime: "00:00:00" }),
      ],
      "detectionCount"
    );
    expect(result.dates).toEqual([
      "2026-02-09",
      "2026-02-10",
      "2026-02-11",
      "2026-02-12",
      "2026-02-13",
      "2026-02-14",
    ]);
    const byId = Object.fromEntries(result.cells.map((c) => [c.fileId, c.dayIndex]));
    expect(byId[1]).toBe(0);
    expect(byId[2]).toBe(5);   // 5 days after the start
  });

  it("crosses month boundaries correctly", () => {
    const result = buildCells(
      [
        makeFile({ id: 1, recordedDate: "2026-01-31", recordedTime: "00:00:00" }),
        makeFile({ id: 2, recordedDate: "2026-02-02", recordedTime: "00:00:00" }),
      ],
      "detectionCount"
    );
    expect(result.dates).toEqual(["2026-01-31", "2026-02-01", "2026-02-02"]);
  });

  it("drops files without parsed timestamp and counts them in skippedCount", () => {
    const result = buildCells(
      [
        makeFile({ id: 1, recordedDate: null, recordedTime: null, filename: "garbage.wav" }),
        makeFile({ id: 2 }),
      ],
      "detectionCount"
    );
    expect(result.cells).toHaveLength(1);
    expect(result.cells[0].fileId).toBe(2);
    expect(result.skippedCount).toBe(1);
  });

  it("reads the right metric column for each metricKey", () => {
    const file = makeFile({
      detectionCount: 5,
      speciesCount: 2,
      soundscapeSaturation: 0.42,
      acousticComplexityIndex: 1.23,
      frequencyEntropy: 0.91,
      temporalEntropy: 0.77,
      eventsPerSecond: 12.5,
    });
    const keys: RasterMetricKey[] = [
      "detectionCount",
      "speciesCount",
      "soundscapeSaturation",
      "acousticComplexityIndex",
      "frequencyEntropy",
      "temporalEntropy",
      "eventsPerSecond",
    ];
    const expected: Record<RasterMetricKey, number | null> = {
      detectionCount: 5,
      speciesCount: 2,
      soundscapeSaturation: 0.42,
      acousticComplexityIndex: 1.23,
      frequencyEntropy: 0.91,
      temporalEntropy: 0.77,
      eventsPerSecond: 12.5,
    };
    for (const key of keys) {
      const { cells } = buildCells([file], key);
      expect(cells[0].metricValue).toBe(expected[key]);
    }
  });

  it("returns metricValue=null for files with no acoustic indices computed", () => {
    const file = makeFile({ soundscapeSaturation: null });
    const { cells } = buildCells([file], "soundscapeSaturation");
    expect(cells[0].metricValue).toBeNull();
  });
});

describe("computeDomain", () => {
  it("returns [0, 0] when there are no cells", () => {
    expect(computeDomain([])).toEqual([0, 0]);
  });

  it("returns [0, 0] when every cell has a null metric value", () => {
    const { cells } = buildCells(
      [
        makeFile({ id: 1, soundscapeSaturation: null }),
        makeFile({ id: 2, soundscapeSaturation: null }),
      ],
      "soundscapeSaturation"
    );
    expect(computeDomain(cells)).toEqual([0, 0]);
  });

  it("returns [0, max] ignoring null entries", () => {
    const { cells } = buildCells(
      [
        makeFile({ id: 1, detectionCount: 3 }),
        makeFile({ id: 2, detectionCount: 7 }),
        makeFile({ id: 3, detectionCount: 0 }),
      ],
      "detectionCount"
    );
    expect(computeDomain(cells)).toEqual([0, 7]);
  });
});

describe("metricToFill", () => {
  it("returns var(--raster-unscanned) for a null value", () => {
    expect(metricToFill(null, [0, 10])).toBe("var(--raster-unscanned)");
  });

  it("returns var(--raster-unscanned) when the domain has no signal (max === 0)", () => {
    // Common case: BirdNET hasn't run yet — every detectionCount is 0, so the
    // domain collapses to [0, 0]. Render as 'unscanned' rather than the lightest
    // scale stop (which blends with the card background).
    expect(metricToFill(0, [0, 0])).toBe("var(--raster-unscanned)");
  });

  it("returns the lightest stop for a flat non-zero domain (every file same value)", () => {
    expect(metricToFill(5, [5, 5])).toBe("var(--raster-scale-0)");
  });

  it("returns a color-mix string for a mid-range value", () => {
    const out = metricToFill(5, [0, 10]);
    expect(out).toMatch(/^color-mix\(in oklch, var\(--raster-scale-\d\) \d+\.\d{2}%, var\(--raster-scale-\d\)\)$/);
  });

  it("clamps values above the domain to the top stop", () => {
    const out = metricToFill(999, [0, 10]);
    // t=1 ⇒ i=3, localT=1 → mixes scale-3 0% with scale-4 → effectively scale-4
    expect(out).toContain("var(--raster-scale-3)");
    expect(out).toContain("var(--raster-scale-4)");
    expect(out).toMatch(/var\(--raster-scale-3\) 0\.00%/);
  });

  it("clamps values below the domain to the bottom stop", () => {
    const out = metricToFill(-5, [0, 10]);
    expect(out).toMatch(/var\(--raster-scale-0\) 100\.00%/);
  });
});
