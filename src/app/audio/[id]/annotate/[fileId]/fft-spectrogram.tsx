"use client";

import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useImperativeHandle,
  forwardRef,
  useMemo,
} from "react";
import { Loader2 } from "lucide-react";
import {
  decodeAudio,
  computeMagnitudes,
  binFromHz,
  type Magnitudes,
  type DecodedAudio,
} from "@/lib/audio-fft";
import { renderImageData } from "@/lib/spectrogram-render";
import { COLORMAPS, type ColormapName } from "@/lib/spectrogram-colormaps";
import { getSpeciesColor } from "@/lib/species-color";
import {
  FREQ_AXIS_WIDTH,
  TIME_AXIS_HEIGHT,
  SPEC_HEIGHT_PRESETS,
  type HeightPreset,
  type ZoomLevel,
  stepZoom,
  viewportToTime,
  timeToScrollOffset,
  withinViewportTailZone,
  visibleTimeWindow,
  decideLabelCollapse,
  speciesInitial,
  assignLanes,
  type LaneAssignment,
} from "@/lib/spectrogram-layout";
import { Button } from "@/components/ui/button";

const DRAG_THRESHOLD_PX = 5;
const MIN_BOX_PX = 10;
const HANDLE_PX = 8;
const HANDLE_HIT_PX = 18;
const TIME_TICK_STEPS = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
const FREQ_TICK_STEPS = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const SCROLL_STEP_FRACTION = 0.25;

type LoadStage = "idle" | "fetching" | "computing" | "ready" | "error";
type ResizeHandle = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

type DragState =
  | { kind: "idle" }
  | {
      kind: "drawing-new";
      startNX: number;
      startNY: number;
      currentNX: number;
      currentNY: number;
      hasDragged: boolean;
    }
  | {
      kind: "moving";
      boxId: number;
      startNX: number;
      startNY: number;
      currentNX: number;
      currentNY: number;
      original: AudioBoxData;
      hasDragged: boolean;
    }
  | {
      kind: "resizing";
      boxId: number;
      handle: ResizeHandle;
      startNX: number;
      startNY: number;
      currentNX: number;
      currentNY: number;
      original: AudioBoxData;
    };

export interface AudioBoxData {
  id: number;
  startTime: number;
  endTime: number;
  minFreq: number;
  maxFreq: number;
  species?: string | null;
  displayLabel?: string | null;
  verificationStatus?: string;
}

export interface SpectrogramMethods {
  play: () => Promise<void>;
  pause: () => void;
  playPause: () => Promise<void>;
  seek: (time: number) => void;
  skip: (seconds: number) => void;
  playSelection: (startTime: number, endTime: number) => Promise<void>;
  loopSelection: (startTime: number, endTime: number) => Promise<void>;
  stopLoop: () => void;
  isLooping: () => boolean;
  getDuration: () => number;
  isPlaying: () => boolean;
  /** Smooth-scroll the viewport so `time` lands at the centre. Respects
   *  `prefers-reduced-motion`. */
  scrollToTime: (time: number) => void;
  /** Step zoom up / down / reset (with cursor anchor at viewport centre). */
  zoomIn: () => void;
  zoomOut: () => void;
  zoomReset: () => void;
  /** Scroll by ±25% of the viewport width. */
  scrollBy: (direction: -1 | 1) => void;
}

export interface SpecMeasurement {
  /** Width of the scroll-viewport (excluding freq-axis gutter). */
  viewportWidth: number;
  /** Total inner-container width = baseWidth × zoomLevel. */
  scrollWidth: number;
  /** Current spec-area pixel height (resolved from `HeightPreset`). */
  specHeight: number;
}

interface FftSpectrogramProps {
  audioUrl: string;
  boxes: AudioBoxData[];
  selectedBoxId: number | null;
  editable: boolean;
  displayMaxHz: number;
  gainDB: number;
  rangeDB: number;
  fftSize: number;
  colormap: ColormapName;
  /** Spec-area pixel height, resolved from a `HeightPreset` (Compacto /
   *  Cómodo / Alto). Parent applies the narrow-viewport mobile cap before
   *  passing this in. */
  height?: HeightPreset;
  /** Discrete time-axis zoom; 1× = base width, 8× = inner is 8× viewport. */
  zoomLevel?: ZoomLevel;
  /** When true, the viewport auto-scrolls to keep the playhead visible
   *  during playback. User-initiated scroll temporarily pauses follow until
   *  the next seek / playSelection. */
  followPlayback?: boolean;
  /** Monotonic counter; increment in the parent whenever the detection set
   *  mutates so `assignLanes()` + visible-window memo can invalidate without
   *  taking a dependency on the `boxes` array reference (which can change
   *  every render). */
  detectionsVersion?: number;
  /** Monotonic counter; increment to retrigger the pulse animation on the
   *  currently-selected box (used by card-click in the sidebar). */
  pulseKey?: number;
  onBoxClick?: (box: AudioBoxData) => void;
  onDrawComplete?: (box: BoxRect) => void;
  onBoxResized?: (boxId: number, box: BoxRect) => void;
  onReady?: (meta: { duration: number; sampleRate: number }) => void;
  onTimeUpdate?: (currentTime: number) => void;
  onPlayPause?: (playing: boolean) => void;
  /** Fires on layout / resize / zoom change. The parent uses this with
   *  `onScrollChange` to compute popover anchor positions. */
  onMeasurementsChange?: (m: SpecMeasurement) => void;
  /** Fires on viewport scroll (rAF-batched). The parent recomputes the
   *  popover anchor against this `scrollLeft`. */
  onScrollChange?: (scrollLeft: number) => void;
  /** Fires when the spectrogram itself wants to step the zoom (wheel or
   *  imperative method). Parent updates the settings; the spectrogram
   *  applies a pending cursor anchor in an effect on `zoomLevel`. */
  onZoomChange?: (next: ZoomLevel) => void;
}

interface BoxRect {
  startTime: number;
  endTime: number;
  minFreq: number;
  maxFreq: number;
}

function sizeCanvas(canvas: HTMLCanvasElement, cssW: number, cssH: number) {
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  canvas.width = Math.max(1, Math.round(cssW * dpr));
  canvas.height = Math.max(1, Math.round(cssH * dpr));
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext("2d");
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function pickTickStep(rangePerPx: number, targetSpacingPx: number, steps: readonly number[]): number {
  const target = rangePerPx * targetSpacingPx;
  for (const step of steps) {
    if (step >= target) return step;
  }
  return steps[steps.length - 1];
}

function formatHz(hz: number): string {
  if (hz < 1000) return `${Math.round(hz)} Hz`;
  const kHz = hz / 1000;
  return kHz % 1 === 0 ? `${kHz} kHz` : `${kHz.toFixed(1)} kHz`;
}

function formatSeconds(t: number): string {
  if (t < 60) return `${t < 10 ? t.toFixed(1) : t.toFixed(0)}s`;
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}

function normalizeRect(a: number, b: number) {
  return [Math.min(a, b), Math.max(a, b)] as const;
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export const FftSpectrogram = forwardRef<SpectrogramMethods, FftSpectrogramProps>(
  function FftSpectrogram(props, ref) {
    const {
      audioUrl,
      boxes,
      selectedBoxId,
      editable,
      displayMaxHz,
      gainDB,
      rangeDB,
      fftSize,
      colormap,
      height = "comodo",
      zoomLevel = 1,
      followPlayback = true,
      detectionsVersion = 0,
      pulseKey = 0,
      onBoxClick,
      onDrawComplete,
      onBoxResized,
      onReady,
      onTimeUpdate,
      onPlayPause,
      onMeasurementsChange,
      onScrollChange,
      onZoomChange,
    } = props;

    // Resolve the height preset to pixels. All canvas sizing, layout, and
    // coordinate math reads this — never the raw constant.
    const specHeight = SPEC_HEIGHT_PRESETS[height];

    const containerRef = useRef<HTMLDivElement>(null);
    const scrollViewportRef = useRef<HTMLDivElement>(null);
    const specCanvasRef = useRef<HTMLCanvasElement>(null);
    const freqAxisRef = useRef<HTMLCanvasElement>(null);
    const timeAxisRef = useRef<HTMLCanvasElement>(null);
    const playheadRef = useRef<HTMLDivElement>(null);
    const audioRef = useRef<HTMLAudioElement>(null);
    const offscreenRef = useRef<HTMLCanvasElement | null>(null);
    const rafRef = useRef<number | null>(null);
    const selectionStartRef = useRef<number | null>(null);
    const selectionEndRef = useRef<number | null>(null);
    const loopRef = useRef(false);
    const suppressNextClickRef = useRef(false);

    // Ref counter (not boolean) — robust against overlapping programmatic
    // scrolls (e.g. card-click during a smooth scroll). Per Kieran review.
    const programmaticScrollDepth = useRef(0);
    // Set when the user manually scrolls during playback; cleared on the next
    // seek / playSelection / play. While set, follow-mode auto-scroll is
    // paused.
    const followPausedByUser = useRef(false);
    // Anchor stashed at zoom-request time. Applied in an effect on
    // `zoomLevel` so the same time stays under the same viewport x.
    const pendingZoomAnchor = useRef<{ time: number; anchorPx: number } | null>(
      null,
    );

    const [stage, setStage] = useState<LoadStage>("idle");
    const [error, setError] = useState<string | null>(null);
    const [decoded, setDecoded] = useState<DecodedAudio | null>(null);
    const [magnitudes, setMagnitudes] = useState<Magnitudes | null>(null);
    const [viewportWidth, setViewportWidth] = useState(0);
    const [scrollLeft, setScrollLeft] = useState(0);
    const [hoverBoxId, setHoverBoxId] = useState<number | null>(null);
    const [previewRect, setPreviewRect] = useState<BoxRect | null>(null);
    const [dragOverride, setDragOverride] = useState<{ boxId: number; rect: BoxRect } | null>(null);
    const dragRef = useRef<DragState>({ kind: "idle" });

    // Inner-container width is the viewport width × zoom level. SVG `viewBox`
    // and label positioning both work in inner-pixel space.
    const innerWidth = viewportWidth * zoomLevel;
    const specSize = useMemo(
      () => ({ width: innerWidth, height: specHeight }),
      [innerWidth, specHeight],
    );

    // Latest callback refs to avoid stale closures in pointer handlers.
    const onDrawCompleteRef = useRef(onDrawComplete);
    const onBoxResizedRef = useRef(onBoxResized);
    const onBoxClickRef = useRef(onBoxClick);
    useEffect(() => {
      onDrawCompleteRef.current = onDrawComplete;
      onBoxResizedRef.current = onBoxResized;
      onBoxClickRef.current = onBoxClick;
    });

    const duration = decoded?.duration ?? 0;
    const sampleRate = decoded?.sampleRate ?? 0;
    const nyquist = sampleRate / 2;

    // ---- Decode pipeline ----------------------------------------------------
    useEffect(() => {
      let cancelled = false;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStage("fetching");
      setError(null);
      setDecoded(null);
      setMagnitudes(null);

      decodeAudio(audioUrl)
        .then((d) => {
          if (cancelled) return;
          setDecoded(d);
          onReady?.({ duration: d.duration, sampleRate: d.sampleRate });
          setStage("computing");
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          console.error("[FftSpectrogram] decode failed", err);
          setStage("error");
          setError("Audio no se pudo decodificar. Intenta de nuevo o salta a otro archivo.");
        });

      return () => {
        cancelled = true;
      };
    }, [audioUrl, onReady]);

    // ---- FFT compute --------------------------------------------------------
    useEffect(() => {
      if (!decoded) return;
      let cancelled = false;

      const id = setTimeout(() => {
        if (cancelled) return;
        try {
          const result = computeMagnitudes({
            samples: decoded.samples,
            sampleRate: decoded.sampleRate,
            fftSize,
            hopSize: fftSize / 2,
          });
          if (cancelled) return;
          setMagnitudes(result);
          setStage("ready");
        } catch (err) {
          console.error("[FftSpectrogram] FFT failed", err);
          if (!cancelled) {
            setStage("error");
            setError("No se pudo calcular el espectrograma.");
          }
        }
      }, 0);

      return () => {
        cancelled = true;
        clearTimeout(id);
      };
    }, [decoded, fftSize]);

    // ---- Render to spec canvas ---------------------------------------------
    // The spec canvas internal bitmap is sized to the *viewport* width (DPR-
    // scaled) — we then CSS-stretch it across the full inner width via the
    // `width: 100%` style. Beyond ~4× this loses pixel fidelity; documented
    // tradeoff (`docs/plans/.../zoom-density-plan.md` Cross-cutting → CSS
    // scaling vs FFT recompute).
    useEffect(() => {
      if (!magnitudes || !specCanvasRef.current || specSize.width === 0) return;

      const displayMaxBin = Math.min(
        magnitudes.binCount,
        binFromHz(displayMaxHz, magnitudes.fftSize, magnitudes.sampleRate) + 1
      );

      const img = renderImageData({
        magnitudes: magnitudes.magnitudes,
        numFrames: magnitudes.numFrames,
        binCount: magnitudes.binCount,
        displayMaxBin,
        gainDB,
        rangeDB,
        lut: COLORMAPS[colormap],
      });

      let off = offscreenRef.current;
      if (!off) {
        off = document.createElement("canvas");
        offscreenRef.current = off;
      }
      if (off.width !== img.width || off.height !== img.height) {
        off.width = img.width;
        off.height = img.height;
      }
      const offCtx = off.getContext("2d");
      if (!offCtx) return;
      const imageData = offCtx.createImageData(img.width, img.height);
      imageData.data.set(img.data);
      offCtx.putImageData(imageData, 0, 0);

      const specCanvas = specCanvasRef.current;
      const ctx = specCanvas.getContext("2d");
      if (!ctx) return;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "medium";
      ctx.clearRect(0, 0, specSize.width, specSize.height);
      ctx.drawImage(off, 0, 0, specSize.width, specSize.height);
    }, [magnitudes, gainDB, rangeDB, colormap, displayMaxHz, specSize]);

    // ---- Frequency axis -----------------------------------------------------
    useEffect(() => {
      const canvas = freqAxisRef.current;
      if (!canvas) return;
      sizeCanvas(canvas, FREQ_AXIS_WIDTH, specHeight);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, FREQ_AXIS_WIDTH, specHeight);
      ctx.fillStyle = "#0a0a0a";
      ctx.fillRect(0, 0, FREQ_AXIS_WIDTH, specHeight);
      ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle = "#d4d4d8";
      ctx.strokeStyle = "#3f3f46";
      ctx.lineWidth = 1;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";

      const hzPerPx = displayMaxHz / specHeight;
      const step = pickTickStep(hzPerPx, 36, FREQ_TICK_STEPS);
      const firstTick = 0;
      for (let hz = firstTick; hz <= displayMaxHz + 0.001; hz += step) {
        const y = specHeight - (hz / displayMaxHz) * specHeight;
        if (y < 8 || y > specHeight - 4) continue;
        ctx.beginPath();
        ctx.moveTo(FREQ_AXIS_WIDTH - 4, y);
        ctx.lineTo(FREQ_AXIS_WIDTH, y);
        ctx.stroke();
        ctx.fillText(formatHz(hz), FREQ_AXIS_WIDTH - 6, y);
      }
    }, [displayMaxHz, specHeight]);

    // ---- Time axis ----------------------------------------------------------
    // Sized to the full inner width and re-draws on zoom. Tick density
    // targets ~80 px between labels at every zoom level so the axis stays
    // readable.
    useEffect(() => {
      const canvas = timeAxisRef.current;
      if (!canvas || innerWidth === 0 || duration === 0) return;
      sizeCanvas(canvas, innerWidth, TIME_AXIS_HEIGHT);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, innerWidth, TIME_AXIS_HEIGHT);
      ctx.fillStyle = "#0a0a0a";
      ctx.fillRect(0, 0, innerWidth, TIME_AXIS_HEIGHT);
      ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle = "#d4d4d8";
      ctx.strokeStyle = "#3f3f46";
      ctx.lineWidth = 1;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      const secPerPx = duration / innerWidth;
      const step = pickTickStep(secPerPx, 80, TIME_TICK_STEPS);
      for (let t = 0; t <= duration + 0.001; t += step) {
        const x = (t / duration) * innerWidth;
        if (x < 12 || x > innerWidth - 12) continue;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, 4);
        ctx.stroke();
        ctx.fillText(formatSeconds(t), x, TIME_AXIS_HEIGHT / 2 + 2);
      }
    }, [duration, innerWidth]);

    // ---- Resize observer ----------------------------------------------------
    // Watches the scroll viewport (NOT the outer container) for its
    // `clientWidth`. The freq-axis is outside the scroll viewport so its
    // width never participates in this measurement.
    useEffect(() => {
      const viewport = scrollViewportRef.current;
      if (!viewport) return;

      const apply = () => {
        const cssW = Math.max(0, viewport.clientWidth);
        const newInner = cssW * zoomLevel;
        // Preserve the centered time region across resize. Computed from the
        // pre-resize state read directly from the DOM.
        const prevInner = viewport.scrollWidth;
        const prevScroll = viewport.scrollLeft;
        const prevViewport = viewport.clientWidth;
        const centerTime =
          prevInner > 0 && duration > 0
            ? ((prevScroll + prevViewport / 2) / prevInner) * duration
            : 0;

        if (specCanvasRef.current) sizeCanvas(specCanvasRef.current, newInner, specHeight);
        if (timeAxisRef.current) sizeCanvas(timeAxisRef.current, newInner, TIME_AXIS_HEIGHT);
        setViewportWidth(cssW);

        if (duration > 0 && prevInner > 0 && newInner > 0) {
          // Schedule scroll restore after the inner container width updates
          // (next frame). Counts as programmatic.
          programmaticScrollDepth.current++;
          requestAnimationFrame(() => {
            const v = scrollViewportRef.current;
            if (v) {
              v.scrollLeft = timeToScrollOffset(
                centerTime,
                duration,
                v.scrollWidth,
                v.clientWidth,
                v.clientWidth / 2,
              );
            }
            requestAnimationFrame(() => {
              programmaticScrollDepth.current = Math.max(
                0,
                programmaticScrollDepth.current - 1,
              );
            });
          });
        }
      };
      apply();

      const ro = new ResizeObserver(apply);
      ro.observe(viewport);
      return () => ro.disconnect();
      // specHeight + zoomLevel are part of deps so we re-allocate on both.
      // `duration` deliberately omitted — resize math reads it live above.
    }, [specHeight, zoomLevel, duration]);

    // ---- Apply pending cursor-anchored scroll after zoom change ------------
    useEffect(() => {
      const anchor = pendingZoomAnchor.current;
      if (!anchor) return;
      const v = scrollViewportRef.current;
      if (!v || v.scrollWidth === 0) return;
      pendingZoomAnchor.current = null;
      programmaticScrollDepth.current++;
      v.scrollLeft = timeToScrollOffset(
        anchor.time,
        duration,
        v.scrollWidth,
        v.clientWidth,
        anchor.anchorPx,
      );
      requestAnimationFrame(() => {
        programmaticScrollDepth.current = Math.max(
          0,
          programmaticScrollDepth.current - 1,
        );
      });
    }, [zoomLevel, duration]);

    // ---- Surface measurements + scroll to parent ---------------------------
    useEffect(() => {
      onMeasurementsChange?.({
        viewportWidth,
        scrollWidth: innerWidth,
        specHeight,
      });
    }, [viewportWidth, innerWidth, specHeight, onMeasurementsChange]);

    // ---- Scroll handler (rAF-batched) --------------------------------------
    useEffect(() => {
      const v = scrollViewportRef.current;
      if (!v) return;
      let rafScheduled = false;
      const handler = () => {
        if (rafScheduled) return;
        rafScheduled = true;
        requestAnimationFrame(() => {
          rafScheduled = false;
          const sl = v.scrollLeft;
          setScrollLeft(sl);
          onScrollChange?.(sl);
          // User-initiated scroll during playback pauses follow.
          if (programmaticScrollDepth.current === 0 && !audioRef.current?.paused) {
            followPausedByUser.current = true;
          }
        });
      };
      v.addEventListener("scroll", handler, { passive: true });
      return () => v.removeEventListener("scroll", handler);
    }, [onScrollChange]);

    // ---- Wheel zoom (Ctrl / Cmd + wheel; also trackpad pinch) -------------
    useEffect(() => {
      const v = scrollViewportRef.current;
      if (!v) return;
      let zoomQueued = false;
      const handler = (e: WheelEvent) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        if (zoomQueued) return;
        zoomQueued = true;
        requestAnimationFrame(() => {
          zoomQueued = false;
        });
        const direction: 1 | -1 = e.deltaY < 0 ? 1 : -1;
        const next = stepZoom(zoomLevel, direction);
        if (next === zoomLevel) return;
        const rect = v.getBoundingClientRect();
        const anchorPx = e.clientX - rect.left;
        const time = viewportToTime(
          v.scrollLeft + anchorPx,
          v.scrollWidth,
          duration,
        );
        pendingZoomAnchor.current = { time, anchorPx };
        onZoomChange?.(next);
      };
      v.addEventListener("wheel", handler, { passive: false });
      return () => v.removeEventListener("wheel", handler);
    }, [zoomLevel, duration, onZoomChange]);

    // ---- Audio playback rAF -------------------------------------------------
    useEffect(() => {
      const audio = audioRef.current;
      if (!audio) return;

      const tick = () => {
        const a = audioRef.current;
        if (!a) return;
        const t = a.currentTime;
        if (selectionEndRef.current !== null && t >= selectionEndRef.current) {
          if (loopRef.current && selectionStartRef.current !== null) {
            a.currentTime = selectionStartRef.current;
          } else {
            a.pause();
            selectionEndRef.current = null;
            selectionStartRef.current = null;
          }
        }
        if (playheadRef.current && duration > 0 && innerWidth > 0) {
          const x = (t / duration) * innerWidth;
          playheadRef.current.style.transform = `translateX(${x}px)`;
          // Follow-the-playhead. Auto-scroll only when in the tail zone and
          // the user hasn't taken control of the viewport.
          const v = scrollViewportRef.current;
          if (
            followPlayback &&
            !followPausedByUser.current &&
            v &&
            withinViewportTailZone(x, v.scrollLeft, v.clientWidth)
          ) {
            programmaticScrollDepth.current++;
            const target = timeToScrollOffset(
              t,
              duration,
              v.scrollWidth,
              v.clientWidth,
              v.clientWidth / 2,
            );
            v.scrollTo({
              left: target,
              behavior: prefersReducedMotion() ? "auto" : "smooth",
            });
            requestAnimationFrame(() => {
              programmaticScrollDepth.current = Math.max(
                0,
                programmaticScrollDepth.current - 1,
              );
            });
          }
        }
        onTimeUpdate?.(t);
        rafRef.current = requestAnimationFrame(tick);
      };

      const onPlay = () => {
        followPausedByUser.current = false;
        onPlayPause?.(true);
        rafRef.current = requestAnimationFrame(tick);
      };
      const onPause = () => {
        onPlayPause?.(false);
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        onTimeUpdate?.(audio.currentTime);
      };
      const onEnded = () => {
        onPlayPause?.(false);
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
      };
      const onSeeked = () => {
        followPausedByUser.current = false;
        if (playheadRef.current && duration > 0 && innerWidth > 0) {
          const x = (audio.currentTime / duration) * innerWidth;
          playheadRef.current.style.transform = `translateX(${x}px)`;
        }
        onTimeUpdate?.(audio.currentTime);
      };

      audio.addEventListener("play", onPlay);
      audio.addEventListener("pause", onPause);
      audio.addEventListener("ended", onEnded);
      audio.addEventListener("seeked", onSeeked);
      return () => {
        audio.removeEventListener("play", onPlay);
        audio.removeEventListener("pause", onPause);
        audio.removeEventListener("ended", onEnded);
        audio.removeEventListener("seeked", onSeeked);
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
      };
    }, [duration, innerWidth, followPlayback, onTimeUpdate, onPlayPause]);

    // ---- Internal scroll-to helpers ----------------------------------------
    const scrollToTimeInternal = useCallback(
      (time: number) => {
        const v = scrollViewportRef.current;
        if (!v || duration <= 0) return;
        programmaticScrollDepth.current++;
        const target = timeToScrollOffset(
          time,
          duration,
          v.scrollWidth,
          v.clientWidth,
          v.clientWidth / 2,
        );
        v.scrollTo({
          left: target,
          behavior: prefersReducedMotion() ? "auto" : "smooth",
        });
        requestAnimationFrame(() => {
          programmaticScrollDepth.current = Math.max(
            0,
            programmaticScrollDepth.current - 1,
          );
        });
      },
      [duration],
    );

    const queueViewportCenterZoom = useCallback(
      (direction: 1 | -1) => {
        const v = scrollViewportRef.current;
        if (!v) return;
        const next = stepZoom(zoomLevel, direction);
        if (next === zoomLevel) return;
        const anchorPx = v.clientWidth / 2;
        const time = viewportToTime(
          v.scrollLeft + anchorPx,
          v.scrollWidth,
          duration,
        );
        pendingZoomAnchor.current = { time, anchorPx };
        onZoomChange?.(next);
      },
      [zoomLevel, duration, onZoomChange],
    );

    // ---- Imperative ref ----------------------------------------------------
    useImperativeHandle(
      ref,
      () => ({
        play: async () => {
          const a = audioRef.current;
          if (!a) return;
          loopRef.current = false;
          selectionEndRef.current = null;
          selectionStartRef.current = null;
          await a.play();
        },
        pause: () => {
          loopRef.current = false;
          audioRef.current?.pause();
        },
        playPause: async () => {
          const a = audioRef.current;
          if (!a) return;
          if (a.paused) {
            loopRef.current = false;
            selectionEndRef.current = null;
            selectionStartRef.current = null;
            await a.play();
          } else {
            loopRef.current = false;
            a.pause();
          }
        },
        seek: (time: number) => {
          const a = audioRef.current;
          if (!a) return;
          loopRef.current = false;
          selectionEndRef.current = null;
          selectionStartRef.current = null;
          a.currentTime = clamp(time, 0, a.duration || 0);
        },
        skip: (seconds: number) => {
          const a = audioRef.current;
          if (!a) return;
          loopRef.current = false;
          selectionEndRef.current = null;
          selectionStartRef.current = null;
          a.currentTime = clamp((a.currentTime || 0) + seconds, 0, a.duration || 0);
        },
        playSelection: async (startTime: number, endTime: number) => {
          const a = audioRef.current;
          if (!a) return;
          loopRef.current = false;
          a.currentTime = startTime;
          selectionStartRef.current = startTime;
          selectionEndRef.current = endTime;
          await a.play();
        },
        loopSelection: async (startTime: number, endTime: number) => {
          const a = audioRef.current;
          if (!a) return;
          const clampedEnd = Math.min(endTime, (a.duration || endTime) - 0.05);
          loopRef.current = true;
          a.currentTime = startTime;
          selectionStartRef.current = startTime;
          selectionEndRef.current = clampedEnd > startTime ? clampedEnd : endTime;
          await a.play();
        },
        stopLoop: () => {
          loopRef.current = false;
          selectionEndRef.current = null;
          selectionStartRef.current = null;
          audioRef.current?.pause();
        },
        isLooping: () => loopRef.current,
        getDuration: () => audioRef.current?.duration ?? 0,
        isPlaying: () => !!audioRef.current && !audioRef.current.paused,
        scrollToTime: scrollToTimeInternal,
        zoomIn: () => queueViewportCenterZoom(1),
        zoomOut: () => queueViewportCenterZoom(-1),
        zoomReset: () => {
          if (zoomLevel === 1) return;
          // Anchor the center time so it stays visible after zooming out.
          const v = scrollViewportRef.current;
          if (v) {
            const anchorPx = v.clientWidth / 2;
            const time = viewportToTime(
              v.scrollLeft + anchorPx,
              v.scrollWidth,
              duration,
            );
            pendingZoomAnchor.current = { time, anchorPx };
          }
          onZoomChange?.(1);
        },
        scrollBy: (direction: -1 | 1) => {
          const v = scrollViewportRef.current;
          if (!v) return;
          programmaticScrollDepth.current++;
          v.scrollBy({
            left: direction * v.clientWidth * SCROLL_STEP_FRACTION,
            behavior: prefersReducedMotion() ? "auto" : "smooth",
          });
          requestAnimationFrame(() => {
            programmaticScrollDepth.current = Math.max(
              0,
              programmaticScrollDepth.current - 1,
            );
          });
        },
      }),
      [scrollToTimeInternal, queueViewportCenterZoom, zoomLevel, duration, onZoomChange],
    );

    // ---- Coordinate helpers (CSS px ↔ time/freq/normalized) ----------------
    const nxToTime = useCallback((nx: number) => clamp(nx, 0, 1) * duration, [duration]);
    const nyToHz = useCallback(
      (ny: number) => clamp(1 - clamp(ny, 0, 1), 0, 1) * displayMaxHz,
      [displayMaxHz]
    );
    const timeToNX = useCallback(
      (t: number) => (duration > 0 ? clamp(t / duration, 0, 1) : 0),
      [duration]
    );
    const hzToNY = useCallback(
      (hz: number) => (displayMaxHz > 0 ? 1 - clamp(hz / displayMaxHz, 0, 1) : 1),
      [displayMaxHz]
    );

    const eventToNorm = useCallback((clientX: number, clientY: number) => {
      const svg = document.getElementById("fft-spec-svg");
      if (!svg) return { nx: 0, ny: 0 };
      const rect = svg.getBoundingClientRect();
      return {
        nx: clamp((clientX - rect.left) / rect.width, 0, 1),
        ny: clamp((clientY - rect.top) / rect.height, 0, 1),
      };
    }, []);

    // ---- Pointer event handlers --------------------------------------------
    const handleSvgPointerDown = useCallback(
      (e: React.PointerEvent<SVGSVGElement>) => {
        if (!editable) return;
        const target = e.target as SVGElement;
        const handleEl = target.closest("[data-handle]");
        const boxEl = target.closest("[data-box-id]");
        const { nx, ny } = eventToNorm(e.clientX, e.clientY);

        if (handleEl) {
          const boxId = Number(handleEl.getAttribute("data-box-id"));
          const handle = handleEl.getAttribute("data-handle") as ResizeHandle;
          const original = boxes.find((b) => b.id === boxId);
          if (!original) return;
          dragRef.current = {
            kind: "resizing",
            boxId,
            handle,
            startNX: nx,
            startNY: ny,
            currentNX: nx,
            currentNY: ny,
            original,
          };
          (e.target as Element).setPointerCapture(e.pointerId);
          return;
        }

        if (boxEl) {
          const boxId = Number(boxEl.getAttribute("data-box-id"));
          const original = boxes.find((b) => b.id === boxId);
          if (!original) return;
          dragRef.current = {
            kind: "moving",
            boxId,
            startNX: nx,
            startNY: ny,
            currentNX: nx,
            currentNY: ny,
            original,
            hasDragged: false,
          };
          (e.target as Element).setPointerCapture(e.pointerId);
          return;
        }

        if (onDrawCompleteRef.current) {
          dragRef.current = {
            kind: "drawing-new",
            startNX: nx,
            startNY: ny,
            currentNX: nx,
            currentNY: ny,
            hasDragged: false,
          };
          (e.target as Element).setPointerCapture(e.pointerId);
        }
      },
      [editable, boxes, eventToNorm]
    );

    const handleSvgPointerMove = useCallback(
      (e: React.PointerEvent<SVGSVGElement>) => {
        const drag = dragRef.current;
        if (drag.kind === "idle") return;
        const { nx, ny } = eventToNorm(e.clientX, e.clientY);

        if (drag.kind === "drawing-new") {
          drag.currentNX = nx;
          drag.currentNY = ny;
          const dx = Math.abs(nx - drag.startNX) * specSize.width;
          const dy = Math.abs(ny - drag.startNY) * specSize.height;
          if (!drag.hasDragged && Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD_PX) {
            drag.hasDragged = true;
          }
          if (drag.hasDragged) {
            const [x0, x1] = normalizeRect(drag.startNX, drag.currentNX);
            const [y0, y1] = normalizeRect(drag.startNY, drag.currentNY);
            setPreviewRect({
              startTime: nxToTime(x0),
              endTime: nxToTime(x1),
              minFreq: nyToHz(y1),
              maxFreq: nyToHz(y0),
            });
          }
          return;
        }

        if (drag.kind === "moving") {
          drag.currentNX = nx;
          drag.currentNY = ny;
          const dx = Math.abs(nx - drag.startNX) * specSize.width;
          const dy = Math.abs(ny - drag.startNY) * specSize.height;
          if (!drag.hasDragged && Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD_PX) {
            drag.hasDragged = true;
          }
          if (drag.hasDragged) {
            const dt = nxToTime(nx) - nxToTime(drag.startNX);
            const dHz = nyToHz(ny) - nyToHz(drag.startNY);
            const startTime = clamp(drag.original.startTime + dt, 0, duration);
            const endTime = clamp(drag.original.endTime + dt, 0, duration);
            const minFreq = clamp(drag.original.minFreq + dHz, 0, nyquist);
            const maxFreq = clamp(drag.original.maxFreq + dHz, 0, nyquist);
            const widthPreserved = endTime - startTime > 0.01;
            const heightPreserved = maxFreq - minFreq > 1;
            if (widthPreserved && heightPreserved) {
              setDragOverride({
                boxId: drag.boxId,
                rect: { startTime, endTime, minFreq, maxFreq },
              });
            }
          }
          return;
        }

        if (drag.kind === "resizing") {
          drag.currentNX = nx;
          drag.currentNY = ny;
          const next = applyResize(drag.original, drag.handle, nxToTime(nx), nyToHz(ny), duration, nyquist);
          setDragOverride({ boxId: drag.boxId, rect: next });
        }
      },
      [eventToNorm, nxToTime, nyToHz, specSize.width, specSize.height, duration, nyquist]
    );

    const handleSvgPointerUp = useCallback(
      (e: React.PointerEvent<SVGSVGElement>) => {
        const drag = dragRef.current;
        dragRef.current = { kind: "idle" };

        try {
          (e.target as Element).releasePointerCapture(e.pointerId);
        } catch {}

        if (drag.kind === "drawing-new") {
          setPreviewRect(null);
          if (!drag.hasDragged) return;
          suppressNextClickRef.current = true;
          const [x0, x1] = normalizeRect(drag.startNX, drag.currentNX);
          const [y0, y1] = normalizeRect(drag.startNY, drag.currentNY);
          const wPx = (x1 - x0) * specSize.width;
          const hPx = (y1 - y0) * specSize.height;
          if (wPx < MIN_BOX_PX || hPx < MIN_BOX_PX) return;
          onDrawCompleteRef.current?.({
            startTime: nxToTime(x0),
            endTime: nxToTime(x1),
            minFreq: nyToHz(y1),
            maxFreq: nyToHz(y0),
          });
          return;
        }

        if (drag.kind === "moving") {
          if (!drag.hasDragged) {
            onBoxClickRef.current?.(drag.original);
            setDragOverride(null);
            return;
          }
          suppressNextClickRef.current = true;
          const override = dragOverride;
          setDragOverride(null);
          if (override && override.boxId === drag.boxId) {
            onBoxResizedRef.current?.(drag.boxId, override.rect);
          }
          return;
        }

        if (drag.kind === "resizing") {
          suppressNextClickRef.current = true;
          const override = dragOverride;
          setDragOverride(null);
          if (override && override.boxId === drag.boxId) {
            onBoxResizedRef.current?.(drag.boxId, override.rect);
          }
          return;
        }
      },
      [dragOverride, specSize.width, specSize.height, nxToTime, nyToHz]
    );

    const handleSvgPointerCancel = useCallback(() => {
      dragRef.current = { kind: "idle" };
      setPreviewRect(null);
      setDragOverride(null);
    }, []);

    const handleSvgClick = useCallback(
      (e: React.MouseEvent<SVGSVGElement>) => {
        if (suppressNextClickRef.current) {
          suppressNextClickRef.current = false;
          return;
        }
        const target = e.target as SVGElement;
        if (target.closest("[data-box-id]") || target.closest("[data-handle]")) return;
        const { nx } = eventToNorm(e.clientX, e.clientY);
        const a = audioRef.current;
        if (!a) return;
        loopRef.current = false;
        selectionEndRef.current = null;
        selectionStartRef.current = null;
        a.currentTime = clamp(nxToTime(nx), 0, duration);
      },
      [eventToNorm, nxToTime, duration]
    );

    const handleTimeAxisClick = useCallback(
      (e: React.MouseEvent<HTMLCanvasElement>) => {
        const rect = e.currentTarget.getBoundingClientRect();
        const t = ((e.clientX - rect.left) / rect.width) * duration;
        const a = audioRef.current;
        if (!a) return;
        loopRef.current = false;
        selectionEndRef.current = null;
        selectionStartRef.current = null;
        a.currentTime = clamp(t, 0, duration);
      },
      [duration]
    );

    // ---- Render boxes (with dragOverride applied) --------------------------
    const renderedBoxes = useMemo(() => {
      if (!dragOverride) return boxes;
      return boxes.map((b) =>
        b.id === dragOverride.boxId
          ? {
              ...b,
              startTime: dragOverride.rect.startTime,
              endTime: dragOverride.rect.endTime,
              minFreq: dragOverride.rect.minFreq,
              maxFreq: dragOverride.rect.maxFreq,
            }
          : b
      );
    }, [boxes, dragOverride]);

    // ---- Lane assignment (Phase 4) -----------------------------------------
    // Keyed on detectionsVersion (NOT on the boxes array reference) per the
    // memoization contract in spectrogram-layout.ts. Logs once per dense
    // group so we can spot pathological detection-density files.
    const lanes = useMemo(() => {
      const result = assignLanes(renderedBoxes);
      const denseGroups = new Set<number>();
      for (const v of result.values()) {
        if (v.mode === "dense" && !denseGroups.has(v.groupSize)) {
          denseGroups.add(v.groupSize);
          console.warn("[spectrogram] dense lane fallback", { groupSize: v.groupSize });
        }
      }
      return result;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [detectionsVersion, dragOverride]);

    // ---- SVG box virtualization (Phase 2) ----------------------------------
    // Filter to detections whose time range intersects the visible window
    // (plus 1 viewport of padding on each side). Big perf win at zoom 4×/8×.
    const visibleBoxes = useMemo(() => {
      if (innerWidth === 0 || duration === 0) return renderedBoxes;
      const win = visibleTimeWindow(scrollLeft, viewportWidth, innerWidth, duration);
      return renderedBoxes.filter(
        (b) => b.endTime >= win.startTime && b.startTime <= win.endTime,
      );
    }, [renderedBoxes, scrollLeft, viewportWidth, innerWidth, duration]);

    return (
      <div ref={containerRef} className="relative flex w-full bg-zinc-950 select-none">
        {/* Pulse keyframes — scoped here to keep the animation co-located.
            A plain `<style>` element (no styled-jsx dependency) works on
            both the SSR and client passes; the keyframe is namespaced
            with the `fcat-spec-pulse` prefix to avoid collisions. */}
        <style
          dangerouslySetInnerHTML={{
            __html: `
              @keyframes fcat-spec-pulse {
                0% { opacity: 0.9; transform: scale(1); }
                60% { opacity: 0.5; transform: scale(1.06); }
                100% { opacity: 0; transform: scale(1.12); }
              }
              @media (prefers-reduced-motion: reduce) {
                .fcat-spec-pulse { animation: none !important; }
              }
            `,
          }}
        />

        {/* Hidden audio element */}
        <audio ref={audioRef} src={audioUrl} preload="auto" />

        {/* Left: frequency axis (stays outside the scrollable viewport so it
            remains fixed at the left edge regardless of horizontal scroll). */}
        <div style={{ width: FREQ_AXIS_WIDTH, height: specHeight }} className="shrink-0">
          <canvas ref={freqAxisRef} />
        </div>

        {/* Right: scroll viewport containing spec area + time axis */}
        <div
          ref={scrollViewportRef}
          className="flex-1 min-w-0 overflow-x-auto overflow-y-hidden"
          style={{ scrollBehavior: prefersReducedMotion() ? "auto" : "smooth" }}
        >
          <div
            className="relative"
            style={{ width: innerWidth || "100%", height: specHeight }}
          >
            <canvas
              ref={specCanvasRef}
              className="absolute inset-0"
              style={{ pointerEvents: "none", width: "100%", height: "100%" }}
            />

            {/* Loading / error overlay */}
            {(stage === "fetching" || stage === "computing") && (
              <div className="absolute inset-0 flex items-center justify-center bg-zinc-950/60 text-zinc-200 text-sm pointer-events-none">
                <Loader2 className="h-5 w-5 animate-spin mr-2" />
                <span>
                  {stage === "fetching" ? "Descargando audio…" : "Calculando espectrograma…"}
                </span>
              </div>
            )}
            {stage === "error" && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-950/80 text-sm gap-3">
                <p className="text-red-400 max-w-md text-center px-4">{error}</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setStage("idle");
                    setError(null);
                    setDecoded(null);
                    setMagnitudes(null);
                    setStage("fetching");
                    decodeAudio(audioUrl)
                      .then((d) => {
                        setDecoded(d);
                        onReady?.({ duration: d.duration, sampleRate: d.sampleRate });
                        setStage("computing");
                      })
                      .catch(() => {
                        setStage("error");
                        setError("Audio no se pudo decodificar. Intenta de nuevo o salta a otro archivo.");
                      });
                  }}
                >
                  Reintentar
                </Button>
              </div>
            )}

            {/* SVG overlay (boxes + drag preview) */}
            {stage === "ready" && innerWidth > 0 && (
              <svg
                id="fft-spec-svg"
                className={`absolute inset-0 w-full h-full ${
                  editable ? "cursor-crosshair" : "cursor-pointer"
                }`}
                viewBox="0 0 1 1"
                preserveAspectRatio="none"
                onPointerDown={handleSvgPointerDown}
                onPointerMove={handleSvgPointerMove}
                onPointerUp={handleSvgPointerUp}
                onPointerCancel={handleSvgPointerCancel}
                onClick={handleSvgClick}
              >
                {visibleBoxes.map((box) => {
                  const isSelected = selectedBoxId === box.id;
                  const isHovered = hoverBoxId === box.id && !isSelected;
                  const isLegacyFull =
                    box.minFreq === 0 && (box.maxFreq >= 15000 - 1 || box.maxFreq >= nyquist - 1);
                  const status = box.verificationStatus ?? "unverified";
                  const isVerified = status === "verified";
                  const isRejected = status === "rejected";
                  const color = getSpeciesColor(box.species);
                  const lane = lanes.get(box.id) ?? { mode: "full" as const };

                  const x = timeToNX(box.startTime);
                  const w = Math.max(0.0005, timeToNX(box.endTime) - x);

                  // Compute y/h based on lane assignment. `lanes` mode slices
                  // the box's freq range into vertical bands.
                  let yTop = hzToNY(box.maxFreq);
                  let yBot = hzToNY(box.minFreq);
                  if (lane.mode === "lanes") {
                    const fullSpan = yBot - yTop;
                    const laneSpan = fullSpan / lane.laneCount;
                    yTop = yTop + lane.laneIndex * laneSpan;
                    yBot = yTop + laneSpan;
                  }
                  const h = Math.max(0.0005, yBot - yTop);

                  const fillOpacity = isSelected
                    ? 0.3
                    : isRejected
                      ? 0.05
                      : isVerified
                        ? 0.28
                        : isLegacyFull && lane.mode === "full"
                          ? 0.1
                          : 0.15;
                  const strokeOpacity = isRejected
                    ? 0.35
                    : isLegacyFull && lane.mode === "full" && !isSelected
                      ? 0.6
                      : 1;

                  return (
                    <g
                      key={box.id}
                      data-box-id={box.id}
                      onPointerEnter={() => setHoverBoxId(box.id)}
                      onPointerLeave={() => setHoverBoxId(null)}
                      style={{ cursor: editable ? "grab" : "pointer" }}
                    >
                      <rect
                        x={x}
                        y={yTop}
                        width={w}
                        height={h}
                        fill={color}
                        fillOpacity={fillOpacity}
                        stroke={color}
                        strokeOpacity={strokeOpacity}
                        strokeWidth={isSelected ? 2.5 : isHovered ? 2 : 1.5}
                        strokeDasharray={isLegacyFull && lane.mode === "full" ? "4 3" : undefined}
                        vectorEffect="non-scaling-stroke"
                      />

                      {isSelected && pulseKey > 0 && (
                        <rect
                          key={`pulse-${pulseKey}-${box.id}`}
                          className="fcat-spec-pulse"
                          x={x}
                          y={yTop}
                          width={w}
                          height={h}
                          fill="none"
                          stroke={color}
                          strokeWidth={3}
                          vectorEffect="non-scaling-stroke"
                          pointerEvents="none"
                          style={{
                            transformOrigin: `${(x + w / 2) * 100}% ${(yTop + h / 2) * 100}%`,
                            transformBox: "fill-box",
                            animation: prefersReducedMotion()
                              ? "none"
                              : "fcat-spec-pulse 500ms ease-out forwards",
                          }}
                        />
                      )}

                      {isSelected && editable && (
                        <ResizeHandles
                          x={x}
                          y={yTop}
                          w={w}
                          h={h}
                          boxId={box.id}
                          specWidthPx={specSize.width}
                          specHeightPx={specSize.height}
                        />
                      )}
                    </g>
                  );
                })}

                {/* Live preview rect during draw-new */}
                {previewRect && (
                  <rect
                    x={timeToNX(previewRect.startTime)}
                    y={hzToNY(previewRect.maxFreq)}
                    width={timeToNX(previewRect.endTime) - timeToNX(previewRect.startTime)}
                    height={hzToNY(previewRect.minFreq) - hzToNY(previewRect.maxFreq)}
                    fill="rgba(34, 197, 94, 0.2)"
                    stroke="rgba(34, 197, 94, 0.9)"
                    strokeWidth={1.5}
                    strokeDasharray="4 3"
                    vectorEffect="non-scaling-stroke"
                    pointerEvents="none"
                  />
                )}
              </svg>
            )}

            {/* Box labels — HTML overlay. Switches between collapsed letter
                chips (low effective width) and full-name pills (high zoom or
                selected) via `decideLabelCollapse`. */}
            {stage === "ready" && innerWidth > 0 && (
              <div className="absolute inset-0 pointer-events-none">
                {visibleBoxes.map((box) => {
                  if (!box.displayLabel) return null;
                  const status = box.verificationStatus ?? "unverified";
                  const isSelected = selectedBoxId === box.id;
                  if (status === "rejected" && !isSelected) return null;
                  const color = getSpeciesColor(box.species);
                  const lane = lanes.get(box.id) ?? { mode: "full" as const };

                  const xPx = timeToNX(box.startTime) * innerWidth;
                  let yTopPx = hzToNY(box.maxFreq) * specHeight;
                  if (lane.mode === "lanes") {
                    const fullSpan = hzToNY(box.minFreq) * specHeight - yTopPx;
                    yTopPx = yTopPx + lane.laneIndex * (fullSpan / lane.laneCount);
                  }
                  const wPx = Math.max(0, timeToNX(box.endTime) * innerWidth - xPx);
                  // Use base (zoom=1) width to decide collapse so the
                  // threshold tracks effective rendered width.
                  const baseWPx = wPx / zoomLevel;
                  const collapseMode = decideLabelCollapse(baseWPx, zoomLevel, isSelected);
                  const labelAbove = yTopPx >= 18;
                  const top = labelAbove ? Math.max(0, yTopPx - 18) : yTopPx;

                  const tooltip = `${box.displayLabel} · ${box.startTime.toFixed(1)}s–${box.endTime.toFixed(1)}s · ${(box.minFreq / 1000).toFixed(1)}–${(box.maxFreq / 1000).toFixed(1)} kHz`;

                  if (collapseMode === "collapsed") {
                    return (
                      <div
                        key={box.id}
                        aria-label={box.displayLabel}
                        title={tooltip}
                        className="absolute font-semibold flex items-center justify-center"
                        style={{
                          left: xPx,
                          top,
                          width: 14,
                          height: 14,
                          background: color,
                          color: "white",
                          fontSize: 10,
                          borderRadius: 3,
                          opacity: 0.95,
                          zIndex: isSelected ? 2 : 1,
                        }}
                      >
                        {speciesInitial(box.displayLabel)}
                      </div>
                    );
                  }

                  const expandedMax = innerWidth - xPx;
                  const maxWidth = Math.min(
                    isSelected ? expandedMax : Math.max(wPx + 4, 70),
                    expandedMax,
                  );
                  return (
                    <div
                      key={box.id}
                      className="absolute font-semibold leading-none whitespace-nowrap overflow-hidden text-ellipsis"
                      style={{
                        left: xPx,
                        top,
                        maxWidth,
                        height: 18,
                        lineHeight: "18px",
                        background: color,
                        color: "white",
                        fontSize: 11,
                        padding: "0 6px",
                        borderRadius: 3,
                        opacity: 0.92,
                        zIndex: isSelected ? 2 : 1,
                        transition: "max-width 180ms ease",
                      }}
                      title={tooltip}
                    >
                      {box.displayLabel}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Playhead */}
            <div
              ref={playheadRef}
              className="absolute top-0 bottom-0 pointer-events-none"
              style={{
                width: 2,
                marginLeft: -1,
                background: "rgba(255,255,255,0.85)",
                boxShadow: "0 0 4px rgba(0,0,0,0.6)",
                transform: "translateX(0)",
              }}
            />
          </div>

          {/* Time axis (inside the scroll viewport so it widens with zoom) */}
          <canvas
            ref={timeAxisRef}
            onClick={handleTimeAxisClick}
            className="cursor-pointer block"
          />
        </div>
      </div>
    );
  }
);

// ---- Helpers ---------------------------------------------------------------

function applyResize(
  original: AudioBoxData,
  handle: ResizeHandle,
  newTime: number,
  newHz: number,
  duration: number,
  nyquist: number
): BoxRect {
  let { startTime, endTime, minFreq, maxFreq } = original;
  const minDt = 0.05;
  const minDf = 50;

  if (handle.includes("w")) {
    startTime = clamp(newTime, 0, endTime - minDt);
  }
  if (handle.includes("e")) {
    endTime = clamp(newTime, startTime + minDt, duration);
  }
  if (handle.includes("n")) {
    maxFreq = clamp(newHz, minFreq + minDf, nyquist);
  }
  if (handle.includes("s")) {
    minFreq = clamp(newHz, 0, maxFreq - minDf);
  }
  return { startTime, endTime, minFreq, maxFreq };
}

interface ResizeHandlesProps {
  x: number;
  y: number;
  w: number;
  h: number;
  boxId: number;
  specWidthPx: number;
  specHeightPx: number;
}

const HANDLE_DEFS: Array<{ name: ResizeHandle; nx: 0 | 0.5 | 1; ny: 0 | 0.5 | 1; cursor: string }> = [
  { name: "nw", nx: 0, ny: 0, cursor: "nwse-resize" },
  { name: "n", nx: 0.5, ny: 0, cursor: "ns-resize" },
  { name: "ne", nx: 1, ny: 0, cursor: "nesw-resize" },
  { name: "e", nx: 1, ny: 0.5, cursor: "ew-resize" },
  { name: "se", nx: 1, ny: 1, cursor: "nwse-resize" },
  { name: "s", nx: 0.5, ny: 1, cursor: "ns-resize" },
  { name: "sw", nx: 0, ny: 1, cursor: "nesw-resize" },
  { name: "w", nx: 0, ny: 0.5, cursor: "ew-resize" },
];

function ResizeHandles({ x, y, w, h, boxId, specWidthPx, specHeightPx }: ResizeHandlesProps) {
  const halfW = HANDLE_PX / 2 / specWidthPx;
  const halfH = HANDLE_PX / 2 / specHeightPx;
  const hitHalfW = HANDLE_HIT_PX / 2 / specWidthPx;
  const hitHalfH = HANDLE_HIT_PX / 2 / specHeightPx;

  return (
    <g>
      {HANDLE_DEFS.map((d) => {
        const cx = x + w * d.nx;
        const cy = y + h * d.ny;
        return (
          <g key={d.name} style={{ cursor: d.cursor }}>
            <rect
              x={cx - hitHalfW}
              y={cy - hitHalfH}
              width={hitHalfW * 2}
              height={hitHalfH * 2}
              fill="transparent"
              data-handle={d.name}
              data-box-id={boxId}
            />
            <rect
              x={cx - halfW}
              y={cy - halfH}
              width={halfW * 2}
              height={halfH * 2}
              fill="white"
              stroke="rgba(0,0,0,0.6)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          </g>
        );
      })}
    </g>
  );
}

// Re-export the LaneAssignment type so consumers don't need to dive into
// `spectrogram-layout` for it.
export type { LaneAssignment };
