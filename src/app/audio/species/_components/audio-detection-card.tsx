"use client";

import { useRef, useState, useEffect } from "react";
import Link from "next/link";
import { Play, Pause, ExternalLink } from "lucide-react";
import type { AudioDetectionRow } from "@/app/audio/species/actions";

const PADDING_SECONDS = 3;

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
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0); // 0..1 within the clip window

  const duration = detection.duration ?? Number.POSITIVE_INFINITY;
  const start = Math.max(0, detection.startTime - PADDING_SECONDS);
  const end = Math.min(
    Number.isFinite(duration) ? duration : detection.endTime + PADDING_SECONDS,
    detection.endTime + PADDING_SECONDS
  );
  const clipLength = end - start;

  // Stream URL with Media Fragment URI hash. Honors HTTP Range on the server.
  const streamSrc = `/api/audio/stream?fileId=${detection.audioFileId}#t=${start.toFixed(
    2
  )},${end.toFixed(2)}`;

  // Inline timeupdate fallback — pauses at `end` even on browsers that don't
  // constrain the trailing edge of Media Fragment URI on <audio>.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onTime = () => {
      if (!Number.isFinite(end)) return;
      if (el.currentTime >= end) {
        el.pause();
        el.currentTime = start; // reset to clip start so play resumes the window
        setPlaying(false);
        setProgress(0);
        return;
      }
      const ratio = (el.currentTime - start) / clipLength;
      setProgress(Math.max(0, Math.min(1, ratio)));
    };
    const onEnded = () => {
      setPlaying(false);
      setProgress(0);
    };
    el.addEventListener("timeupdate", onTime);
    el.addEventListener("ended", onEnded);
    return () => {
      el.removeEventListener("timeupdate", onTime);
      el.removeEventListener("ended", onEnded);
    };
  }, [start, end, clipLength]);

  const toggle = async () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
      setPlaying(false);
      return;
    }
    // Browsers vary on Media Fragment seek; explicitly set currentTime once
    // metadata is ready. If already loaded, set directly.
    if (el.readyState >= 1) {
      if (el.currentTime < start || el.currentTime >= end) el.currentTime = start;
    } else {
      el.addEventListener(
        "loadedmetadata",
        () => {
          el.currentTime = start;
        },
        { once: true }
      );
    }
    try {
      await el.play();
      setPlaying(true);
    } catch {
      // Autoplay blocked or load failed — leave state as paused.
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
          aria-label={playing ? "Pausar" : "Reproducir"}
          className="w-9 h-9 rounded-full bg-foreground text-background flex items-center justify-center shrink-0 hover:opacity-90"
        >
          {playing ? (
            <Pause className="w-4 h-4" />
          ) : (
            <Play className="w-4 h-4 translate-x-[1px]" />
          )}
        </button>
        <div className="flex-1 min-w-0">
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-foreground transition-[width] duration-100"
              style={{ width: `${progress * 100}%` }}
            />
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-muted-foreground tabular-nums">
            <span>
              {(detection.startTime).toFixed(1)}s → {detection.endTime.toFixed(1)}s
              <span className="ml-1 opacity-70">
                (±{PADDING_SECONDS}s)
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
