import { describe, it, expect } from "vitest";
import {
  FREQ_AXIS_WIDTH,
  TIME_AXIS_HEIGHT,
  SPEC_HEIGHT_PRESETS,
  ZOOM_LEVELS,
  HEIGHT_PRESETS,
  heightForPreset,
  isHeightPreset,
  isZoomLevel,
  stepZoom,
  viewportToTime,
  timeToScrollOffset,
  withinViewportTailZone,
  visibleTimeWindow,
  anchorBoxToViewportPx,
  anchorInViewport,
  decideLabelCollapse,
  speciesInitial,
  assignLabelLanes,
  type LabelInterval,
} from "@/lib/spectrogram-layout";

describe("spectrogram-layout", () => {
  describe("constants", () => {
    it("FREQ_AXIS_WIDTH matches the value previously inlined in fft-spectrogram + annotation-client", () => {
      expect(FREQ_AXIS_WIDTH).toBe(70);
    });

    it("TIME_AXIS_HEIGHT matches the existing layout", () => {
      expect(TIME_AXIS_HEIGHT).toBe(24);
    });

    it("SPEC_HEIGHT_PRESETS exposes three preset heights in ascending order", () => {
      expect(SPEC_HEIGHT_PRESETS.compacto).toBe(256);
      expect(SPEC_HEIGHT_PRESETS.comodo).toBe(350);
      expect(SPEC_HEIGHT_PRESETS.alto).toBe(480);
    });

    it("ZOOM_LEVELS is the discrete 1×–8× ladder", () => {
      expect(ZOOM_LEVELS).toEqual([1, 2, 4, 8]);
    });

    it("HEIGHT_PRESETS lists every key in SPEC_HEIGHT_PRESETS", () => {
      expect(new Set(HEIGHT_PRESETS)).toEqual(
        new Set(Object.keys(SPEC_HEIGHT_PRESETS)),
      );
    });
  });

  describe("heightForPreset", () => {
    it("resolves each preset to its pixel height", () => {
      expect(heightForPreset("compacto")).toBe(256);
      expect(heightForPreset("comodo")).toBe(350);
      expect(heightForPreset("alto")).toBe(480);
    });
  });

  describe("isHeightPreset", () => {
    it("accepts only the three known preset keys", () => {
      expect(isHeightPreset("compacto")).toBe(true);
      expect(isHeightPreset("comodo")).toBe(true);
      expect(isHeightPreset("alto")).toBe(true);
    });

    it("rejects everything else, including near-misses", () => {
      expect(isHeightPreset("comfortable")).toBe(false);
      expect(isHeightPreset("COMPACTO")).toBe(false);
      expect(isHeightPreset("")).toBe(false);
      expect(isHeightPreset(null)).toBe(false);
      expect(isHeightPreset(256)).toBe(false);
      expect(isHeightPreset("toString")).toBe(false); // prototype pollution defense
    });
  });

  describe("isZoomLevel", () => {
    it("accepts only the four discrete zoom levels", () => {
      expect(isZoomLevel(1)).toBe(true);
      expect(isZoomLevel(2)).toBe(true);
      expect(isZoomLevel(4)).toBe(true);
      expect(isZoomLevel(8)).toBe(true);
    });

    it("rejects non-ladder values", () => {
      expect(isZoomLevel(3)).toBe(false);
      expect(isZoomLevel(16)).toBe(false);
      expect(isZoomLevel(0)).toBe(false);
      expect(isZoomLevel("1")).toBe(false);
      expect(isZoomLevel(null)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // stepZoom
  // -------------------------------------------------------------------------
  describe("stepZoom", () => {
    it("steps up through the ladder", () => {
      expect(stepZoom(1, 1)).toBe(2);
      expect(stepZoom(2, 1)).toBe(4);
      expect(stepZoom(4, 1)).toBe(8);
    });

    it("steps down through the ladder", () => {
      expect(stepZoom(8, -1)).toBe(4);
      expect(stepZoom(4, -1)).toBe(2);
      expect(stepZoom(2, -1)).toBe(1);
    });

    it("clamps at the boundaries", () => {
      expect(stepZoom(1, -1)).toBe(1);
      expect(stepZoom(8, 1)).toBe(8);
    });
  });

  // -------------------------------------------------------------------------
  // viewportToTime
  // -------------------------------------------------------------------------
  describe("viewportToTime", () => {
    it("returns 0 at the left edge", () => {
      expect(viewportToTime(0, 1000, 60)).toBe(0);
    });

    it("returns duration at the right edge", () => {
      expect(viewportToTime(1000, 1000, 60)).toBe(60);
    });

    it("interpolates linearly", () => {
      expect(viewportToTime(500, 1000, 60)).toBeCloseTo(30);
      expect(viewportToTime(250, 1000, 60)).toBeCloseTo(15);
    });

    it("returns 0 for invalid inputs (no NaN leakage)", () => {
      expect(viewportToTime(100, 0, 60)).toBe(0);
      expect(viewportToTime(100, 1000, 0)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // timeToScrollOffset
  // -------------------------------------------------------------------------
  describe("timeToScrollOffset", () => {
    it("centers a time when anchorPx is half the viewport", () => {
      // 60s clip, scrollWidth 8000 (4× zoom over 2000 base), viewportWidth 2000.
      // Time 30s → 4000 px in inner; centered means scrollLeft = 4000 - 1000 = 3000.
      expect(timeToScrollOffset(30, 60, 8000, 2000, 1000)).toBe(3000);
    });

    it("clamps to 0 at the left edge", () => {
      expect(timeToScrollOffset(0, 60, 8000, 2000, 1000)).toBe(0);
    });

    it("clamps to (scrollWidth - viewportWidth) at the right edge", () => {
      // Time = duration → inner x = 8000; centered would request scrollLeft 7000
      // which is fine since maxScroll = 8000 - 2000 = 6000. Clamp to 6000.
      expect(timeToScrollOffset(60, 60, 8000, 2000, 1000)).toBe(6000);
    });

    it("returns 0 for invalid inputs", () => {
      expect(timeToScrollOffset(30, 0, 8000, 2000, 1000)).toBe(0);
      expect(timeToScrollOffset(30, 60, 0, 2000, 1000)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // withinViewportTailZone
  // -------------------------------------------------------------------------
  describe("withinViewportTailZone", () => {
    it("returns true in the trailing 20%", () => {
      // viewport [0, 1000], tail = [800, 1000]
      expect(withinViewportTailZone(900, 0, 1000)).toBe(true);
      expect(withinViewportTailZone(800, 0, 1000)).toBe(true);
      expect(withinViewportTailZone(1000, 0, 1000)).toBe(true);
    });

    it("returns false outside the trailing 20%", () => {
      expect(withinViewportTailZone(500, 0, 1000)).toBe(false);
      expect(withinViewportTailZone(799, 0, 1000)).toBe(false);
      expect(withinViewportTailZone(1100, 0, 1000)).toBe(false); // beyond viewport
    });

    it("respects scrollLeft offset", () => {
      // scrollLeft = 500 → viewport [500, 1500] → tail [1300, 1500]
      expect(withinViewportTailZone(1400, 500, 1000)).toBe(true);
      expect(withinViewportTailZone(1000, 500, 1000)).toBe(false);
    });

    it("returns false when viewport has zero width", () => {
      expect(withinViewportTailZone(100, 0, 0)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // visibleTimeWindow
  // -------------------------------------------------------------------------
  describe("visibleTimeWindow", () => {
    it("returns the bare viewport window with padViewports=0", () => {
      // 60s, scrollWidth=8000, viewport=2000, scrollLeft=2000 (offset 25%)
      // → visible inner x range [2000, 4000] → time [15, 30]
      const w = visibleTimeWindow(2000, 2000, 8000, 60, 0);
      expect(w.startTime).toBeCloseTo(15);
      expect(w.endTime).toBeCloseTo(30);
    });

    it("adds N viewports of padding on each side", () => {
      // viewport (2000) × 1 viewport pad = 2000 px = 15s
      const w = visibleTimeWindow(2000, 2000, 8000, 60, 1);
      expect(w.startTime).toBeCloseTo(0); // 15 - 15 = 0, clamped
      expect(w.endTime).toBeCloseTo(45); // 30 + 15 = 45
    });

    it("clamps to [0, duration]", () => {
      const w = visibleTimeWindow(0, 2000, 8000, 60, 10);
      expect(w.startTime).toBe(0);
      expect(w.endTime).toBe(60);
    });

    it("returns full duration when scrollWidth is 0", () => {
      const w = visibleTimeWindow(0, 0, 0, 60);
      expect(w.startTime).toBe(0);
      expect(w.endTime).toBe(60);
    });
  });

  // -------------------------------------------------------------------------
  // anchorBoxToViewportPx
  // -------------------------------------------------------------------------
  describe("anchorBoxToViewportPx", () => {
    const view = {
      duration: 60,
      scrollLeft: 0,
      scrollWidth: 1000,
      viewportWidth: 1000,
      specHeight: 350,
      displayMaxHz: 12000,
    };

    it("places a box at the correct viewport pixel rect at zoom 1×", () => {
      const a = anchorBoxToViewportPx(
        { startTime: 30, endTime: 33, minFreq: 3000, maxFreq: 6000 },
        view,
      );
      expect(a.x).toBeCloseTo(500); // 30/60 × 1000
      expect(a.w).toBeCloseTo(50); // 3/60 × 1000
      expect(a.y).toBeCloseTo(175); // (1 - 6000/12000) × 350
      expect(a.h).toBeCloseTo(87.5); // (6000-3000)/12000 × 350
    });

    it("accounts for horizontal scroll offset", () => {
      const a = anchorBoxToViewportPx(
        { startTime: 30, endTime: 33, minFreq: 3000, maxFreq: 6000 },
        { ...view, scrollLeft: 200, scrollWidth: 4000 },
      );
      // inner x = (30/60) × 4000 = 2000; viewport x = 2000 - 200 = 1800
      expect(a.x).toBeCloseTo(1800);
    });

    it("returns negative x when the box is scrolled off the left edge", () => {
      const a = anchorBoxToViewportPx(
        { startTime: 0, endTime: 2, minFreq: 0, maxFreq: 1000 },
        { ...view, scrollLeft: 500, scrollWidth: 4000 },
      );
      // inner x = 0; viewport x = 0 - 500 = -500
      expect(a.x).toBeCloseTo(-500);
    });

    it("clamps width and height to at least 2 px", () => {
      const a = anchorBoxToViewportPx(
        { startTime: 30, endTime: 30, minFreq: 5000, maxFreq: 5000 },
        view,
      );
      expect(a.w).toBe(2);
      expect(a.h).toBe(2);
    });

    it("returns zero rect for invalid view state", () => {
      const a = anchorBoxToViewportPx(
        { startTime: 0, endTime: 1, minFreq: 0, maxFreq: 1000 },
        { ...view, duration: 0 },
      );
      expect(a).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    });
  });

  describe("anchorInViewport", () => {
    it("true when at least partially visible", () => {
      expect(anchorInViewport({ x: 100, w: 50 }, 800)).toBe(true);
      expect(anchorInViewport({ x: -10, w: 50 }, 800)).toBe(true); // crosses left edge
      expect(anchorInViewport({ x: 750, w: 100 }, 800)).toBe(true); // crosses right edge
    });

    it("false when fully off-screen", () => {
      expect(anchorInViewport({ x: -100, w: 50 }, 800)).toBe(false);
      expect(anchorInViewport({ x: 850, w: 50 }, 800)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // decideLabelCollapse
  // -------------------------------------------------------------------------
  describe("decideLabelCollapse", () => {
    it("collapses small boxes at low zoom", () => {
      expect(decideLabelCollapse(20, 1, false)).toBe("collapsed");
      expect(decideLabelCollapse(10, 2, false)).toBe("collapsed"); // 10×2=20 < 40
    });

    it("expands large boxes at low zoom", () => {
      expect(decideLabelCollapse(50, 1, false)).toBe("expanded");
    });

    it("expands small boxes at high zoom (effective width > 40)", () => {
      expect(decideLabelCollapse(15, 4, false)).toBe("expanded"); // 60
      expect(decideLabelCollapse(10, 8, false)).toBe("expanded"); // 80
    });

    it("always expands selected boxes, regardless of effective width", () => {
      expect(decideLabelCollapse(5, 1, true)).toBe("expanded");
      expect(decideLabelCollapse(1, 1, true)).toBe("expanded");
    });

    it("threshold at exactly 40 expands", () => {
      expect(decideLabelCollapse(40, 1, false)).toBe("expanded");
      expect(decideLabelCollapse(39.99, 1, false)).toBe("collapsed");
    });
  });

  // -------------------------------------------------------------------------
  // speciesInitial
  // -------------------------------------------------------------------------
  describe("speciesInitial", () => {
    it("returns the first letter uppercased", () => {
      expect(speciesInitial("Schiffornis stenorhyncha")).toBe("S");
      expect(speciesInitial("cryptic chocoan")).toBe("C");
    });

    it("strips diacritics", () => {
      expect(speciesInitial("Émile")).toBe("E");
    });

    it("returns '?' for empty/null/whitespace", () => {
      expect(speciesInitial("")).toBe("?");
      expect(speciesInitial(null)).toBe("?");
      expect(speciesInitial(undefined)).toBe("?");
      expect(speciesInitial("   ")).toBe("?");
    });
  });

  // -------------------------------------------------------------------------
  // assignLabelLanes
  // -------------------------------------------------------------------------
  describe("assignLabelLanes", () => {
    const make = (id: number, leftPx: number, rightPx: number): LabelInterval => ({
      id,
      leftPx,
      rightPx,
    });

    it("returns empty map for empty input", () => {
      expect(assignLabelLanes([]).size).toBe(0);
    });

    it("three non-overlapping labels all sit in lane 0", () => {
      const result = assignLabelLanes([
        make(1, 0, 20),
        make(2, 30, 50),
        make(3, 60, 80),
      ]);
      expect(result.get(1)).toBe(0);
      expect(result.get(2)).toBe(0);
      expect(result.get(3)).toBe(0);
    });

    it("three fully overlapping labels stack into three lanes", () => {
      const result = assignLabelLanes([
        make(1, 0, 50),
        make(2, 0, 50),
        make(3, 0, 50),
      ]);
      expect(result.get(1)).toBe(0);
      expect(result.get(2)).toBe(1);
      expect(result.get(3)).toBe(2);
    });

    it("greedy first-fit reuses a lane once its previous occupant ends", () => {
      // 1: [0,10]  → lane 0
      // 2: [5,20]  → lane 1 (overlaps 1)
      // 3: [25,30] → lane 0 (1 ended at 10, free)
      const result = assignLabelLanes([
        make(1, 0, 10),
        make(2, 5, 20),
        make(3, 25, 30),
      ]);
      expect(result.get(1)).toBe(0);
      expect(result.get(2)).toBe(1);
      expect(result.get(3)).toBe(0);
    });

    it("sort tiebreaker is deterministic for identical leftPx", () => {
      const result = assignLabelLanes([
        make(3, 0, 10),
        make(1, 0, 10),
        make(2, 0, 10),
      ]);
      // Sorted by id: 1, 2, 3 → lanes 0, 1, 2
      expect(result.get(1)).toBe(0);
      expect(result.get(2)).toBe(1);
      expect(result.get(3)).toBe(2);
    });

    it("appending a non-overlapping label does not shift existing assignments", () => {
      const base = [make(1, 0, 50), make(2, 10, 60)];
      const before = assignLabelLanes(base);
      const after = assignLabelLanes([...base, make(99, 200, 220)]);
      expect(after.get(1)).toBe(before.get(1));
      expect(after.get(2)).toBe(before.get(2));
      expect(after.get(99)).toBe(0); // new free lane
    });

    it("touching intervals (right === next left) are treated as non-overlapping", () => {
      // The sweep uses `end <= leftPx` as the eviction condition, so a label
      // ending at 10 frees its lane for one starting at 10. Documented.
      const result = assignLabelLanes([make(1, 0, 10), make(2, 10, 20)]);
      expect(result.get(1)).toBe(0);
      expect(result.get(2)).toBe(0);
    });
  });
});
