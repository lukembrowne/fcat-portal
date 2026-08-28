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
 * Time axis only — `min_freq`/`max_freq` are placeholders in the data (0 and
 * 15000 on essentially every row), so a frequency box would be a full-height
 * rectangle on every clip.
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

import { useEffect, useRef, type RefObject } from "react";

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
  audioRef,
  resetKey,
  surface,
  scrollRef,
}: {
  bandLeftPct: number;
  bandRightPct: number;
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

      <span className="pointer-events-none absolute bottom-1 right-1 rounded bg-black/50 px-1 text-[10px] text-white/80">
        detección
      </span>
    </>
  );
}

/** The pre-rendered server WebP with the detection marked over it. */
export function SpectrogramOverlay({
  src,
  bandLeftPct,
  bandRightPct,
  audioRef,
  height = 300,
}: {
  src: string;
  bandLeftPct: number;
  bandRightPct: number;
  audioRef: RefObject<HTMLAudioElement | null>;
  height?: number;
}) {
  return (
    <div
      className="relative w-full overflow-hidden rounded bg-[rgb(20,20,28)]"
      style={{ height }}
    >
      <ClipMarks
        bandLeftPct={bandLeftPct}
        bandRightPct={bandRightPct}
        audioRef={audioRef}
        resetKey={src}
        surface={
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={src}
            alt="Espectrograma de la detección"
            className="block w-full"
            style={{ height, objectFit: "fill" }}
          />
        }
      />
    </div>
  );
}
