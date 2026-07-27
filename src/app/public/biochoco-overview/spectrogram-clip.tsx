"use client";

/**
 * A visual audio clip for the public overview: a spectrogram image with a
 * playhead that tracks the native <audio> player underneath.
 *
 * Normally the spectrogram was already rendered server-side at publish time and
 * arrives as `pngSrc` — a lazily-loaded, separately-cacheable image. Without one
 * (or if it fails to load) the component falls back to fetching the recording
 * and computing the FFT in the browser, reusing the same render primitives as
 * the internal annotation tool (`@/lib/audio-fft`, `@/lib/spectrogram-render`).
 *
 * On that fallback path, decoding is deferred until the clip scrolls near the
 * viewport (six clips on one page would otherwise all decode at once). Either
 * way the raw audio only loads when the user presses play.
 */

import { useEffect, useRef, useState } from "react";
import { decodeAudio, computeMagnitudes, binFromHz } from "@/lib/audio-fft";
import { renderImageData } from "@/lib/spectrogram-render";
import { COLORMAPS } from "@/lib/spectrogram-colormaps";

// Render knobs tuned for short tropical-bird clips (most energy < 12 kHz).
const DISPLAY_MAX_HZ = 12000;
const FFT_SIZE = 1024;
const GAIN_DB = 18;
const RANGE_DB = 72;
const CANVAS_CSS_HEIGHT = 132;

type Stage = "idle" | "loading" | "ready" | "error";

function paint(canvas: HTMLCanvasElement, img: { width: number; height: number; data: Uint8ClampedArray }) {
  const cssW = canvas.clientWidth || 640;
  const cssH = CANVAS_CSS_HEIGHT;
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const off = document.createElement("canvas");
  off.width = img.width;
  off.height = img.height;
  const offCtx = off.getContext("2d");
  if (!offCtx) return;
  const imageData = offCtx.createImageData(img.width, img.height);
  imageData.data.set(img.data);
  offCtx.putImageData(imageData, 0, 0);

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(off, 0, 0, canvas.width, canvas.height);
}

export function SpectrogramClip({
  src,
  label,
  pngSrc,
}: {
  src: string;
  label: string;
  /**
   * URL of the spectrogram pre-rendered at publish time. When it loads, it is
   * shown directly and no client FFT runs. If the request fails the component
   * falls back to computing the spectrogram in the browser, so a missing image
   * degrades instead of leaving an empty box.
   */
  pngSrc?: string;
}) {
  const [pngFailed, setPngFailed] = useState(false);
  const usePng = Boolean(pngSrc) && !pngFailed;
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number | null>(null);
  const startedRef = useRef(false);
  const [stage, setStage] = useState<Stage>("idle");
  const [near, setNear] = useState(false);

  // Defer all decode work until the clip is near the viewport. Skipped entirely
  // when a pre-rendered spectrogram is supplied.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || near || usePng) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin: "300px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near, usePng]);

  // Fetch → decode → FFT → paint, once, when near. Skipped when a pre-rendered
  // spectrogram is supplied.
  useEffect(() => {
    if (!near || usePng || startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;
    (async () => {
      setStage("loading");
      try {
        const decoded = await decodeAudio(src);
        if (cancelled) return;
        const mags = computeMagnitudes({
          samples: decoded.samples,
          sampleRate: decoded.sampleRate,
          fftSize: FFT_SIZE,
          hopSize: FFT_SIZE / 2,
        });
        const displayMaxBin = Math.min(
          mags.binCount,
          binFromHz(DISPLAY_MAX_HZ, mags.fftSize, mags.sampleRate) + 1,
        );
        const img = renderImageData({
          magnitudes: mags.magnitudes,
          numFrames: mags.numFrames,
          binCount: mags.binCount,
          displayMaxBin,
          gainDB: GAIN_DB,
          rangeDB: RANGE_DB,
          lut: COLORMAPS.magma,
        });
        if (cancelled || !canvasRef.current) return;
        paint(canvasRef.current, img);
        setStage("ready");
      } catch {
        if (!cancelled) setStage("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [near, src, usePng]);

  // Playhead tracking, driven by rAF while the clip is playing.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const place = () => {
      const head = playheadRef.current;
      const dur = audio.duration;
      if (head && dur > 0) {
        head.style.left = `${(audio.currentTime / dur) * 100}%`;
        head.style.opacity = audio.paused && audio.currentTime === 0 ? "0" : "1";
      }
    };
    const loop = () => {
      place();
      rafRef.current = requestAnimationFrame(loop);
    };
    const start = () => {
      if (rafRef.current == null) rafRef.current = requestAnimationFrame(loop);
    };
    const stop = () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      place();
    };
    audio.addEventListener("play", start);
    audio.addEventListener("pause", stop);
    audio.addEventListener("ended", stop);
    audio.addEventListener("seeked", place);
    return () => {
      audio.removeEventListener("play", start);
      audio.removeEventListener("pause", stop);
      audio.removeEventListener("ended", stop);
      audio.removeEventListener("seeked", place);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [stage]);

  return (
    <div className="spec-clip" ref={wrapRef}>
      <div className="spec-canvas-wrap">
        {usePng ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="spec-canvas"
            src={pngSrc}
            alt={`Spectrogram — ${label}`}
            loading="lazy"
            onError={() => setPngFailed(true)}
          />
        ) : (
          <canvas ref={canvasRef} className="spec-canvas" aria-label={`Spectrogram — ${label}`} />
        )}
        <div className="spec-playhead" ref={playheadRef} />
        {!usePng && stage !== "ready" && (
          <div className="spec-status">
            {stage === "error" ? "—" : stage === "loading" ? "generating spectrogram…" : ""}
          </div>
        )}
      </div>
      <audio ref={audioRef} controls preload="none" src={src} />
    </div>
  );
}
