"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Download, X, Play, Pause, SkipBack, SkipForward } from "lucide-react";
import { useSidebar } from "@/components/ui/sidebar";
import type { AudioFileRow } from "../actions";
import { Spectrogram } from "./spectrogram";

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function AudioPlayer({
  fileId,
  file,
  onClose,
}: {
  fileId: string;
  file: AudioFileRow | null;
  onClose: () => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const progressRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [bufferedEnd, setBufferedEnd] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const { state: sidebarState } = useSidebar();

  const streamUrl = `/api/audio/stream?fileId=${encodeURIComponent(fileId)}`;

  // Auto-play when fileId changes
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.load();
    audio.play().catch(() => {});
  }, [fileId]);

  // Track playback state
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    function onTimeUpdate() {
      if (!isDragging) {
        setCurrentTime(audio!.currentTime);
      }
    }
    function onDurationChange() {
      setDuration(audio!.duration);
    }
    function onProgress() {
      if (audio!.buffered.length > 0) {
        setBufferedEnd(audio!.buffered.end(audio!.buffered.length - 1));
      }
    }
    function onPlay() {
      setIsPlaying(true);
    }
    function onPause() {
      setIsPlaying(false);
    }
    function onEnded() {
      setIsPlaying(false);
    }

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("durationchange", onDurationChange);
    audio.addEventListener("progress", onProgress);
    audio.addEventListener("play", onPlay);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("ended", onEnded);

    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("durationchange", onDurationChange);
      audio.removeEventListener("progress", onProgress);
      audio.removeEventListener("play", onPlay);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("ended", onEnded);
    };
  }, [isDragging]);

  const togglePlayPause = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      audio.play().catch(() => {});
    } else {
      audio.pause();
    }
  }, []);

  const seekTo = useCallback(
    (fraction: number) => {
      const audio = audioRef.current;
      if (!audio || !isFinite(duration) || duration === 0) return;
      audio.currentTime = Math.max(0, Math.min(fraction * duration, duration));
      setCurrentTime(audio.currentTime);
    },
    [duration]
  );

  const seekRelative = useCallback(
    (deltaSeconds: number) => {
      const audio = audioRef.current;
      if (!audio) return;
      audio.currentTime = Math.max(
        0,
        Math.min(audio.duration || 0, audio.currentTime + deltaSeconds)
      );
    },
    []
  );

  // Click-to-seek on progress bar
  const handleProgressClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const rect = progressRef.current?.getBoundingClientRect();
      if (!rect) return;
      const fraction = (e.clientX - rect.left) / rect.width;
      seekTo(fraction);
    },
    [seekTo]
  );

  // Drag-to-seek
  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(true);
      const rect = progressRef.current?.getBoundingClientRect();
      if (!rect) return;
      const fraction = (e.clientX - rect.left) / rect.width;
      seekTo(fraction);

      function onMouseMove(ev: MouseEvent) {
        if (!rect) return;
        const f = Math.max(
          0,
          Math.min(1, (ev.clientX - rect.left) / rect.width)
        );
        seekTo(f);
      }
      function onMouseUp() {
        setIsDragging(false);
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
      }
      window.addEventListener("mousemove", onMouseMove);
      window.addEventListener("mouseup", onMouseUp);
    },
    [seekTo]
  );

  // Keyboard shortcuts
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      ) {
        return;
      }

      if (e.code === "Space") {
        e.preventDefault();
        togglePlayPause();
      } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        seekRelative(-5);
      } else if (e.code === "ArrowRight") {
        e.preventDefault();
        seekRelative(5);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [togglePlayPause, seekRelative]);

  // Close stops audio
  function handleClose() {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.src = "";
    }
    onClose();
  }

  const playedPct = duration > 0 ? (currentTime / duration) * 100 : 0;
  const bufferedPct = duration > 0 ? (bufferedEnd / duration) * 100 : 0;

  // Offset by sidebar width so player doesn't overlap
  const sidebarOffset =
    sidebarState === "collapsed"
      ? "var(--sidebar-width-icon)"
      : "var(--sidebar-width)";

  return (
    <div
      className="fixed bottom-0 right-0 z-40 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 shadow-lg"
      style={{ left: sidebarOffset }}
    >
      {/* Hidden audio element */}
      <audio ref={audioRef} src={streamUrl} preload="auto" />

      {/* Top row: spectrogram + progress */}
      <div className="flex items-stretch">
        {/* Live spectrogram visualization */}
        <div className="shrink-0 bg-black">
          <Spectrogram
            audioRef={audioRef}
            isPlaying={isPlaying}
            onSeek={seekTo}
          />
        </div>

        {/* Progress bar — fills remaining width */}
        <div className="flex-1 flex flex-col justify-center min-w-0">
          <div
            ref={progressRef}
            className="h-full bg-muted cursor-pointer group relative"
            onClick={handleProgressClick}
            onMouseDown={handleMouseDown}
          >
            {/* Buffered range */}
            <div
              className="absolute inset-y-0 left-0 bg-muted-foreground/20"
              style={{ width: `${bufferedPct}%` }}
            />
            {/* Played range */}
            <div
              className="absolute inset-y-0 left-0 bg-primary/30"
              style={{ width: `${playedPct}%` }}
            />
            {/* Playhead line */}
            <div
              className="absolute inset-y-0 w-0.5 bg-primary"
              style={{ left: `${playedPct}%` }}
            />
            {/* Thumb — shows on hover */}
            <div
              className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-4 w-4 rounded-full bg-primary opacity-0 group-hover:opacity-100 transition-opacity shadow"
              style={{ left: `${playedPct}%` }}
            />
          </div>
        </div>
      </div>

      {/* Bottom row: controls */}
      <div className="flex items-center gap-2 px-3 py-1.5">
        {/* Skip back */}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0 shrink-0"
          onClick={() => seekRelative(-5)}
          title="Retroceder 5s (←)"
        >
          <SkipBack className="h-3.5 w-3.5" />
        </Button>

        {/* Play/Pause */}
        <Button
          size="sm"
          variant="ghost"
          className="h-8 w-8 p-0 shrink-0"
          onClick={togglePlayPause}
          title={isPlaying ? "Pausar (Espacio)" : "Reproducir (Espacio)"}
        >
          {isPlaying ? (
            <Pause className="h-4 w-4" />
          ) : (
            <Play className="h-4 w-4" />
          )}
        </Button>

        {/* Skip forward */}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0 shrink-0"
          onClick={() => seekRelative(5)}
          title="Avanzar 5s (→)"
        >
          <SkipForward className="h-3.5 w-3.5" />
        </Button>

        {/* Time */}
        <span className="text-xs tabular-nums text-muted-foreground shrink-0 min-w-[5.5rem] text-center">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>

        {/* File info */}
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">
            {file?.filename ?? "Audio"}
          </p>
        </div>

        {/* Download */}
        <a
          href={`${streamUrl}&download=true`}
          download
          className="shrink-0"
        >
          <Button size="sm" variant="ghost" className="h-7 w-7 p-0">
            <Download className="h-3.5 w-3.5" />
          </Button>
        </a>

        {/* Close */}
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-7 p-0 shrink-0"
          onClick={handleClose}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
