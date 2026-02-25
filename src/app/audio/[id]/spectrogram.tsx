"use client";

import { useRef, useEffect, useCallback } from "react";

interface SpectrogramProps {
  audioRef: React.RefObject<HTMLAudioElement | null>;
  isPlaying: boolean;
  /** Called when user clicks on the spectrogram to seek */
  onSeek?: (fraction: number) => void;
}

const FFT_SIZE = 2048;
const CANVAS_HEIGHT = 60;
const SMOOTHING = 0.8;

export function Spectrogram({ audioRef, isPlaying, onSeek }: SpectrogramProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const animRef = useRef<number>(0);
  const columnRef = useRef(0);

  // Initialize Web Audio API on first play
  useEffect(() => {
    if (!isPlaying) return;
    const audio = audioRef.current;
    if (!audio) return;

    // Create AudioContext lazily (must be after user interaction)
    if (!ctxRef.current) {
      const ctx = new AudioContext();
      ctxRef.current = ctx;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = SMOOTHING;
      analyserRef.current = analyser;

      // MediaElementAudioSourceNode can only be created once per <audio>
      const source = ctx.createMediaElementSource(audio);
      source.connect(analyser);
      analyser.connect(ctx.destination);
      sourceRef.current = source;
    }

    // Resume context if suspended (autoplay policy)
    if (ctxRef.current.state === "suspended") {
      ctxRef.current.resume();
    }
  }, [isPlaying, audioRef]);

  // Animation loop — rolling waterfall spectrogram
  useEffect(() => {
    const analyser = analyserRef.current;
    const canvas = canvasRef.current;
    if (!analyser || !canvas || !isPlaying) {
      return;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    function draw() {
      animRef.current = requestAnimationFrame(draw);
      analyser!.getByteFrequencyData(dataArray);

      const w = canvas!.width;
      const h = canvas!.height;

      // Shift existing image left by 1 pixel
      const imageData = ctx!.getImageData(1, 0, w - 1, h);
      ctx!.putImageData(imageData, 0, 0);

      // Draw new column on the right edge
      const col = columnRef.current;
      for (let i = 0; i < h; i++) {
        // Map canvas row to frequency bin (bottom = low freq, top = high freq)
        const binIndex = Math.floor(((h - 1 - i) / h) * bufferLength);
        const value = dataArray[binIndex];
        // Grayscale: 0=black, 255=white
        ctx!.fillStyle = `rgb(${value}, ${value}, ${value})`;
        ctx!.fillRect(w - 1, i, 1, 1);
      }
      columnRef.current = col + 1;
    }

    draw();

    return () => {
      cancelAnimationFrame(animRef.current);
    };
  }, [isPlaying]);

  // Clear canvas when audio source changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    columnRef.current = 0;
  }, [audioRef.current?.src]);

  // Click-to-seek on spectrogram
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      if (!onSeek) return;
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return;
      const fraction = (e.clientX - rect.left) / rect.width;
      onSeek(Math.max(0, Math.min(1, fraction)));
    },
    [onSeek]
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelAnimationFrame(animRef.current);
      // Don't close AudioContext — it would break reconnection
      // The source node stays connected and works when audio src changes
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={200}
      height={CANVAS_HEIGHT}
      onClick={handleClick}
      className="h-[60px] w-full max-w-[200px] rounded bg-black cursor-pointer shrink-0"
      style={{ imageRendering: "pixelated" }}
    />
  );
}
