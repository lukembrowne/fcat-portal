"use client";

/**
 * The clip's spectrogram with the detection marked and playback tracked.
 *
 * The detection is marked by DIMMING EVERYTHING ELSE rather than by tinting the
 * detection itself. The image is a magma spectrogram — near-black at low energy,
 * bright yellow-white at high — so no single fill colour reads at both ends: a
 * grey box vanishes into the dark background, and the translucent white this
 * replaced washed out against bright call energy, which is exactly where a
 * detection sits. Scrims work on relative luminance instead, so the marked
 * region stands out wherever it falls, and solid edges pin the boundaries.
 *
 * The scrim is deliberately LIGHT. Its job is to say where BirdNET pointed, not
 * to hide the rest: the ±3 s of context either side is what a reviewer uses to
 * tell a real call from a fragment of one, and at heavier opacity that context
 * went black on the quiet clips where it matters most. The amber edges carry
 * the boundary, so the dimming does not have to.
 *
 * The BAND is time-only — `min_freq`/`max_freq` are placeholders in the data
 * (0 and 15000 on essentially every row), so a frequency box would be a
 * full-height rectangle on every clip. The frequency AXIS around the picture is
 * a different claim: it describes what the renderer painted, which is known
 * exactly. See `clip-axes.ts`.
 *
 * A PLAYHEAD tracks `currentTime` above the scrims.
 *
 * Percentages map linearly onto the rendered box because the image is painted
 * with `object-fit: fill` and encoded with sharp's `fit: "fill"` — deliberately
 * distorted to the box rather than letterboxed. Switching either to `contain`
 * would introduce letterboxing this overlay does not model.
 *
 * Nothing here reveals the BirdNET score: the band is where the call is, not
 * how confident the model was.
 */

import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

import {
  freqTicks,
  timeTicks,
  FREQ_AXIS_WIDTH,
  TIME_AXIS_HEIGHT,
  type FreqTick,
  type TimeTick,
} from "./clip-axes";
import { DEFAULT_SETTINGS } from "./spectrogram-settings";

export interface Scrim {
  leftPct: number;
  widthPct: number;
}

/**
 * The two dimmed regions flanking the detection.
 *
 * Returned rather than computed inline because the arithmetic would otherwise
 * be repeated per rectangle, and because the degenerate cases are real:
 * `detectionBand` legitimately clamps to 0 or 100 when a detection runs against
 * a file end, and a zero-width scrim must not be rendered at all (an empty
 * absolutely-positioned div still paints its border).
 */
export function bandScrims(leftPct: number, rightPct: number): Scrim[] {
  const clamp = (v: number) => Math.min(100, Math.max(0, v));
  // Ordered before clamping so inverted input cannot produce a negative width.
  const start = clamp(Math.min(leftPct, rightPct));
  const end = clamp(Math.max(leftPct, rightPct));

  const scrims: Scrim[] = [];
  if (start > 0) scrims.push({ leftPct: 0, widthPct: start });
  if (end < 100) scrims.push({ leftPct: end, widthPct: 100 - end });
  return scrims;
}

/**
 * Playback position as a percentage of the clip.
 *
 * Uses the DECODED duration rather than the requested cut length: the AAC
 * encoder adds ~20-45 ms of priming delay at the front, and the spectrogram is
 * rendered from the same decoded clip the audio element plays, so both share
 * that timeline. Before metadata loads the duration is NaN or 0, which must
 * render as 0 rather than NaN — that is the state on every clip's first frame.
 */
export function playheadPercent(
  currentTime: number,
  duration: number | null | undefined
): number {
  if (
    duration == null ||
    !Number.isFinite(duration) ||
    duration <= 0 ||
    !Number.isFinite(currentTime) ||
    currentTime <= 0
  ) {
    return 0;
  }
  return Math.min(100, (currentTime / duration) * 100);
}

/**
 * The clip's length, for the readout in the corner.
 *
 * Every clip is resized to the same pixel width (`spectrogram-image.ts` uses
 * `fit: "fill"`, and the live canvas matches it), so a 5 s clip and a 9 s clip
 * are indistinguishable on screen. That is what let a misplaced band go
 * unnoticed: there was nothing to contradict the assumption that every clip
 * was the same 9 s. One decimal, because the differences that matter here are
 * whole seconds and a jittering third decimal in the corner of a spectrogram
 * is noise a reviewer has to learn to ignore.
 *
 * A dot, not a comma, to match the confidence readout on the same page —
 * consistency within one screen beats locale correctness in one corner of it.
 *
 * Returns null for a duration that is not yet known, so nothing renders rather
 * than "NaN s".
 */
export function formatClipSeconds(seconds: number | null | undefined): string | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return null;
  return `${seconds.toFixed(1)} s`;
}

/**
 * The marks that sit on top of a clip surface: scrims, detection edges,
 * playhead, caption.
 *
 * Split out from `SpectrogramOverlay` so the pre-rendered `<img>` and the live
 * `<canvas>` (see `live-spectrogram.tsx`) can share one copy. Both paint the
 * clip edge-to-edge into the same box, so the percentage geometry is identical
 * and must not be allowed to fork into two implementations that drift.
 *
 * `surface` is rendered underneath and is expected to fill the box. When the
 * caller zooms, IT sizes the surface wider than the viewport and scrolls; this
 * component positions in percentages of its own container, so it must be
 * mounted INSIDE the scrolled element, not around it.
 */
/**
 * Where to scroll so a point at `pct` across the clip sits mid-viewport.
 *
 * Pure, exported and tested because it is used from two places that must agree:
 * playback tracking in `ClipMarks`, and landing on the detection when the clip
 * or the zoom changes in `LiveSpectrogram`. Two copies of this clamp is exactly
 * the failure `clip-geometry.ts` documents for the band arithmetic.
 *
 * Returns `null` when there is nothing to scroll, so callers can tell "already
 * fully visible" apart from "scroll to 0".
 */
export function centeredScrollLeft(
  pct: number,
  scrollWidth: number,
  clientWidth: number
): number | null {
  const overflow = scrollWidth - clientWidth;
  if (!(overflow > 0)) return null; // unzoomed: the whole clip is already visible
  const x = (pct / 100) * scrollWidth;
  // Clamping is what makes both ends feel right: the view sits still through
  // the first and last half-screen instead of jumping to meet the playhead.
  return Math.max(0, Math.min(overflow, x - clientWidth / 2));
}

export function ClipMarks({
  bandLeftPct,
  bandRightPct,
  clipSeconds,
  audioRef,
  resetKey,
  surface,
  scrollRef,
}: {
  bandLeftPct: number;
  bandRightPct: number;
  /** Measured clip length, shown in the corner. Null until metadata loads. */
  clipSeconds?: number | null;
  audioRef: RefObject<HTMLAudioElement | null>;
  /** Changing this resets the playhead — the clip changed underneath it. */
  resetKey: string;
  surface: React.ReactNode;
  /**
   * The scrolling viewport, when the surface is wider than the box.
   *
   * Given one, playback DRAGS THE VIEW ALONG so the playhead stays in sight.
   * Without it a zoomed clip plays straight off the right-hand edge within a
   * second or two and the reviewer is watching a still image of the part
   * that already went past — which is what made time zoom close to useless.
   */
  scrollRef?: RefObject<HTMLDivElement | null>;
}) {
  const playheadRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const audio = audioRef.current;
    const playhead = playheadRef.current;
    if (!audio || !playhead) return;

    let frame = 0;

    const centerOn = (pct: number) => {
      const box = scrollRef?.current;
      if (!box) return;
      const next = centeredScrollLeft(pct, box.scrollWidth, box.clientWidth);
      if (next != null) box.scrollLeft = next;
    };

    // Written straight to the node rather than through state: playback would
    // otherwise re-render this component ~60 times a second.
    const paint = (follow: boolean) => {
      const pct = playheadPercent(audio.currentTime, audio.duration);
      playhead.style.left = `${pct}%`;
      if (follow) centerOn(pct);
    };

    const loop = () => {
      paint(true);
      frame = requestAnimationFrame(loop);
    };

    // rAF rather than `timeupdate`, which fires ~4x a second and reads as a
    // stuttering line. The loop only runs while audio is actually playing.
    const start = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(loop);
    };
    // Repaints WITHOUT following, so pausing does not yank a view the reviewer
    // may have just scrolled somewhere deliberately.
    const stop = () => {
      cancelAnimationFrame(frame);
      paint(false);
    };
    // A seek is the reviewer asking to be somewhere, so the view goes there.
    const onSeek = () => paint(true);
    const onMetadata = () => paint(false);

    audio.addEventListener("play", start);
    audio.addEventListener("playing", start);
    audio.addEventListener("pause", stop);
    audio.addEventListener("ended", stop);
    audio.addEventListener("seeked", onSeek);
    audio.addEventListener("loadedmetadata", onMetadata);

    paint(false);
    if (!audio.paused) start();

    return () => {
      cancelAnimationFrame(frame);
      audio.removeEventListener("play", start);
      audio.removeEventListener("playing", start);
      audio.removeEventListener("pause", stop);
      audio.removeEventListener("ended", stop);
      audio.removeEventListener("seeked", onSeek);
      audio.removeEventListener("loadedmetadata", onMetadata);
    };
    // `resetKey` is in the deps so the playhead resets when the clip changes.
  }, [audioRef, resetKey, scrollRef]);

  return (
    <>
      {surface}

      {/* Everything OUTSIDE the detection is dimmed; the detection keeps the
          image's full brightness. See the module comment for why this beats
          tinting the band itself. */}
      {bandScrims(bandLeftPct, bandRightPct).map((scrim) => (
        <div
          key={scrim.leftPct}
          aria-hidden
          className="pointer-events-none absolute inset-y-0 bg-black/35"
          style={{ left: `${scrim.leftPct}%`, width: `${scrim.widthPct}%` }}
        />
      ))}

      {/* Solid edges, so the boundary is legible even where the scrim meets a
          dark region of the spectrogram and the contrast step is small. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 border-x-2 border-amber-300/90"
        style={{
          left: `${bandLeftPct}%`,
          width: `${Math.max(0, bandRightPct - bandLeftPct)}%`,
        }}
      />

      <div
        ref={playheadRef}
        aria-hidden
        className="pointer-events-none absolute inset-y-0 w-0.5 bg-rose-400"
        style={{ left: "0%" }}
      />

      {/* Length first, then the caption, both bottom-right so they read as one
          line and neither collides with call energy at the left edge. */}
      <span className="pointer-events-none absolute bottom-1 right-1 flex gap-1">
        {formatClipSeconds(clipSeconds) ? (
          <span className="rounded bg-black/50 px-1 text-[10px] tabular-nums text-white/80">
            {formatClipSeconds(clipSeconds)}
          </span>
        ) : null}
        <span className="rounded bg-black/50 px-1 text-[10px] text-white/80">
          detección
        </span>
      </span>
    </>
  );
}

/**
 * Chart furniture around a clip: frequency gutter, time ruler, gridlines.
 *
 * Shared by the live canvas and the pre-rendered image so the two surfaces
 * cannot end up labelled differently — the same failure mode `ClipMarks`
 * exists to prevent for the band.
 *
 * LAYOUT. The frequency gutter sits OUTSIDE the scrolling viewport, because it
 * is true of every column of the picture and must stay put when a zoomed clip
 * scrolls. The time ruler is the opposite: it is only true of the columns
 * beneath it, so it TRACKS the scroll. It is kept out of the scrolling element
 * anyway and moved by transform, because a classic (space-taking) scrollbar
 * would otherwise cut the labels off at the bottom of a zoomed clip on Windows
 * and Linux, where the plot box loses ~15 px it does not have to spare.
 */
export function AxisFrame({
  height,
  maxHz,
  clipSeconds,
  zoom = 1,
  scrollRef,
  children,
}: {
  height: number;
  /**
   * The frequency at the TOP of the painted image — not necessarily the
   * ceiling the reviewer chose. See `freqTicks`.
   */
  maxHz: number;
  /** Measured clip length. Null until metadata loads; the ruler waits. */
  clipSeconds?: number | null;
  zoom?: number;
  /** The scrolling viewport, when the caller zooms. */
  scrollRef?: RefObject<HTMLDivElement | null>;
  children: React.ReactNode;
}) {
  const fallbackRef = useRef<HTMLDivElement>(null);
  const boxRef = scrollRef ?? fallbackRef;
  const rulerRef = useRef<HTMLDivElement>(null);
  const viewportWidth = useViewportWidth(boxRef);

  const fTicks = useMemo(() => freqTicks(maxHz), [maxHz]);
  const tTicks = useMemo(
    () =>
      viewportWidth == null ? [] : timeTicks(clipSeconds, viewportWidth * zoom),
    [clipSeconds, viewportWidth, zoom]
  );

  /*
    Fade the ruler's ends once it can scroll.

    A label centred on its tick is CUT, not dropped, when the tick scrolls past
    the edge of the strip — and the tail of "4.50 s" reads as "0 s" sitting at
    the left edge, which is a wrong number in the one place a reviewer looks for
    a right one. The fade runs well past the widest label, so whatever survives
    of a cut one is left at a third of its opacity and reads as a smudge rather
    than as a value; it doubles as the affordance that says the ruler continues,
    which is why the annotation page fades its edges too. Not applied at 1×,
    where nothing scrolls and the first label must stay fully legible.
  */
  const rulerMask =
    zoom > 1
      ? "linear-gradient(to right, transparent 0, black 56px, black calc(100% - 56px), transparent 100%)"
      : undefined;

  // Written straight to the node, like the playhead: a zoomed clip scrolls at
  // 60 fps while it plays (`ClipMarks` drags the view along), and re-rendering
  // the ruler on each of those frames would cost a React pass per frame for a
  // strip of a dozen labels.
  const syncRuler = () => {
    const ruler = rulerRef.current;
    const box = boxRef.current;
    if (ruler && box) ruler.style.transform = `translateX(${-box.scrollLeft}px)`;
  };
  // No dependency array: the ruler has to catch programmatic scrolls too — the
  // centre-on-the-detection effect in `LiveSpectrogram` moves the viewport
  // whenever the clip or the zoom changes.
  useEffect(syncRuler);

  return (
    <div className="flex w-full items-start">
      <FreqAxis ticks={fTicks} height={height} />
      <div className="min-w-0 flex-1">
        <div
          ref={boxRef}
          onScroll={syncRuler}
          className="overflow-x-auto overflow-y-hidden rounded bg-[rgb(20,20,28)]"
          style={{ height }}
        >
          {/* Inner element carries the zoomed width, and the marks live inside
              it so their percentages stay percentages OF THE CLIP, not of the
              viewport. */}
          <div className="relative h-full" style={{ width: `${zoom * 100}%` }}>
            {children}
            <AxisGrid freqTicks={fTicks} timeTicks={tTicks} />
          </div>
        </div>
        <div
          className="overflow-hidden"
          style={{
            height: TIME_AXIS_HEIGHT,
            maskImage: rulerMask,
            WebkitMaskImage: rulerMask,
          }}
        >
          <div
            ref={rulerRef}
            className="relative h-full"
            style={{ width: `${zoom * 100}%` }}
          >
            <TimeRuler ticks={tTicks} />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * The clip box's width in CSS px, or null before it has been measured.
 *
 * Measured rather than assumed because it is what decides how fine the time
 * grid can be: the same nine seconds carry a tick every 0.25 s on a wide
 * desktop at 4× zoom and every 2 s on a phone.
 */
function useViewportWidth(ref: RefObject<HTMLElement | null>): number | null {
  const [width, setWidth] = useState<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const read = () =>
      setWidth((prev) => (prev === el.clientWidth ? prev : el.clientWidth));
    read();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);

  return width;
}

function FreqAxis({ ticks, height }: { ticks: FreqTick[]; height: number }) {
  return (
    <div
      aria-hidden
      className="relative shrink-0 select-none"
      style={{ width: FREQ_AXIS_WIDTH, height }}
    >
      {ticks.map((tick) => (
        <div
          key={tick.hz}
          className="absolute right-0 flex items-center gap-1"
          style={{ top: `${tick.topPct}%`, transform: edgeShiftY(tick.topPct) }}
        >
          <span className="whitespace-nowrap text-[10px] leading-none tabular-nums text-muted-foreground">
            {tick.label}
          </span>
          <span className="block h-px w-1.5 bg-border" />
        </div>
      ))}
    </div>
  );
}

function TimeRuler({ ticks }: { ticks: TimeTick[] }) {
  return (
    <div aria-hidden className="relative h-full select-none">
      {ticks.map((tick) => (
        <Fragment key={tick.seconds}>
          {/* The stub is never shifted — it marks the instant. Only the label
              is nudged inboard at the ends so it is not half cut off. */}
          <span
            className="absolute top-0 block h-1 w-px bg-border"
            style={{ left: `${tick.leftPct}%` }}
          />
          <span
            className="absolute top-1.5 whitespace-nowrap text-[10px] leading-none tabular-nums text-muted-foreground"
            style={{ left: `${tick.leftPct}%`, transform: edgeShiftX(tick.leftPct) }}
          >
            {tick.label}
          </span>
        </Fragment>
      ))}
    </div>
  );
}

/**
 * Faint gridlines across the picture.
 *
 * The gutter alone is not enough to read a call's frequency: the eye cannot
 * carry a horizontal line 600 px across a noisy magma image. The lines are what
 * make the axis usable, and they are kept at low opacity so they never read as
 * energy.
 *
 * Drawn ABOVE the marks, so they stay visible inside the dimmed context
 * either side of the detection — that is where a reviewer is comparing a
 * neighbouring call against the one BirdNET pointed at. The clip's own edges
 * (0 Hz, the ceiling, t=0) are skipped: a line there is a box, not a grid.
 */
function AxisGrid({
  freqTicks: fTicks,
  timeTicks: tTicks,
}: {
  freqTicks: FreqTick[];
  timeTicks: TimeTick[];
}) {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0">
      {fTicks.map((tick) =>
        tick.topPct <= 0.01 || tick.topPct >= 99.99 ? null : (
          <div
            key={`f${tick.hz}`}
            className="absolute inset-x-0 h-px bg-white/15"
            style={{ top: `${tick.topPct}%` }}
          />
        )
      )}
      {tTicks.map((tick) =>
        tick.leftPct <= 0.01 ? null : (
          <div
            key={`t${tick.seconds}`}
            className="absolute inset-y-0 w-px bg-white/10"
            style={{ left: `${tick.leftPct}%` }}
          />
        )
      )}
    </div>
  );
}

/** Keep a label at either end of an axis inside the box rather than centred on
 *  a tick that sits on the boundary. */
function edgeShiftY(pct: number): string {
  if (pct <= 0.5) return "translateY(0)";
  if (pct >= 99.5) return "translateY(-100%)";
  return "translateY(-50%)";
}

function edgeShiftX(pct: number): string {
  if (pct <= 0.5) return "translateX(0)";
  if (pct >= 99.5) return "translateX(-100%)";
  return "translateX(-50%)";
}

/**
 * The pre-rendered server WebP with the detection marked over it.
 *
 * The FALLBACK surface, used only where the browser cannot decode the clip
 * (see `review-client.tsx`). Its frequency ceiling is the server renderer's
 * constant, NOT the reviewer's setting — the image is rendered once, before
 * anyone touches a control, and the controls say so on this path. The test in
 * `__tests__/spectrogram-settings.test.ts` pins the two together.
 */
export function SpectrogramOverlay({
  src,
  bandLeftPct,
  bandRightPct,
  clipSeconds,
  audioRef,
  height = 300,
}: {
  src: string;
  bandLeftPct: number;
  bandRightPct: number;
  clipSeconds?: number | null;
  audioRef: RefObject<HTMLAudioElement | null>;
  height?: number;
}) {
  return (
    <AxisFrame
      height={height}
      maxHz={DEFAULT_SETTINGS.displayMaxHz}
      clipSeconds={clipSeconds}
    >
      <ClipMarks
        bandLeftPct={bandLeftPct}
        bandRightPct={bandRightPct}
        clipSeconds={clipSeconds}
        audioRef={audioRef}
        resetKey={src}
        surface={
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={src}
            alt="Espectrograma de la detección"
            className="block h-full w-full"
            style={{ objectFit: "fill" }}
          />
        }
      />
    </AxisFrame>
  );
}
