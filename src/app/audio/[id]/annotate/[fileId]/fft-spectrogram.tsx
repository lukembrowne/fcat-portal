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
  type ZoomLevel,
  stepZoom,
  viewportToTime,
  timeToScrollOffset,
  withinViewportTailZone,
  visibleTimeWindow,
  decideLabelCollapse,
  speciesInitial,
  assignLabelLanes,
} from "@/lib/spectrogram-layout";
import { Button } from "@/components/ui/button";

const DRAG_THRESHOLD_PX = 5;
const MIN_BOX_PX = 10;
const HANDLE_PX = 8;
const HANDLE_HIT_PX = 18;
const TIME_TICK_STEPS = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
const FREQ_TICK_STEPS = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const LABEL_ROW_HEIGHT = 18;
const LABEL_ROW_GAP = 2;
const TIME_OVERLAY_HEIGHT = 18;
const MAX_LABEL_LANES = 4;

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
    }
  | {
      kind: "panning";
      startClientX: number;
      startScrollLeft: number;
      hasDragged: boolean;
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
}

export interface SpecMeasurement {
  /** Width of the scroll-viewport (excluding freq-axis gutter). */
  viewportWidth: number;
  /** Total inner-container width = baseWidth × zoomLevel. */
  scrollWidth: number;
  /** Current spec-area pixel height (dynamic, fills the parent flex slot). */
  specHeight: number;
}

interface FftSpectrogramProps {
  audioUrl: string;
  boxes: AudioBoxData[];
  selectedBoxId: number | null;
  /** Externally-driven hover (e.g. sidebar card hover). OR-ed with the
   *  spec's own internal SVG hover state when computing `isHovered`. */
  hoveredBoxId?: number | null;
  editable: boolean;
  displayMaxHz: number;
  gainDB: number;
  rangeDB: number;
  fftSize: number;
  colormap: ColormapName;
  /** Discrete time-axis zoom; 1× = base width, 8× = inner is 8× viewport. */
  zoomLevel?: ZoomLevel;
  /** When true, the viewport auto-scrolls to keep the playhead visible
   *  during playback. User-initiated scroll temporarily pauses follow until
   *  the next seek / playSelection. */
  followPlayback?: boolean;
  /** Monotonic counter; increment in the parent whenever the detection set
   *  mutates so derived memoised state can invalidate without taking a
   *  dependency on the `boxes` array reference (which can change every
   *  render). */
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
  /** Fires when the spectrogram itself wants to step the zoom (wheel
   *  gesture). Parent updates the settings; the spectrogram applies a
   *  pending cursor anchor in an effect on `zoomLevel`. */
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
      hoveredBoxId,
      editable,
      displayMaxHz,
      gainDB,
      rangeDB,
      fftSize,
      colormap,
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

    const containerRef = useRef<HTMLDivElement>(null);
    const scrollViewportRef = useRef<HTMLDivElement>(null);
    const specCanvasRef = useRef<HTMLCanvasElement>(null);
    const freqAxisRef = useRef<HTMLCanvasElement>(null);
    const playheadRef = useRef<HTMLDivElement>(null);
    const audioRef = useRef<HTMLAudioElement>(null);
    const offscreenRef = useRef<HTMLCanvasElement | null>(null);
    const rafRef = useRef<number | null>(null);
    const selectionStartRef = useRef<number | null>(null);
    const selectionEndRef = useRef<number | null>(null);
    const loopRef = useRef(false);
    const suppressNextClickRef = useRef(false);

    // Ref counter (not boolean) — robust against overlapping programmatic
    // scrolls (e.g. card-click during a smooth scroll).
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
    // Dynamic spec area height: tracked from the scroll viewport's actual
    // `clientHeight`. The component fills whatever vertical space its parent
    // gives it; no preset toggle.
    const [specHeight, setSpecHeight] = useState(0);
    const [scrollLeft, setScrollLeft] = useState(0);
    const [hoverBoxId, setHoverBoxId] = useState<number | null>(null);
    const [previewRect, setPreviewRect] = useState<BoxRect | null>(null);
    const [dragOverride, setDragOverride] = useState<{ boxId: number; rect: BoxRect } | null>(null);
    const [isPanning, setIsPanning] = useState(false);
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
    // The spec canvas's bitmap is sized to the *inner* width (DPR-scaled).
    // We CSS-stretch via `width: 100%`. Beyond ~4× this loses pixel fidelity;
    // documented tradeoff.
    useEffect(() => {
      if (!magnitudes || !specCanvasRef.current || specSize.width === 0 || specSize.height === 0)
        return;

      // Size the canvas immediately before drawing. The ResizeObserver effect
      // (below) only updates state; centralising the sizing here avoids a
      // declaration-order race where the render effect drew onto a stale
      // bitmap and the ResizeObserver effect then cleared it.
      sizeCanvas(specCanvasRef.current, specSize.width, specSize.height);

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
      if (!canvas || specHeight === 0) return;
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

    // ---- Resize observer ----------------------------------------------------
    // Watches the scroll viewport for both its `clientWidth` AND
    // `clientHeight`. Both flow into state so the render-to-canvas effect
    // re-fires on either dimension change. Fixes the "must refresh to see
    // the spectrogram after height changes" bug from the prior shipping.
    useEffect(() => {
      const viewport = scrollViewportRef.current;
      if (!viewport) return;

      const apply = () => {
        const cssW = Math.max(0, viewport.clientWidth);
        const cssH = Math.max(0, viewport.clientHeight);
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

        // Canvas sizing happens inside the render-to-spec-canvas effect so
        // the bitmap is always sized just before drawImage runs. This effect
        // only owns state updates + scroll-restore.
        setViewportWidth(cssW);
        setSpecHeight(cssH);

        if (duration > 0 && prevInner > 0 && newInner > 0 && cssW !== prevViewport) {
          // Only restore scroll if the viewport WIDTH changed — vertical-only
          // resize shouldn't trigger a scroll snap.
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
      // Re-measure on the next frame so any post-commit layout settling is
      // picked up. Zoom-down (e.g. 8× → 1×) triggered a stale `clientWidth`
      // read because the inner div had just shrunk and the browser had not
      // finalized scrollbar / overflow state yet. This catches it without
      // forcing a `useLayoutEffect`.
      const rafId = requestAnimationFrame(apply);

      const ro = new ResizeObserver(apply);
      ro.observe(viewport);
      return () => {
        cancelAnimationFrame(rafId);
        ro.disconnect();
      };
    }, [zoomLevel, duration]);

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

    // ---- Surface measurements to parent ------------------------------------
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

    // ---- Internal scroll-to helper -----------------------------------------
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

    // Scrolls to `time` only when it's outside the literal visible window
    // (with a small leading-edge margin). Used by keyboard skip and any
    // imperative seek so the playhead stays in view after a jump.
    const ensurePlayheadVisible = useCallback(
      (time: number) => {
        const v = scrollViewportRef.current;
        if (!v || duration <= 0) return;
        if (v.scrollWidth <= v.clientWidth) return;
        // padViewports=0 → actual visible window, no virtualization padding.
        const win = visibleTimeWindow(
          v.scrollLeft,
          v.clientWidth,
          v.scrollWidth,
          duration,
          0,
        );
        const margin = 0.05 * (win.endTime - win.startTime);
        if (time >= win.startTime + margin && time <= win.endTime - margin) {
          return;
        }
        scrollToTimeInternal(time);
      },
      [duration, scrollToTimeInternal],
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
          const newTime = clamp(time, 0, a.duration || 0);
          a.currentTime = newTime;
          ensurePlayheadVisible(newTime);
        },
        skip: (seconds: number) => {
          const a = audioRef.current;
          if (!a) return;
          loopRef.current = false;
          selectionEndRef.current = null;
          selectionStartRef.current = null;
          const newTime = clamp((a.currentTime || 0) + seconds, 0, a.duration || 0);
          a.currentTime = newTime;
          ensurePlayheadVisible(newTime);
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
      }),
      [scrollToTimeInternal, ensurePlayheadVisible],
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
    // Precedence (top to bottom; first match wins):
    //   1. resize handle → "resizing"
    //   2. existing box → "moving"
    //   3. Shift held + editable + onDrawComplete provided → "drawing-new"
    //   4. empty area → "panning"
    const handleSvgPointerDown = useCallback(
      (e: React.PointerEvent<SVGSVGElement>) => {
        const target = e.target as SVGElement;
        const handleEl = editable ? target.closest("[data-handle]") : null;
        const boxEl = target.closest("[data-box-id]");
        const { nx, ny } = eventToNorm(e.clientX, e.clientY);

        if (handleEl && editable) {
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

        if (e.shiftKey && editable && onDrawCompleteRef.current) {
          dragRef.current = {
            kind: "drawing-new",
            startNX: nx,
            startNY: ny,
            currentNX: nx,
            currentNY: ny,
            hasDragged: false,
          };
          (e.target as Element).setPointerCapture(e.pointerId);
          return;
        }

        // Default: pan the viewport.
        const v = scrollViewportRef.current;
        dragRef.current = {
          kind: "panning",
          startClientX: e.clientX,
          startScrollLeft: v?.scrollLeft ?? 0,
          hasDragged: false,
        };
        (e.target as Element).setPointerCapture(e.pointerId);
      },
      [editable, boxes, eventToNorm]
    );

    const handleSvgPointerMove = useCallback(
      (e: React.PointerEvent<SVGSVGElement>) => {
        const drag = dragRef.current;
        if (drag.kind === "idle") return;

        if (drag.kind === "panning") {
          const dx = e.clientX - drag.startClientX;
          if (!drag.hasDragged && Math.abs(dx) > DRAG_THRESHOLD_PX) {
            drag.hasDragged = true;
            setIsPanning(true);
          }
          if (drag.hasDragged) {
            const v = scrollViewportRef.current;
            if (v) {
              // Don't bump programmaticScrollDepth — user-driven pan SHOULD
              // pause follow-mode (handled by the existing scroll listener
              // when depth === 0).
              v.scrollLeft = drag.startScrollLeft - dx;
            }
          }
          return;
        }

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

        if (drag.kind === "panning") {
          setIsPanning(false);
          if (!drag.hasDragged) {
            // No drag — this gesture was a click. Seek playback to the
            // clicked position. Handled inline here (not via a separate
            // `click` event) because `setPointerCapture` makes click-event
            // delivery to the SVG unreliable on some browsers.
            const a = audioRef.current;
            if (a) {
              const { nx } = eventToNorm(e.clientX, e.clientY);
              loopRef.current = false;
              selectionEndRef.current = null;
              selectionStartRef.current = null;
              a.currentTime = clamp(nxToTime(nx), 0, duration);
            }
          }
          // Suppress the follow-up `click` event so it doesn't double-seek
          // (drag case) or re-seek with stale state (no-drag case).
          suppressNextClickRef.current = true;
          return;
        }

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
      [dragOverride, specSize.width, specSize.height, nxToTime, nyToHz, eventToNorm, duration]
    );

    const handleSvgPointerCancel = useCallback(() => {
      dragRef.current = { kind: "idle" };
      setPreviewRect(null);
      setDragOverride(null);
      setIsPanning(false);
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

    // Click on a time-overlay label seeks to that time.
    const handleTimeOverlayClick = useCallback(
      (t: number) => {
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

    // ---- SVG box virtualization --------------------------------------------
    // Filter to detections whose time range intersects the visible window
    // (plus 1 viewport of padding on each side). Big perf win at zoom 4×/8×.
    const visibleBoxes = useMemo(() => {
      if (innerWidth === 0 || duration === 0) return renderedBoxes;
      const win = visibleTimeWindow(scrollLeft, viewportWidth, innerWidth, duration);
      return renderedBoxes.filter(
        (b) => b.endTime >= win.startTime && b.startTime <= win.endTime,
      );
    }, [renderedBoxes, scrollLeft, viewportWidth, innerWidth, duration]);

    // ---- Label lane assignment ---------------------------------------------
    // Stagger label rows vertically so overlapping labels stay readable.
    // Memoised on `detectionsVersion` (counter) PLUS the scroll/zoom-dependent
    // visible box set, since label widths depend on `wPx` which depends on
    // zoom + visible window. (No collapsing for the lane decision — we use a
    // simple estimated label width per the spec plan.)
    const labelLanes = useMemo(() => {
      if (innerWidth === 0) return new Map<number, number>();
      const intervals = visibleBoxes
        .filter((b) => b.displayLabel)
        .map((b) => {
          const xPx = timeToNX(b.startTime) * innerWidth;
          const wPx = Math.max(0, timeToNX(b.endTime) * innerWidth - xPx);
          const baseWPx = wPx / zoomLevel;
          const isSelected = selectedBoxId === b.id;
          const collapseMode = decideLabelCollapse(baseWPx, zoomLevel, isSelected);
          // Estimated label width for collision purposes. Caps at 160 px so
          // one huge label doesn't push everything down.
          const labelWidthPx =
            collapseMode === "collapsed"
              ? 18
              : Math.min(160, Math.max(70, wPx + 4));
          return { id: b.id, leftPx: xPx, rightPx: xPx + labelWidthPx };
        });
      return assignLabelLanes(intervals);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [detectionsVersion, visibleBoxes, innerWidth, zoomLevel, selectedBoxId]);

    // ---- Time-axis ticks for the top overlay -------------------------------
    const timeTicks = useMemo<number[]>(() => {
      if (innerWidth === 0 || duration === 0) return [];
      const secPerPx = duration / innerWidth;
      const step = pickTickStep(secPerPx, 80, TIME_TICK_STEPS);
      const ticks: number[] = [];
      for (let t = step; t <= duration - step / 2; t += step) {
        ticks.push(t);
      }
      return ticks;
    }, [duration, innerWidth]);

    // ---- Render -------------------------------------------------------------
    const showLeftFade = zoomLevel > 1 && scrollLeft > 4;
    const showRightFade =
      zoomLevel > 1 && innerWidth - scrollLeft - viewportWidth > 4;

    // Cursor over empty area advertises the pan gesture.
    const svgCursor = isPanning
      ? "grabbing"
      : editable
        ? "grab"
        : "grab";

    return (
      <div ref={containerRef} className="relative flex w-full h-full bg-zinc-950 select-none">
        {/* Spectrogram-scoped styles: pulse keyframes + visible-scrollbar
            theming. Plain <style> (no styled-jsx) so it works on SSR + client. */}
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
              .fcat-spec-scrollbar::-webkit-scrollbar {
                height: 12px;
              }
              .fcat-spec-scrollbar::-webkit-scrollbar-track {
                background: rgba(255,255,255,0.04);
              }
              .fcat-spec-scrollbar::-webkit-scrollbar-thumb {
                background: rgba(255,255,255,0.35);
                border-radius: 6px;
              }
              .fcat-spec-scrollbar::-webkit-scrollbar-thumb:hover {
                background: rgba(255,255,255,0.55);
              }
              .fcat-spec-scrollbar {
                scrollbar-width: thin;
                scrollbar-color: rgba(255,255,255,0.35) rgba(255,255,255,0.04);
              }
            `,
          }}
        />

        {/* Hidden audio element */}
        <audio ref={audioRef} src={audioUrl} preload="auto" />

        {/* Left: frequency axis (stays outside the scrollable viewport so it
            remains fixed at the left edge regardless of horizontal scroll). */}
        <div style={{ width: FREQ_AXIS_WIDTH }} className="shrink-0 h-full">
          <canvas ref={freqAxisRef} />
        </div>

        {/* Right: scroll viewport containing the spec body */}
        <div className="relative flex-1 min-w-0 h-full">
          <div
            ref={scrollViewportRef}
            className="fcat-spec-scrollbar h-full overflow-x-auto overflow-y-hidden"
          >
            <div
              className="relative h-full"
              style={{ width: innerWidth || "100%" }}
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

              {/* SVG overlay (boxes + drag preview + time guide lines) */}
              {stage === "ready" && innerWidth > 0 && specHeight > 0 && (
                <svg
                  id="fft-spec-svg"
                  className="absolute inset-0 w-full h-full"
                  style={{ cursor: svgCursor }}
                  viewBox="0 0 1 1"
                  preserveAspectRatio="none"
                  onPointerDown={handleSvgPointerDown}
                  onPointerMove={handleSvgPointerMove}
                  onPointerUp={handleSvgPointerUp}
                  onPointerCancel={handleSvgPointerCancel}
                  onClick={handleSvgClick}
                >
                  {/* Vertical time guide lines at each major tick. Drawn first
                      so detection boxes/labels render on top. Stacked pair
                      (dark underlay + bright top) gives high-contrast
                      legibility against any colormap. */}
                  {timeTicks.map((t) => {
                    const x = timeToNX(t);
                    return (
                      <g key={`tick-${t}`} pointerEvents="none">
                        <line
                          x1={x}
                          x2={x}
                          y1={0}
                          y2={1}
                          stroke="rgba(0,0,0,0.55)"
                          strokeWidth={2}
                          strokeDasharray="3 5"
                          vectorEffect="non-scaling-stroke"
                        />
                        <line
                          x1={x}
                          x2={x}
                          y1={0}
                          y2={1}
                          stroke="rgba(255,255,255,0.7)"
                          strokeWidth={1}
                          strokeDasharray="3 5"
                          vectorEffect="non-scaling-stroke"
                        />
                      </g>
                    );
                  })}

                  {visibleBoxes.map((box) => {
                    const isSelected = selectedBoxId === box.id;
                    // OR external sidebar-hover into the internal SVG-hover
                    // signal. Either source highlights the same box.
                    const isHovered =
                      (hoverBoxId === box.id || hoveredBoxId === box.id) &&
                      !isSelected;
                    const isLegacyFull =
                      box.minFreq === 0 && (box.maxFreq >= 15000 - 1 || box.maxFreq >= nyquist - 1);
                    const status = box.verificationStatus ?? "unverified";
                    const isVerified = status === "verified";
                    const isRejected = status === "rejected";
                    const color = getSpeciesColor(box.species);

                    const x = timeToNX(box.startTime);
                    const w = Math.max(0.0005, timeToNX(box.endTime) - x);
                    const yTop = hzToNY(box.maxFreq);
                    const yBot = hzToNY(box.minFreq);
                    const h = Math.max(0.0005, yBot - yTop);

                    // Halo offsets in normalised viewBox space. Pixel
                    // offsets converted via current specSize so the halo
                    // sits a consistent ~6 px outside the box at any zoom.
                    const haloX = specSize.width > 0 ? 6 / specSize.width : 0;
                    const haloY = specSize.height > 0 ? 6 / specSize.height : 0;

                    const fillOpacity = isSelected
                      ? 0.42
                      : isRejected
                        ? 0.05
                        : isVerified
                          ? 0.28
                          : isLegacyFull
                            ? 0.1
                            : 0.15;
                    const strokeOpacity = isRejected
                      ? 0.35
                      : isLegacyFull && !isSelected
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
                        {/* Hover halo: dashed outline around the box, drawn
                            below the main rect so the box's own stroke and
                            fill remain primary. */}
                        {isHovered && (
                          <rect
                            x={Math.max(0, x - haloX)}
                            y={Math.max(0, yTop - haloY)}
                            width={Math.min(1, w + haloX * 2)}
                            height={Math.min(1, h + haloY * 2)}
                            fill="none"
                            stroke={color}
                            strokeOpacity={0.6}
                            strokeWidth={2}
                            strokeDasharray="4 3"
                            vectorEffect="non-scaling-stroke"
                            pointerEvents="none"
                          />
                        )}
                        {/* Selected halo: solid colour ring around the box,
                            visible even without the pulse animation. */}
                        {isSelected && (
                          <rect
                            x={Math.max(0, x - haloX)}
                            y={Math.max(0, yTop - haloY)}
                            width={Math.min(1, w + haloX * 2)}
                            height={Math.min(1, h + haloY * 2)}
                            fill="none"
                            stroke={color}
                            strokeOpacity={0.55}
                            strokeWidth={3}
                            vectorEffect="non-scaling-stroke"
                            pointerEvents="none"
                          />
                        )}
                        <rect
                          x={x}
                          y={yTop}
                          width={w}
                          height={h}
                          fill={color}
                          fillOpacity={fillOpacity}
                          stroke={color}
                          strokeOpacity={strokeOpacity}
                          strokeWidth={isSelected ? 3 : isHovered ? 2 : 1.5}
                          strokeDasharray={isLegacyFull ? "4 3" : undefined}
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

              {/* Top time-label overlay — sits inside the scrolling inner
                  container so labels scroll with the data. Click a label
                  to seek to that time. */}
              {stage === "ready" && innerWidth > 0 && duration > 0 && (
                <div
                  className="absolute top-0 left-0 right-0 pointer-events-none"
                  style={{
                    height: TIME_OVERLAY_HEIGHT,
                    background: "rgba(10,10,10,0.55)",
                  }}
                >
                  {timeTicks.map((t) => (
                    <div
                      key={`label-${t}`}
                      onClick={() => handleTimeOverlayClick(t)}
                      className="absolute text-[10px] leading-none text-zinc-200 cursor-pointer pointer-events-auto px-1"
                      style={{
                        left: (t / duration) * innerWidth,
                        top: 3,
                        transform: "translateX(-50%)",
                      }}
                    >
                      {formatSeconds(t)}
                    </div>
                  ))}
                </div>
              )}

              {/* Box labels — HTML overlay. Switches between collapsed letter
                  chips (low effective width) and full-name pills (high zoom or
                  selected) via `decideLabelCollapse`. Vertically staggered
                  via `assignLabelLanes` so overlapping labels stay readable. */}
              {stage === "ready" && innerWidth > 0 && specHeight > 0 && (
                <div className="absolute inset-0 pointer-events-none">
                  {visibleBoxes.map((box) => {
                    if (!box.displayLabel) return null;
                    const status = box.verificationStatus ?? "unverified";
                    const isSelected = selectedBoxId === box.id;
                    if (status === "rejected" && !isSelected) return null;
                    const color = getSpeciesColor(box.species);

                    const xPx = timeToNX(box.startTime) * innerWidth;
                    const yTopPx = hzToNY(box.maxFreq) * specHeight;
                    const yBotPx = hzToNY(box.minFreq) * specHeight;
                    const wPx = Math.max(0, timeToNX(box.endTime) * innerWidth - xPx);
                    const baseWPx = wPx / zoomLevel;
                    const collapseMode = decideLabelCollapse(baseWPx, zoomLevel, isSelected);

                    // Lane stagger: stack labels above the box top edge,
                    // moving downward by `(LABEL_ROW_HEIGHT + GAP) * lane`.
                    // Capped at MAX_LABEL_LANES so far-out lanes fall back
                    // to the natural row with reduced opacity.
                    const rawLane = labelLanes.get(box.id) ?? 0;
                    const lane = Math.min(rawLane, MAX_LABEL_LANES);
                    const isOverflowLane = rawLane > MAX_LABEL_LANES;
                    const offsetDown = lane * (LABEL_ROW_HEIGHT + LABEL_ROW_GAP);
                    // Default to above-the-box. If there isn't enough room
                    // above, anchor below the bottom edge instead.
                    const baseAbove = yTopPx - LABEL_ROW_HEIGHT;
                    const labelAbove = baseAbove - offsetDown >= TIME_OVERLAY_HEIGHT;
                    const top = labelAbove
                      ? baseAbove - offsetDown
                      : Math.min(yBotPx + offsetDown, specHeight - LABEL_ROW_HEIGHT);

                    const opacity = isOverflowLane ? 0.6 : isSelected ? 1 : 0.95;
                    const tooltip = `${box.displayLabel} · ${box.startTime.toFixed(1)}s–${box.endTime.toFixed(1)}s · ${(box.minFreq / 1000).toFixed(1)}–${(box.maxFreq / 1000).toFixed(1)} kHz`;

                    // Labels are interactive (clicking selects the box).
                    // `pointer-events: auto` overrides the container's
                    // `pointer-events-none`; stopPropagation on pointerdown
                    // prevents the SVG underneath from starting a pan or
                    // draw gesture on the same press.
                    const stopPropagationDown = (e: React.PointerEvent) => {
                      e.stopPropagation();
                    };
                    const selectOnClick = (e: React.MouseEvent) => {
                      e.stopPropagation();
                      onBoxClickRef.current?.(box);
                    };

                    if (collapseMode === "collapsed") {
                      return (
                        <div
                          key={box.id}
                          aria-label={box.displayLabel}
                          title={tooltip}
                          onClick={selectOnClick}
                          onPointerDown={stopPropagationDown}
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
                            opacity,
                            zIndex: isSelected ? 2 : 1,
                            pointerEvents: "auto",
                            cursor: "pointer",
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
                        onClick={selectOnClick}
                        onPointerDown={stopPropagationDown}
                        style={{
                          left: xPx,
                          top,
                          maxWidth,
                          height: LABEL_ROW_HEIGHT,
                          lineHeight: `${LABEL_ROW_HEIGHT}px`,
                          background: color,
                          color: "white",
                          fontSize: 11,
                          padding: "0 6px",
                          borderRadius: 3,
                          opacity,
                          zIndex: isSelected ? 2 : 1,
                          transition: "max-width 180ms ease",
                          pointerEvents: "auto",
                          cursor: "pointer",
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
          </div>

          {/* Edge fade gradients — purely visual hint that there's more
              content beyond the viewport. Outside the scroll viewport so
              they stay anchored to the visible edges, not scrolled. */}
          {showLeftFade && (
            <div
              className="absolute top-0 bottom-0 left-0 w-8 pointer-events-none"
              style={{
                background:
                  "linear-gradient(to right, rgba(0,0,0,0.55), transparent)",
              }}
            />
          )}
          {showRightFade && (
            <div
              className="absolute top-0 bottom-0 right-0 w-8 pointer-events-none"
              style={{
                background:
                  "linear-gradient(to left, rgba(0,0,0,0.55), transparent)",
              }}
            />
          )}
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
