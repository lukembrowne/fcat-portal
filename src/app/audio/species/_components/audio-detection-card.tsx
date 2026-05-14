"use client";

import { useRef, useState, useEffect } from "react";
import Link from "next/link";
import { Play, Pause, ExternalLink, Loader2 } from "lucide-react";
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

  // Stream URL — the stream API takes the Google Drive file ID
  // (audio_files.driveFileId), NOT the integer DB id. We intentionally do NOT
  // append a Media Fragment hash (#t=...) because browser support is
  // inconsistent and we seek explicitly before play.
  const streamSrc = `/api/audio/stream?fileId=${encodeURIComponent(
    detection.driveFileId
  )}`;

  // Drive the progress bar from requestAnimationFrame instead of the audio
  // element's `timeupdate` event. timeupdate fires at the browser's
  // discretion (often 200-400ms, sometimes skipping entirely while the
  // element fetches byte ranges for streamed audio), which made the bar look
  // stuck or jumpy. rAF gives a smooth 60fps poll of currentTime, and we
  // only spin it up between play→pause/ended.
  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;

    let rafId = 0;
    let running = false;

    const stop = () => {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    };

    const tick = () => {
      if (!running) return;
      if (Number.isFinite(end) && el.currentTime >= end) {
        el.pause();
        setPlaying(false);
        setProgress(0);
        stop();
        return;
      }
      const ratio =
        clipLength > 0 ? (el.currentTime - start) / clipLength : 0;
      setProgress(Math.max(0, Math.min(1, ratio)));
      rafId = requestAnimationFrame(tick);
    };

    const onPlay = () => {
      if (running) return;
      running = true;
      rafId = requestAnimationFrame(tick);
    };
    const onPause = () => stop();
    const onEnded = () => {
      stop();
      setPlaying(false);
      setProgress(0);
    };

    el.addEventListener("play", onPlay);
    el.addEventListener("pause", onPause);
    el.addEventListener("ended", onEnded);
    return () => {
      stop();
      el.removeEventListener("play", onPlay);
      el.removeEventListener("pause", onPause);
      el.removeEventListener("ended", onEnded);
    };
  }, [start, end, clipLength]);

  const [loading, setLoading] = useState(false);

  const toggle = async () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
      setPlaying(false);
      return;
    }

    // Wait for metadata BEFORE seek/play, otherwise el.play() may fire while
    // currentTime is still 0 (start of the recording, not start of the clip).
    // The browser then streams minutes of pre-roll before reaching the
    // detection window and the progress bar stays at 0 the whole time.
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

    // Clamp seek target inside the actual file duration. The cached
    // audio_files.duration can disagree with the decoded duration; trust the
    // element which now has metadata.
    const elDur = Number.isFinite(el.duration) ? el.duration : Infinity;
    const seekTarget = Math.min(start, Math.max(0, elDur - 0.05));

    // Always seek into the clip window before play, and AWAIT the seek. For
    // detections deep in a long recording the byte range covering `start` is
    // not downloaded yet — calling play() before the seek completes either
    // rejects silently or stalls indefinitely with the progress bar frozen.
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

    try {
      await el.play();
      setPlaying(true);
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
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-foreground"
              style={{ width: `${progress * 100}%` }}
            />
          </div>
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
