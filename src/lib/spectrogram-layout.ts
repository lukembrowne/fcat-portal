/**
 * Pure layout helpers for the audio annotation spectrogram.
 *
 * No React, no DOM, no localStorage. Both the spectrogram component and the
 * settings module derive their literal-union types from the const arrays
 * declared here so there's a single source of truth — never hand-write
 * `"compacto" | "comodo" | "alto"` or `1 | 2 | 4 | 8` elsewhere.
 *
 * Everything in this file is pure and unit-testable under vitest's node env
 * (no jsdom). Keep it that way: any DOM-dependent logic belongs in the
 * components, not here.
 */

export const FREQ_AXIS_WIDTH = 70;
export const TIME_AXIS_HEIGHT = 24;

export const SPEC_HEIGHT_PRESETS = {
  compacto: 256,
  comodo: 350,
  alto: 480,
} as const;

export const ZOOM_LEVELS = [1, 2, 4, 8] as const;

export type HeightPreset = keyof typeof SPEC_HEIGHT_PRESETS;
export type ZoomLevel = (typeof ZOOM_LEVELS)[number];

export const HEIGHT_PRESETS: readonly HeightPreset[] = [
  "compacto",
  "comodo",
  "alto",
] as const;

export function heightForPreset(preset: HeightPreset): number {
  return SPEC_HEIGHT_PRESETS[preset];
}

export function isHeightPreset(value: unknown): value is HeightPreset {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(SPEC_HEIGHT_PRESETS, value)
  );
}

export function isZoomLevel(value: unknown): value is ZoomLevel {
  return (
    typeof value === "number" &&
    (ZOOM_LEVELS as readonly number[]).includes(value)
  );
}

/** Step the zoom level by ±1 index, clamping to the bounds of ZOOM_LEVELS. */
export function stepZoom(current: ZoomLevel, direction: 1 | -1): ZoomLevel {
  const idx = ZOOM_LEVELS.indexOf(current);
  const next = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, idx + direction));
  return ZOOM_LEVELS[next];
}

// ---------------------------------------------------------------------------
// Viewport ↔ time math
// ---------------------------------------------------------------------------

/**
 * Convert a horizontal viewport-pixel offset (relative to the scrolled inner
 * container's left edge) to seconds. `scrollWidth` is the total width of the
 * inner container, which already factors in zoom (i.e. `baseWidth × zoom`).
 */
export function viewportToTime(
  px: number,
  scrollWidth: number,
  duration: number,
): number {
  if (scrollWidth <= 0 || duration <= 0) return 0;
  return (px / scrollWidth) * duration;
}

/**
 * Compute the scroll offset (in px) so that time `t` lands at the screen-x
 * position `anchorPx` within the viewport. Clamped to valid scroll range
 * `[0, scrollWidth - viewportWidth]`.
 *
 * Used both for cursor-anchored zoom (anchor = mouse x in viewport) and
 * card-click auto-scroll (anchor = `viewportWidth / 2` to center).
 */
export function timeToScrollOffset(
  t: number,
  duration: number,
  scrollWidth: number,
  viewportWidth: number,
  anchorPx: number,
): number {
  if (duration <= 0 || scrollWidth <= 0) return 0;
  const xAtCurrentScroll = (t / duration) * scrollWidth;
  const targetScroll = xAtCurrentScroll - anchorPx;
  const maxScroll = Math.max(0, scrollWidth - viewportWidth);
  if (targetScroll < 0) return 0;
  if (targetScroll > maxScroll) return maxScroll;
  return Math.round(targetScroll);
}

/**
 * Returns `true` when the playhead has entered the trailing 20% of the
 * current viewport. Drives the follow-the-playhead auto-scroll trigger —
 * scroll fires only when the playhead is about to leave the viewport, not on
 * every frame.
 */
export function withinViewportTailZone(
  playheadX: number,
  scrollLeft: number,
  viewportWidth: number,
): boolean {
  if (viewportWidth <= 0) return false;
  const tailStart = scrollLeft + 0.8 * viewportWidth;
  const tailEnd = scrollLeft + viewportWidth;
  return playheadX >= tailStart && playheadX <= tailEnd;
}

/**
 * The visible time window inside the scrolled viewport, with `padViewports`
 * extra viewports of padding on either side (default 1). Used by SVG/HTML
 * virtualization to filter detections to a window that's slightly larger
 * than what's visible, so boxes that scroll into view aren't unmounted-and-
 * re-mounted on every frame.
 */
export function visibleTimeWindow(
  scrollLeft: number,
  viewportWidth: number,
  scrollWidth: number,
  duration: number,
  padViewports = 1,
): { startTime: number; endTime: number } {
  if (scrollWidth <= 0 || duration <= 0) {
    return { startTime: 0, endTime: duration };
  }
  const pxToS = duration / scrollWidth;
  const pad = viewportWidth * padViewports * pxToS;
  const startTime = Math.max(0, scrollLeft * pxToS - pad);
  const endTime = Math.min(duration, (scrollLeft + viewportWidth) * pxToS + pad);
  return { startTime, endTime };
}

// ---------------------------------------------------------------------------
// Popover anchor box → viewport-pixel rect
// ---------------------------------------------------------------------------

export interface AnchorBox {
  startTime: number;
  endTime: number;
  minFreq: number;
  maxFreq: number;
}

export interface AnchorView {
  duration: number;
  scrollLeft: number;
  scrollWidth: number;
  viewportWidth: number;
  specHeight: number;
  displayMaxHz: number;
}

/**
 * Convert a detection's time/frequency rect into pixel coordinates suitable
 * for an HTML overlay positioned over the scroll viewport. Output is
 * relative to the scroll viewport (NOT the inner zoomed container) — the
 * caller adds `FREQ_AXIS_WIDTH` if anchoring on the outer flex parent.
 *
 * The returned `x` accounts for the current horizontal scroll offset, so a
 * box that's scrolled off-screen returns a negative or out-of-range `x`.
 * Callers can compare `(x + w, x)` against `(0, viewportWidth)` to detect
 * "anchor outside viewport" and close the popover.
 */
export function anchorBoxToViewportPx(
  box: AnchorBox,
  view: AnchorView,
): { x: number; y: number; w: number; h: number } {
  if (view.duration <= 0 || view.scrollWidth <= 0 || view.displayMaxHz <= 0) {
    return { x: 0, y: 0, w: 0, h: 0 };
  }
  const innerX = (box.startTime / view.duration) * view.scrollWidth;
  const innerW =
    ((box.endTime - box.startTime) / view.duration) * view.scrollWidth;
  const x = innerX - view.scrollLeft;
  const yTop = (1 - box.maxFreq / view.displayMaxHz) * view.specHeight;
  const yBot = (1 - box.minFreq / view.displayMaxHz) * view.specHeight;
  return {
    x,
    y: yTop,
    w: Math.max(2, innerW),
    h: Math.max(2, yBot - yTop),
  };
}

/**
 * Is the anchor rect (from `anchorBoxToViewportPx`) at least partially
 * inside the current viewport? Used to auto-close the species-picker
 * popover when its anchor scrolls off-screen.
 */
export function anchorInViewport(
  anchor: { x: number; w: number },
  viewportWidth: number,
): boolean {
  return anchor.x + anchor.w > 0 && anchor.x < viewportWidth;
}

// ---------------------------------------------------------------------------
// Label collapse decision
// ---------------------------------------------------------------------------

/**
 * Decide whether a detection's label should render as a collapsed letter
 * chip or an expanded full-name pill. Selected boxes are always expanded.
 *
 * Threshold: `boxWidthPx × zoomLevel < 40` → collapsed. The multiplication
 * by zoom captures that a 30 px-wide box at 4× zoom is effectively 120 px
 * of label real estate — wide enough for the full name.
 *
 * Note: `boxWidthPx` is the box's width in the *unzoomed* base coordinate
 * space (i.e. the same coordinate system the SVG `viewBox="0 0 1 1"` maps
 * to). At zoom 4×, the rendered DOM width is 4× this value.
 */
export function decideLabelCollapse(
  boxWidthPx: number,
  zoomLevel: number,
  isSelected: boolean,
): "collapsed" | "expanded" {
  if (isSelected) return "expanded";
  if (boxWidthPx * zoomLevel < 40) return "collapsed";
  return "expanded";
}

/**
 * Extract the first character of a species name for use in a collapsed-mode
 * chip. NFD-normalized to strip diacritics; falls back to "?" for empty
 * input. BirdNET species names are ASCII, so this is belt-and-suspenders.
 */
export function speciesInitial(name: string | null | undefined): string {
  if (!name) return "?";
  const normalized = name.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const ch = normalized.trim().charAt(0);
  return ch ? ch.toUpperCase() : "?";
}

// ---------------------------------------------------------------------------
// Label lane assignment (vertical staggering of overlapping HTML labels)
// ---------------------------------------------------------------------------
//
// Box-lane assignment was removed in the Round-2 UX revision — BirdNET
// detections all share the 0–15 kHz frequency range, so slicing boxes into
// vertical lanes misled users into reading the apparent narrower bands as
// real signal. Boxes now render at their full claimed freq range and are
// allowed to overlap. Labels get the lane treatment instead so they stay
// individually readable.

export interface LabelInterval {
  id: number;
  /** Left edge of the label's horizontal extent in inner-pixel space. */
  leftPx: number;
  /** Right edge of the label's horizontal extent in inner-pixel space. */
  rightPx: number;
}

/**
 * Greedy first-fit lane assignment for HTML label collisions.
 *
 * Returns the 0-based lane index for each input id. Labels are sorted by
 * `(leftPx, rightPx, id)` (id as final tiebreaker for stability), then
 * placed into the lowest-indexed lane whose last occupant ends before the
 * incoming label starts.
 *
 * Stability: appending a new label that doesn't horizontally overlap any
 * existing one assigns it lane 0 (the first free lane) without shifting
 * existing assignments. See unit tests.
 *
 * Memoization contract (carried over from the deleted `assignLanes`):
 * callers should memoize on a `detectionsVersion: number` counter, NOT on
 * the input array reference — fresh arrays from `.map()` / `.filter()` in
 * parent renders would otherwise bust the memo on every keystroke.
 */
export function assignLabelLanes(
  intervals: readonly LabelInterval[],
): ReadonlyMap<number, number> {
  const result = new Map<number, number>();
  if (intervals.length === 0) return result;

  const sorted = [...intervals].sort((a, b) => {
    if (a.leftPx !== b.leftPx) return a.leftPx - b.leftPx;
    if (a.rightPx !== b.rightPx) return a.rightPx - b.rightPx;
    return a.id - b.id;
  });

  // Track each lane's last `rightPx`.
  const laneEnds: number[] = [];
  for (const label of sorted) {
    let lane = laneEnds.findIndex((end) => end <= label.leftPx);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(label.rightPx);
    } else {
      laneEnds[lane] = label.rightPx;
    }
    result.set(label.id, lane);
  }
  return result;
}
