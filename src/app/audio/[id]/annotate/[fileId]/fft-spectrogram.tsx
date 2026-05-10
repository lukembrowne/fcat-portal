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
import { Button } from "@/components/ui/button";

const FREQ_AXIS_WIDTH = 70;
const TIME_AXIS_HEIGHT = 24;
const SPEC_HEIGHT = 256;
const DRAG_THRESHOLD_PX = 5;
const MIN_BOX_PX = 10;
const HANDLE_PX = 8;
const HANDLE_HIT_PX = 18;
const TIME_TICK_STEPS = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
const FREQ_TICK_STEPS = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

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
  onBoxClick?: (box: AudioBoxData) => void;
  onDrawComplete?: (box: BoxRect) => void;
  onBoxResized?: (boxId: number, box: BoxRect) => void;
  onReady?: (meta: { duration: number; sampleRate: number }) => void;
  onTimeUpdate?: (currentTime: number) => void;
  onPlayPause?: (playing: boolean) => void;
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
      onBoxClick,
      onDrawComplete,
      onBoxResized,
      onReady,
      onTimeUpdate,
      onPlayPause,
    } = props;

    const containerRef = useRef<HTMLDivElement>(null);
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

    const [stage, setStage] = useState<LoadStage>("idle");
    const [error, setError] = useState<string | null>(null);
    const [decoded, setDecoded] = useState<DecodedAudio | null>(null);
    const [magnitudes, setMagnitudes] = useState<Magnitudes | null>(null);
    const [specSize, setSpecSize] = useState({ width: 0, height: SPEC_HEIGHT });
    const [hoverBoxId, setHoverBoxId] = useState<number | null>(null);
    const [previewRect, setPreviewRect] = useState<BoxRect | null>(null);
    const [dragOverride, setDragOverride] = useState<{ boxId: number; rect: BoxRect } | null>(null);
    const dragRef = useRef<DragState>({ kind: "idle" });

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
      // Reset upfront so users don't see the previous file's spectrogram
      // while the new one loads. The React 19 rule against setState-in-effect
      // is overly cautious for this common async-loading pattern.
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
      // stage was already set to "computing" by the decode .then()

      // Defer to the next tick so the spinner can render.
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
      // Own the sizing here so the bitmap and DPR transform are fresh on every
      // run — including the post-mount run after the resize observer first
      // publishes a non-zero specSize.
      sizeCanvas(canvas, FREQ_AXIS_WIDTH, SPEC_HEIGHT);
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, FREQ_AXIS_WIDTH, SPEC_HEIGHT);
      ctx.fillStyle = "#0a0a0a";
      ctx.fillRect(0, 0, FREQ_AXIS_WIDTH, SPEC_HEIGHT);
      ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle = "#d4d4d8";
      ctx.strokeStyle = "#3f3f46";
      ctx.lineWidth = 1;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";

      const hzPerPx = displayMaxHz / SPEC_HEIGHT;
      const step = pickTickStep(hzPerPx, 36, FREQ_TICK_STEPS);
      const firstTick = 0;
      for (let hz = firstTick; hz <= displayMaxHz + 0.001; hz += step) {
        const y = SPEC_HEIGHT - (hz / displayMaxHz) * SPEC_HEIGHT;
        if (y < 8 || y > SPEC_HEIGHT - 4) continue;
        ctx.beginPath();
        ctx.moveTo(FREQ_AXIS_WIDTH - 4, y);
        ctx.lineTo(FREQ_AXIS_WIDTH, y);
        ctx.stroke();
        ctx.fillText(formatHz(hz), FREQ_AXIS_WIDTH - 6, y);
      }
    }, [displayMaxHz, specSize.height]);

    // ---- Time axis ----------------------------------------------------------
    useEffect(() => {
      const canvas = timeAxisRef.current;
      if (!canvas || specSize.width === 0 || duration === 0) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, specSize.width, TIME_AXIS_HEIGHT);
      ctx.fillStyle = "#0a0a0a";
      ctx.fillRect(0, 0, specSize.width, TIME_AXIS_HEIGHT);
      ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle = "#d4d4d8";
      ctx.strokeStyle = "#3f3f46";
      ctx.lineWidth = 1;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      const secPerPx = duration / specSize.width;
      const step = pickTickStep(secPerPx, 80, TIME_TICK_STEPS);
      for (let t = 0; t <= duration + 0.001; t += step) {
        const x = (t / duration) * specSize.width;
        if (x < 12 || x > specSize.width - 12) continue;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, 4);
        ctx.stroke();
        ctx.fillText(formatSeconds(t), x, TIME_AXIS_HEIGHT / 2 + 2);
      }
    }, [duration, specSize.width]);

    // ---- Resize observer ----------------------------------------------------
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      const apply = () => {
        const cssW = Math.max(0, container.clientWidth - FREQ_AXIS_WIDTH);
        if (specCanvasRef.current) sizeCanvas(specCanvasRef.current, cssW, SPEC_HEIGHT);
        if (timeAxisRef.current) sizeCanvas(timeAxisRef.current, cssW, TIME_AXIS_HEIGHT);
        // freq-axis canvas sizes itself in its own effect (depends on specSize.height)
        setSpecSize({ width: cssW, height: SPEC_HEIGHT });
      };
      apply();

      const ro = new ResizeObserver(apply);
      ro.observe(container);
      return () => ro.disconnect();
    }, []);

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
        if (playheadRef.current && duration > 0 && specSize.width > 0) {
          const x = (t / duration) * specSize.width;
          playheadRef.current.style.transform = `translateX(${x}px)`;
        }
        onTimeUpdate?.(t);
        rafRef.current = requestAnimationFrame(tick);
      };

      const onPlay = () => {
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
        if (playheadRef.current && duration > 0 && specSize.width > 0) {
          const x = (audio.currentTime / duration) * specSize.width;
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
    }, [duration, specSize.width, onTimeUpdate, onPlayPause]);

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
          // Clamp end slightly inside duration so the rAF wrap-around fires
          // before the audio element auto-pauses on `ended`.
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
      }),
      []
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
            // Preserve width/height: skip update if clamping squashed dimensions
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
          if (!drag.hasDragged) return; // bare click → onClick handler will seek
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
            // Click without drag → toggle selection
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

    // ---- Click on spec → seek ---------------------------------------------
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
        // Manual seek cancels any active loop.
        loopRef.current = false;
        selectionEndRef.current = null;
        selectionStartRef.current = null;
        a.currentTime = clamp(nxToTime(nx), 0, duration);
      },
      [eventToNorm, nxToTime, duration]
    );

    // ---- Time axis click → seek -------------------------------------------
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

    // ---- Render boxes (with dragOverride) ----------------------------------
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

    return (
      <div ref={containerRef} className="relative flex w-full bg-zinc-950 select-none">
        {/* Hidden audio element */}
        <audio ref={audioRef} src={audioUrl} preload="auto" />

        {/* Left: frequency axis */}
        <div style={{ width: FREQ_AXIS_WIDTH, height: SPEC_HEIGHT }} className="shrink-0">
          <canvas ref={freqAxisRef} />
        </div>

        {/* Right: spec area + time axis */}
        <div className="flex-1 min-w-0 flex flex-col">
          <div
            className="relative"
            style={{ height: SPEC_HEIGHT, width: specSize.width || "100%" }}
          >
            <canvas
              ref={specCanvasRef}
              className="absolute inset-0"
              style={{ pointerEvents: "none" }}
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
                    // re-run decode by toggling state
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
            {stage === "ready" && specSize.width > 0 && (
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
                {renderedBoxes.map((box) => {
                  const isSelected = selectedBoxId === box.id;
                  const isHovered = hoverBoxId === box.id && !isSelected;
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

                  const fillOpacity = isSelected
                    ? 0.3
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
                        strokeDasharray={isLegacyFull ? "4 3" : undefined}
                        vectorEffect="non-scaling-stroke"
                      />

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

            {/* Box labels — HTML overlay, decoupled from the SVG's stretched
                viewBox so text isn't horizontally distorted. */}
            {stage === "ready" && specSize.width > 0 && (
              <div className="absolute inset-0 pointer-events-none">
                {renderedBoxes.map((box) => {
                  if (!box.displayLabel) return null;
                  const status = box.verificationStatus ?? "unverified";
                  const isSelected = selectedBoxId === box.id;
                  if (status === "rejected" && !isSelected) return null;
                  const color = getSpeciesColor(box.species);
                  const xPx = timeToNX(box.startTime) * specSize.width;
                  const yTopPx = hzToNY(box.maxFreq) * specSize.height;
                  const wPx = Math.max(0, timeToNX(box.endTime) * specSize.width - xPx);
                  const labelAbove = yTopPx >= 18;
                  const top = labelAbove ? Math.max(0, yTopPx - 18) : yTopPx;
                  const collapsedMax = Math.max(wPx + 4, 70);
                  const expandedMax = specSize.width - xPx;
                  const maxWidth = Math.min(
                    isSelected ? expandedMax : collapsedMax,
                    expandedMax
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
                      title={`${box.displayLabel} · ${box.startTime.toFixed(1)}s–${box.endTime.toFixed(1)}s · ${(box.minFreq / 1000).toFixed(1)}–${(box.maxFreq / 1000).toFixed(1)} kHz`}
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

          {/* Time axis */}
          <canvas
            ref={timeAxisRef}
            onClick={handleTimeAxisClick}
            className="cursor-pointer"
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
            {/* invisible larger hit target */}
            <rect
              x={cx - hitHalfW}
              y={cy - hitHalfH}
              width={hitHalfW * 2}
              height={hitHalfH * 2}
              fill="transparent"
              data-handle={d.name}
              data-box-id={boxId}
            />
            {/* visible handle */}
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
