"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Play, Pause, ExternalLink, Loader2 } from "lucide-react";
import type { AudioDetectionRow } from "@/app/audio/species/actions";
import { COLORMAPS } from "@/lib/spectrogram-colormaps";

const PADDING_SECONDS = 3;
const SPEC_HEIGHT = 56;
const FFT_SIZE = 512; // 256 frequency bins; ~5.8 ms time window @ 44.1 kHz
const DISPLAY_BIN_FRACTION = 0.85; // bird vocalizations live below ~17 kHz at 44.1 kHz

// Module-level singleton. Chrome caps active AudioContexts at ~6 per page;
// one-per-card breaks after a handful of plays (the 7th card's context is
// created but silently inert, so the spectrogram never paints). One shared
// context can host any number of MediaElementAudioSourceNodes.
let sharedAudioContext: AudioContext | null = null;

function getSharedAudioContext(): AudioContext | null {
  if (sharedAudioContext && sharedAudioContext.state !== "closed") {
    return sharedAudioContext;
  }
  try {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    sharedAudioContext = new Ctor();
    return sharedAudioContext;
  } catch {
    return null;
  }
}

interface AudioDetectionCardProps {
  detection: AudioDetectionRow;
}

function formatTimestamp(date: string | null, time: string | null): string {
  if (!date) return "Sin fecha";
  if (!time) return date;
  return `${date} ${time}`;
}

function formatConfidence(c: number | null): string {
  if (c == null) return "—";
  return `${Math.round(c * 100)}%`;
}

export function AudioDetectionCard({ detection }: AudioDetectionCardProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const byteDataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const rafIdRef = useRef(0);

  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);

  const duration = detection.duration ?? Number.POSITIVE_INFINITY;
  const start = Math.max(0, detection.startTime - PADDING_SECONDS);
  const end = Math.min(
    Number.isFinite(duration) ? duration : detection.endTime + PADDING_SECONDS,
    detection.endTime + PADDING_SECONDS
  );
  const clipLength = end - start;

  // Refs for the latest clip-window values so the rAF tick (which is started
  // from a user gesture, not from this effect) always reads current values
  // without re-creating the loop when the detection row's numbers shift.
  const startRef = useRef(start);
  const endRef = useRef(end);
  const clipLengthRef = useRef(clipLength);
  useEffect(() => {
    startRef.current = start;
    endRef.current = end;
    clipLengthRef.current = clipLength;
  }, [start, end, clipLength]);

  // Stream URL — the stream API takes the Google Drive file ID
  // (audio_files.driveFileId), NOT the integer DB id.
  const streamSrc = `/api/audio/stream?fileId=${encodeURIComponent(
    detection.driveFileId
  )}`;

  // Canvas backing-store sizing is deferred to first play (see resizeCanvas
  // below). Mount-time sizing was unreliable: cards inside a collapsed
  // <details> ("Sin ubicación") have clientWidth=0 at mount, so the canvas
  // never had a paintable surface and the spectrogram silently no-op'd.

  const stopRaf = useCallback(() => {
    if (rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = 0;
    }
  }, []);

  // Self-driving rAF spectrogram loop. We kick it off DIRECTLY from toggle()
  // after el.play() resolves, rather than wiring it to the audio element's
  // `play` event. Earlier the event-listener path occasionally orphaned the
  // loop after SPA navigation — the listener was attached but the event timing
  // relative to the awaited play() promise drifted, so the rAF never started
  // and the spectrogram stayed dark even though audio was flowing. Calling
  // startRaf() inline removes that timing dependency entirely.
  //
  // The tick self-stops when the audio is paused/ended, so we don't need
  // separate event listeners for teardown.
  const startRaf = useCallback(() => {
    stopRaf();
    const tick = () => {
      const el = audioRef.current;
      if (!el || el.paused || el.ended) {
        rafIdRef.current = 0;
        return;
      }
      const endVal = endRef.current;
      if (Number.isFinite(endVal) && el.currentTime >= endVal) {
        el.pause();
        setPlaying(false);
        rafIdRef.current = 0;
        return;
      }
      const canvas = canvasRef.current;
      const analyser = analyserRef.current;
      const byteData = byteDataRef.current;
      const cl = clipLengthRef.current;
      if (canvas && analyser && byteData && cl > 0) {
        analyser.getByteFrequencyData(byteData);
        paintColumn(canvas, byteData, el.currentTime, startRef.current, cl);
      }
      rafIdRef.current = requestAnimationFrame(tick);
    };
    rafIdRef.current = requestAnimationFrame(tick);
  }, [stopRaf]);

  // Keep `playing` in sync when the user pauses/ends audio outside our control
  // (system controls, tab focus loss in some browsers, etc.).
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onPause = () => setPlaying(false);
    const onEnded = () => {
      setPlaying(false);
      stopRaf();
    };
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnded);
    return () => {
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEnded);
    };
  }, [stopRaf]);

  // Stop the rAF on unmount.
  useEffect(() => stopRaf, [stopRaf]);

  // Disconnect this card's nodes on unmount. Do NOT close the shared context —
  // other cards may still be using it. The source/analyser become orphaned
  // when the <audio> element is removed; disconnecting helps GC.
  useEffect(() => {
    return () => {
      try {
        sourceNodeRef.current?.disconnect();
      } catch {
        /* already disconnected */
      }
      try {
        analyserRef.current?.disconnect();
      } catch {
        /* already disconnected */
      }
    };
  }, []);

  const ensureAudioGraph = () => {
    const el = audioRef.current;
    if (!el) return false;
    if (audioCtxRef.current) return true;
    const ctx = getSharedAudioContext();
    if (!ctx) return false;
    try {
      const source = ctx.createMediaElementSource(el);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.4;
      source.connect(analyser);
      analyser.connect(ctx.destination);
      audioCtxRef.current = ctx;
      analyserRef.current = analyser;
      sourceNodeRef.current = source;
      byteDataRef.current = new Uint8Array(analyser.frequencyBinCount);
      return true;
    } catch {
      return false;
    }
  };

  // Match backing store to current CSS-pixel size and DPR. Safe to call on
  // every play — if dimensions haven't changed, this is a no-op visually
  // (we only clear when sizing changes or the caller asks).
  const resizeCanvas = (clearAfter: boolean) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth;
    const wantedW = Math.max(1, Math.floor(cssWidth * dpr));
    const wantedH = Math.max(1, Math.floor(SPEC_HEIGHT * dpr));
    const sizeChanged = canvas.width !== wantedW || canvas.height !== wantedH;
    if (sizeChanged) {
      canvas.width = wantedW;
      canvas.height = wantedH;
    }
    if (sizeChanged || clearAfter) {
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "rgb(20, 20, 28)";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
    }
  };

  const clearCanvas = () => resizeCanvas(true);

  const toggle = async () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
      setPlaying(false);
      return;
    }

    // Wait for metadata BEFORE seek/play, otherwise el.play() may fire while
    // currentTime is still 0 and the recording streams from the beginning
    // instead of from the clip window.
    if (el.readyState < 1 /* HAVE_METADATA */) {
      setLoading(true);
      try {
        await new Promise<void>((resolve, reject) => {
          const onLoaded = () => {
            el.removeEventListener("error", onErr);
            resolve();
          };
          const onErr = () => {
            el.removeEventListener("loadedmetadata", onLoaded);
            reject(new Error("audio load failed"));
          };
          el.addEventListener("loadedmetadata", onLoaded, { once: true });
          el.addEventListener("error", onErr, { once: true });
          el.load();
        });
      } catch {
        setLoading(false);
        setPlaying(false);
        return;
      }
      setLoading(false);
    }

    // Clamp seek target inside the actual file duration (cached duration
    // can disagree with the decoded duration).
    const elDur = Number.isFinite(el.duration) ? el.duration : Infinity;
    const seekTarget = Math.min(start, Math.max(0, elDur - 0.05));

    // Seek into the clip window and AWAIT completion before play. For
    // detections deep into a long recording, the byte range covering
    // `start` is not downloaded at metadata time.
    if (Math.abs(el.currentTime - seekTarget) > 0.05) {
      setLoading(true);
      try {
        await new Promise<void>((resolve, reject) => {
          const onSeeked = () => {
            el.removeEventListener("error", onErr);
            resolve();
          };
          const onErr = () => {
            el.removeEventListener("seeked", onSeeked);
            reject(new Error("seek failed"));
          };
          el.addEventListener("seeked", onSeeked, { once: true });
          el.addEventListener("error", onErr, { once: true });
          el.currentTime = seekTarget;
        });
      } catch {
        setLoading(false);
        setPlaying(false);
        return;
      }
      setLoading(false);
    }

    // Build the Web Audio graph on first play (user-gesture context).
    if (!ensureAudioGraph()) {
      setPlaying(false);
      return;
    }
    try {
      await audioCtxRef.current!.resume();
    } catch {
      // continue — most browsers don't require resume after gesture
    }

    // Ensure the canvas backing store matches its live CSS-pixel size before
    // painting starts. This is the right moment because the play button was
    // just clicked — the canvas is guaranteed visible and laid out, even if
    // it was inside a <details> collapsed at mount.
    resizeCanvas(false);

    // If we're starting fresh from the clip start, wipe any old paint so the
    // canvas reflects only this playthrough.
    if (Math.abs(el.currentTime - start) < 0.1) {
      clearCanvas();
    }

    try {
      await el.play();
      setPlaying(true);
      // Start the spectrogram loop right here — don't wait for the audio
      // element's `play` event, whose timing relative to this promise is
      // browser-dependent and has been observed to skip the listener after
      // SPA navigation.
      startRaf();
    } catch {
      setPlaying(false);
    }
  };

  const verifiedBadge = (() => {
    switch (detection.verificationStatus) {
      case "verified":
        return (
          <span className="text-emerald-600 text-xs font-medium">
            ✓ Verificada
          </span>
        );
      case "corrected":
        return (
          <span className="text-sky-600 text-xs font-medium">✎ Corregida</span>
        );
      case "rejected":
        return (
          <span className="text-rose-600 text-xs font-medium">✗ Rechazada</span>
        );
      default:
        return (
          <span className="text-muted-foreground text-xs">Sin verificar</span>
        );
    }
  })();

  return (
    <div className="rounded-md border bg-card p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs text-muted-foreground">
          {formatTimestamp(detection.recordingDate, detection.recordingTime)}
        </div>
        {verifiedBadge}
      </div>

      <div className="flex items-center gap-2 text-sm">
        <button
          type="button"
          onClick={toggle}
          disabled={loading}
          aria-label={playing ? "Pausar" : "Reproducir"}
          className="w-9 h-9 rounded-full bg-foreground text-background flex items-center justify-center shrink-0 hover:opacity-90 disabled:opacity-60 disabled:cursor-progress"
        >
          {loading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : playing ? (
            <Pause className="w-4 h-4" />
          ) : (
            <Play className="w-4 h-4 translate-x-[1px]" />
          )}
        </button>
        <div className="flex-1 min-w-0">
          <canvas
            ref={canvasRef}
            style={{ width: "100%", height: `${SPEC_HEIGHT}px` }}
            className="rounded bg-[rgb(20,20,28)] block"
          />
          <div className="mt-1 flex justify-between text-[10px] text-muted-foreground tabular-nums">
            <span>
              {detection.startTime.toFixed(1)}s → {detection.endTime.toFixed(1)}s
              <span className="ml-1 opacity-70">
                (clip {clipLength.toFixed(1)}s, ±{PADDING_SECONDS}s)
              </span>
            </span>
            <span>Confianza {formatConfidence(detection.confidence)}</span>
          </div>
        </div>
      </div>

      <audio ref={audioRef} src={streamSrc} preload="none" />

      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground truncate" title={detection.filename}>
          {detection.filename}
        </span>
        <Link
          href={`/audio/${detection.deploymentId}/annotate/${detection.audioFileId}?seek=${detection.startTime.toFixed(
            2
          )}`}
          className="inline-flex items-center gap-1 text-sky-700 hover:underline shrink-0"
        >
          Abrir en contexto <ExternalLink className="w-3 h-3" />
        </Link>
      </div>
    </div>
  );
}

// Paint a 1-column slice at the playhead's x-position. The byteData is the
// AnalyserNode's latest FFT frame; we map low frequencies to the bottom of
// the canvas (musical convention) and apply the viridis LUT.
function paintColumn(
  canvas: HTMLCanvasElement,
  byteData: Uint8Array<ArrayBuffer>,
  currentTime: number,
  start: number,
  clipLength: number,
) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const width = canvas.width;
  const height = canvas.height;
  const rel = (currentTime - start) / clipLength;
  if (!Number.isFinite(rel) || rel < 0 || rel > 1) return;
  const x = Math.floor(rel * (width - 1));

  const lut = COLORMAPS.viridis;
  const displayBins = Math.floor(byteData.length * DISPLAY_BIN_FRACTION);
  const colWidth = Math.max(1, Math.ceil(width / 200)); // ~200 columns total

  const img = ctx.createImageData(colWidth, height);
  for (let y = 0; y < height; y++) {
    // y=0 is top; map to highest displayed bin → flip so low freq is at bottom.
    const binFloat = (1 - y / height) * (displayBins - 1);
    const binIdx = Math.min(displayBins - 1, Math.max(0, Math.floor(binFloat)));
    const v = byteData[binIdx];
    const r = lut[v * 3];
    const g = lut[v * 3 + 1];
    const b = lut[v * 3 + 2];
    for (let dx = 0; dx < colWidth; dx++) {
      const idx = (y * colWidth + dx) * 4;
      img.data[idx] = r;
      img.data[idx + 1] = g;
      img.data[idx + 2] = b;
      img.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, x, 0);
}
