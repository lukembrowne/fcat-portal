"use client";

/**
 * The clip's spectrogram, computed in the browser so the reviewer can adjust it.
 *
 * WHY THIS EXISTS. The review queue has always shown a pre-rendered WebP from
 * `/api/audio/validation-spectrogram`, with the render knobs frozen as constants
 * in `spectrogram-image.ts`. That is right for the common case — it is cached,
 * prefetched two clips ahead, and appears instantly — but a reviewer working a
 * hard species cannot do the one thing that resolves a marginal call: turn the
 * gain up on a faint call, narrow the FFT to separate two fast notes, or stretch
 * the time axis to see a trill's structure. Reported by a collaborator after her
 * first full 200-clip run.
 *
 * The three stages are split across three effects on purpose, because that split
 * IS the performance story:
 *
 *   decode        depends on the clip           ~one per clip
 *   FFT           depends on the clip, fftSize   re-runs only on FFT changes
 *   paint         depends on everything else     re-runs on gain/contrast/kHz/zoom
 *
 * Gain, contrast and the frequency ceiling are pure colour-mapping over
 * magnitudes that are already computed, so dragging those sliders costs one
 * `renderImageData` pass and no FFT at all. Only the FFT-size control pays for a
 * recompute. Getting this wrong — recomputing magnitudes on every slider tick —
 * is what would make the controls feel broken.
 *
 * COST: the clip is downloaded TWICE on this path. `<audio>` fetches it to
 * play, and `decodeAudio` fetches it again to get at the samples, because a
 * media element exposes no decoded buffer. `Cache-Control: immutable` does not
 * save us — Chrome keeps media-element responses in a separate cache from
 * `fetch()`, and the server log shows two hits for the clip on screen and one
 * each for the two prefetched ahead of it. Measured at ~146 KB per clip, so a
 * full 200-clip run spent entirely on this path costs ~29 MB extra. Acceptable
 * for a path a reviewer opts into, and the fix if it ever matters is to decode
 * first and hand the `<audio>` element a blob URL of the same bytes.
 *
 * Marks (scrims, detection edges, playhead) come from `ClipMarks`, shared with
 * the pre-rendered path, so the two surfaces cannot drift apart geometrically.
 */

import { useEffect, useRef, useState, type RefObject } from "react";

import {
  decodeAudio,
  computeMagnitudes,
  binFromHz,
  hzFromBin,
  type DecodedAudio,
  type Magnitudes,
} from "@/lib/audio-fft";
import { renderImageData } from "@/lib/spectrogram-render";
import { COLORMAPS } from "@/lib/spectrogram-colormaps";

import { AxisFrame, centeredScrollLeft, ClipMarks } from "./spectrogram-overlay";
import type { ReviewSpectrogramSettings } from "./spectrogram-settings";

/*
  Stage timings are also emitted as User Timing measures, so the three costs
  are visible in a DevTools performance profile without wiring up a debug prop.
  This is the instrumentation the "is it fast enough for a 200-clip run?"
  question gets answered with, and the answer changes with the reviewer's
  machine — so it needs to be readable on theirs, not only in a benchmark.
*/
const MEASURE = {
  decode: "validacion:spectrogram:decode",
  fft: "validacion:spectrogram:fft",
  paint: "validacion:spectrogram:paint",
} as const;

function measure(name: string, startedAt: number): number {
  const elapsed = performance.now() - startedAt;
  try {
    performance.measure(name, { start: startedAt, duration: elapsed });
  } catch {
    // Older Safari rejects the options form; the timing still returns.
  }
  return elapsed;
}

/**
 * Unzoomed canvas bitmap width, matching `OUT_WIDTH` in `spectrogram-image.ts`
 * so the live canvas carries the same horizontal detail as the pre-rendered
 * WebP it stands in for.
 */
const BASE_BITMAP_WIDTH = 1600;

/**
 * The rows the canvas paints, and the frequency at the top of them.
 *
 * Used by BOTH the paint pass and the frequency axis, deliberately: the axis is
 * a claim about what was painted, and the two must not be able to disagree.
 * The ceiling is often NOT `settings.displayMaxHz` — the bin count clamps it,
 * so a reviewer asking for 12 kHz on a 16 kHz recording gets 8, and an axis
 * built from the setting would label that picture 12 kHz.
 *
 * `hzFromBin(maxBin - 1)` because the top ROW is the top bin: the image spans
 * bin 0 (0 Hz) to bin `maxBin - 1`, one row each. Treating rows as bin centres
 * puts the true top edge half a bin higher — 23 Hz at the default 1024-point
 * window on 48 kHz audio, well under a pixel of the gutter.
 */
function displayBand(
  mags: Magnitudes,
  displayMaxHz: number
): { maxBin: number; ceilingHz: number } {
  const maxBin = Math.min(
    mags.binCount,
    binFromHz(displayMaxHz, mags.fftSize, mags.sampleRate) + 1
  );
  return {
    maxBin,
    ceilingHz: hzFromBin(maxBin - 1, mags.fftSize, mags.sampleRate),
  };
}

export interface RenderStats {
  decodeMs: number;
  fftMs: number;
  paintMs: number;
  numFrames: number;
  sampleRate: number;
  durationSec: number;
}

/*
  Both cached stages carry the inputs they were produced from, and the render
  derives "is this current?" by comparing. The alternative — clearing the cache
  at the top of each effect — means writing state during an effect for the sole
  purpose of describing that same effect, and it opens a frame where the
  previous clip's spectrogram is shown as if it were the new one's.
*/
interface DecodedFor {
  src: string;
  audio: DecodedAudio;
}

interface MagnitudesFor {
  src: string;
  fftSize: number;
  mags: Magnitudes;
}

export function LiveSpectrogram({
  src,
  bandLeftPct,
  bandRightPct,
  clipSeconds,
  audioRef,
  settings,
  height = 300,
  onStats,
  onUnsupported,
}: {
  /** The clip AUDIO url — not the pre-rendered image. */
  src: string;
  bandLeftPct: number;
  bandRightPct: number;
  /** Measured clip length, shown in the corner. Null until metadata loads. */
  clipSeconds?: number | null;
  audioRef: RefObject<HTMLAudioElement | null>;
  settings: ReviewSpectrogramSettings;
  height?: number;
  onStats?: (stats: RenderStats) => void;
  /** Called when this browser cannot decode the clip, so the caller can fall
   *  back to the server-rendered image rather than showing a reviewer an
   *  empty box. */
  onUnsupported?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [decodedFor, setDecodedFor] = useState<DecodedFor | null>(null);
  const [magnitudesFor, setMagnitudesFor] = useState<MagnitudesFor | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const statsRef = useRef<Partial<RenderStats>>({});

  const decoded = decodedFor?.src === src ? decodedFor.audio : null;
  const magnitudes =
    magnitudesFor?.src === src && magnitudesFor.fftSize === settings.fftSize
      ? magnitudesFor.mags
      : null;
  const stage: "loading" | "ready" | "error" =
    failedSrc === src ? "error" : magnitudes ? "ready" : "loading";

  // Latest-callback refs: `onStats` / `onUnsupported` are usually inline
  // closures, and putting them in effect deps would re-decode the clip on every
  // parent render.
  const onStatsRef = useRef(onStats);
  const onUnsupportedRef = useRef(onUnsupported);
  useEffect(() => {
    onStatsRef.current = onStats;
    onUnsupportedRef.current = onUnsupported;
  });

  // ---- 1. Decode ----------------------------------------------------------
  useEffect(() => {
    if (decodedFor?.src === src) return;
    let cancelled = false;
    statsRef.current = {};

    const t0 = performance.now();
    decodeAudio(src)
      .then((audio) => {
        if (cancelled) return;
        statsRef.current.decodeMs = measure(MEASURE.decode, t0);
        statsRef.current.sampleRate = audio.sampleRate;
        statsRef.current.durationSec = audio.duration;
        setDecodedFor({ src, audio });
      })
      .catch(() => {
        if (cancelled) return;
        setFailedSrc(src);
        onUnsupportedRef.current?.();
      });

    return () => {
      cancelled = true;
    };
  }, [src, decodedFor?.src]);

  // ---- 2. FFT -------------------------------------------------------------
  // Re-runs ONLY when the clip or the FFT size changes. Deferred a tick so the
  // new clip's marks paint before the main thread goes into the transform.
  useEffect(() => {
    if (!decoded || magnitudes) return;
    let cancelled = false;

    const id = window.setTimeout(() => {
      if (cancelled) return;
      try {
        const t0 = performance.now();
        const mags = computeMagnitudes({
          samples: decoded.samples,
          sampleRate: decoded.sampleRate,
          fftSize: settings.fftSize,
          hopSize: settings.fftSize / 2,
        });
        if (cancelled) return;
        statsRef.current.fftMs = measure(MEASURE.fft, t0);
        statsRef.current.numFrames = mags.numFrames;
        setMagnitudesFor({ src, fftSize: settings.fftSize, mags });
      } catch {
        if (!cancelled) setFailedSrc(src);
      }
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [decoded, magnitudes, src, settings.fftSize]);

  // Canvas bitmap width scales with zoom; CSS width follows it, and the parent
  // scrolls. 1600 matches the pre-rendered path's OUT_WIDTH so an unzoomed
  // canvas carries the same horizontal detail as the WebP it replaces.
  const bitmapWidth = BASE_BITMAP_WIDTH * settings.zoom;

  // Before the first FFT there is nothing painted to describe, so the axis
  // states the setting; from then on it states the picture.
  const axisMaxHz = magnitudes
    ? displayBand(magnitudes, settings.displayMaxHz).ceilingHz
    : settings.displayMaxHz;

  // ---- 3. Paint -----------------------------------------------------------
  // Colour mapping only. No FFT here — that is what keeps the sliders live.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!magnitudes || !canvas) return;

    const t0 = performance.now();
    const { maxBin: displayMaxBin } = displayBand(magnitudes, settings.displayMaxHz);

    const img = renderImageData({
      magnitudes: magnitudes.magnitudes,
      numFrames: magnitudes.numFrames,
      binCount: magnitudes.binCount,
      displayMaxBin,
      gainDB: settings.gainDB,
      rangeDB: settings.rangeDB,
      lut: COLORMAPS[settings.colormap],
    });

    // The FFT bitmap is one pixel per frame and per bin; the canvas is the box
    // it is displayed in. Blit through an offscreen canvas so the browser does
    // the scaling, exactly as the pre-rendered path lets sharp do it.
    const off = document.createElement("canvas");
    off.width = img.width;
    off.height = img.height;
    const offCtx = off.getContext("2d");
    if (!offCtx) return;
    const imageData = offCtx.createImageData(img.width, img.height);
    imageData.data.set(img.data);
    offCtx.putImageData(imageData, 0, 0);

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "medium";
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Stretched to fill, NOT letterboxed — the percentage geometry in
    // `ClipMarks` assumes the clip spans the box edge to edge.
    ctx.drawImage(off, 0, 0, canvas.width, canvas.height);

    statsRef.current.paintMs = measure(MEASURE.paint, t0);
    const s = statsRef.current;
    if (s.decodeMs != null && s.fftMs != null) {
      onStatsRef.current?.({
        decodeMs: s.decodeMs,
        fftMs: s.fftMs,
        paintMs: s.paintMs ?? 0,
        numFrames: s.numFrames ?? 0,
        sampleRate: s.sampleRate ?? 0,
        durationSec: s.durationSec ?? 0,
      });
    }
    // `bitmapWidth` is a dependency because assigning `canvas.width` RESETS the
    // bitmap to transparent black. Without it, changing the zoom resized the
    // canvas and then nothing repainted it — a blank box, reproducibly, at
    // every zoom level but 1x.
  }, [
    magnitudes,
    bitmapWidth,
    height,
    settings.gainDB,
    settings.rangeDB,
    settings.displayMaxHz,
    settings.colormap,
  ]);

  /*
    Land on the DETECTION when the clip or the zoom changes.

    Resetting to the left edge (what this did first) puts a 4x-zoomed reviewer
    at second 0 of 9, looking at context, with the thing they are judging three
    screens to the right. The detection is the only part of the clip anyone
    opened zoom for, so that is where the view starts; the flanking context is
    a scroll away, and playback tracks from wherever it begins.
  */
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    // The band midpoint, NOT a hardcoded 50%: 3,704 of 54,426 sampled clips
    // sit against the start of their recording, so their detection is
    // off-centre (see `detectionBand`).
    const next = centeredScrollLeft(
      (bandLeftPct + bandRightPct) / 2,
      box.scrollWidth,
      box.clientWidth
    );
    box.scrollLeft = next ?? 0;
  }, [src, settings.zoom, bandLeftPct, bandRightPct]);

  return (
    <AxisFrame
      height={height}
      maxHz={axisMaxHz}
      clipSeconds={clipSeconds}
      zoom={settings.zoom}
      scrollRef={scrollRef}
    >
      <>
        <ClipMarks
          bandLeftPct={bandLeftPct}
          bandRightPct={bandRightPct}
          clipSeconds={clipSeconds}
          audioRef={audioRef}
          resetKey={src}
          scrollRef={scrollRef}
          surface={
            <canvas
              ref={canvasRef}
              width={bitmapWidth}
              /* Bitmap height == display height, so the FFT rows are scaled
                 ONCE. Pinning it to the server renderer's 264 and then letting
                 CSS stretch that to the box was two resamples of a picture
                 only ~257 rows tall to begin with. */
              height={height}
              className="block h-full w-full"
            />
          }
        />

        {stage !== "ready" ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="rounded bg-black/60 px-2 py-1 text-[11px] text-white/80">
              {stage === "error"
                ? "No se pudo generar el espectrograma"
                : "Generando espectrograma…"}
            </span>
          </div>
        ) : null}
      </>
    </AxisFrame>
  );
}
