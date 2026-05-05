"use client";

import { useEffect, useRef, useCallback, useImperativeHandle, forwardRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import SpectrogramPlugin from "wavesurfer.js/dist/plugins/spectrogram.esm.js";
import RegionsPlugin from "wavesurfer.js/dist/plugins/regions.esm.js";
import { resampleAudioToWavBlobUrl } from "@/lib/audio-resample";

// Resample the audio to this sample rate before passing to wavesurfer so the
// spectrogram's Nyquist (= sampleRate/2) matches our desired display max.
// Bird vocalizations live below 12 kHz, so 24 kHz is a clean target.
const SPECTROGRAM_TARGET_SAMPLE_RATE = 24000;

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

interface WavesurferSpectrogramProps {
  audioUrl: string;
  boxes: AudioBoxData[];
  selectedBoxId: number | null;
  editable: boolean;
  onBoxClick?: (box: AudioBoxData) => void;
  onDrawComplete?: (box: {
    startTime: number;
    endTime: number;
    minFreq: number;
    maxFreq: number;
  }) => void;
  onReady?: (duration: number) => void;
  onTimeUpdate?: (currentTime: number) => void;
  onPlayPause?: (isPlaying: boolean) => void;
}

// Color palette for species
const COLOR_PALETTE = [
  "#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#a855f7",
  "#06b6d4", "#f97316", "#ec4899", "#14b8a6", "#8b5cf6",
];
const SPECIES_COLORS: Record<string, string> = {};

function getSpeciesColor(species: string | null | undefined): string {
  if (!species || species === "unknown") return "#22c55e";
  if (!SPECIES_COLORS[species]) {
    const idx = Object.keys(SPECIES_COLORS).length % COLOR_PALETTE.length;
    SPECIES_COLORS[species] = COLOR_PALETTE[idx];
  }
  return SPECIES_COLORS[species];
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export const WavesurferSpectrogram = forwardRef<WavesurferMethods, WavesurferSpectrogramProps>(function WavesurferSpectrogram({
  audioUrl,
  boxes,
  selectedBoxId,
  editable,
  onBoxClick,
  onDrawComplete,
  onReady,
  onTimeUpdate,
  onPlayPause,
}, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WaveSurfer | null>(null);
  const regionsRef = useRef<RegionsPlugin | null>(null);
  const boxesRef = useRef(boxes);
  const onBoxClickRef = useRef(onBoxClick);
  const onDrawCompleteRef = useRef(onDrawComplete);

  // Keep refs up to date
  boxesRef.current = boxes;
  onBoxClickRef.current = onBoxClick;
  onDrawCompleteRef.current = onDrawComplete;

  const [resampledUrl, setResampledUrl] = useState<string | null>(null);

  // Resample the audio so the spectrogram's Nyquist matches our target display max.
  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;

    resampleAudioToWavBlobUrl(audioUrl, SPECTROGRAM_TARGET_SAMPLE_RATE)
      .then((url) => {
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        createdUrl = url;
        setResampledUrl(url);
      })
      .catch((err) => {
        console.error("Audio resample failed, falling back to original", err);
        if (!cancelled) setResampledUrl(audioUrl);
      });

    return () => {
      cancelled = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [audioUrl]);

  // Initialize wavesurfer
  useEffect(() => {
    if (!containerRef.current || !resampledUrl) return;

    const regions = RegionsPlugin.create();
    regionsRef.current = regions;

    const ws = WaveSurfer.create({
      container: containerRef.current,
      url: resampledUrl,
      sampleRate: SPECTROGRAM_TARGET_SAMPLE_RATE,
      waveColor: "rgba(0,0,0,0)",
      progressColor: "rgba(0,0,0,0)",
      height: 0,
      cursorColor: "#fff",
      cursorWidth: 2,
      plugins: [
        SpectrogramPlugin.create({
          labels: true,
          labelsColor: "#fff",
          labelsHzColor: "#ccc",
          labelsBackground: "rgba(0,0,0,0.5)",
          height: 256,
          fftSamples: 512,
          windowFunc: "hann",
          frequencyMin: 0,
          frequencyMax: SPECTROGRAM_TARGET_SAMPLE_RATE / 2,
          scale: "linear",
          colorMap: "roseus",
          gainDB: 25,
          rangeDB: 70,
          splitChannels: false,
        }),
        regions,
      ],
    });

    wsRef.current = ws;

    // Events
    ws.on("ready", (duration) => {
      onReady?.(duration);
    });

    ws.on("timeupdate", (time) => {
      onTimeUpdate?.(time);
    });

    ws.on("play", () => onPlayPause?.(true));
    ws.on("pause", () => onPlayPause?.(false));

    // Region events
    regions.on("region-clicked", (region, e) => {
      e.stopPropagation();
      const box = boxesRef.current.find((b) => String(b.id) === region.id);
      if (box) onBoxClickRef.current?.(box);
    });

    // Enable drag selection for creating new regions
    if (editable) {
      const disableDrag = regions.enableDragSelection({
        color: "rgba(34, 197, 94, 0.2)",
      });

      regions.on("region-created", (region) => {
        // Only handle user-created regions (no id = freshly drawn)
        if (!region.id.startsWith("det-")) {
          const startTime = Math.min(region.start, region.end);
          const endTime = Math.max(region.start, region.end);

          // Remove the temporary region — the server action will refresh the page
          region.remove();

          if (endTime - startTime > 0.1) {
            onDrawCompleteRef.current?.({
              startTime,
              endTime,
              minFreq: 0,
              maxFreq: 15000,
            });
          }
        }
      });

      return () => {
        disableDrag();
        ws.destroy();
        wsRef.current = null;
        regionsRef.current = null;
      };
    }

    return () => {
      ws.destroy();
      wsRef.current = null;
      regionsRef.current = null;
    };
  }, [resampledUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync regions with boxes
  useEffect(() => {
    const regions = regionsRef.current;
    if (!regions) return;

    // Clear existing detection regions
    for (const region of regions.getRegions()) {
      if (region.id.startsWith("det-")) {
        region.remove();
      }
    }

    // Add regions for each box
    for (const box of boxes) {
      const color = getSpeciesColor(box.species);
      const isSelected = box.id === selectedBoxId;
      const labelText = box.displayLabel ?? "";

      // Build a styled label element so the species name is readable on top of
      // the dark spectrogram (default content rendering is plain text with no
      // background).
      let contentEl: HTMLElement | undefined;
      if (labelText) {
        contentEl = document.createElement("span");
        contentEl.textContent = labelText;
        Object.assign(contentEl.style, {
          background: color,
          color: "#fff",
          padding: "2px 6px",
          fontSize: "11px",
          fontWeight: "600",
          borderRadius: "3px",
          textShadow: "0 1px 2px rgba(0,0,0,0.6)",
          whiteSpace: "nowrap",
          boxShadow: "0 1px 3px rgba(0,0,0,0.4)",
          display: "inline-block",
          marginTop: "2px",
        });
      }

      regions.addRegion({
        id: `det-${box.id}`,
        start: box.startTime,
        end: box.endTime,
        color: hexToRgba(color, isSelected ? 0.35 : 0.15),
        drag: false,
        resize: false,
        content: contentEl,
      });
    }
  }, [boxes, selectedBoxId]);

  // Expose play/pause/seek via imperative handle
  useImperativeHandle(ref, () => ({
    play: async () => { await wsRef.current?.play(); },
    pause: () => { wsRef.current?.pause(); },
    playPause: async () => { await wsRef.current?.playPause(); },
    seek: (time: number) => { wsRef.current?.setTime(time); },
    skip: (seconds: number) => { wsRef.current?.skip(seconds); },
    playSelection: async (startTime: number, endTime: number) => {
      await wsRef.current?.play(startTime, endTime);
    },
    getDuration: () => wsRef.current?.getDuration() ?? 0,
    isPlaying: () => wsRef.current?.isPlaying() ?? false,
  }), []);

  return (
    <div ref={containerRef} className="rounded-lg overflow-hidden border" />
  );
});

export type WavesurferMethods = {
  play: () => Promise<void>;
  pause: () => void;
  playPause: () => Promise<void>;
  seek: (time: number) => void;
  skip: (seconds: number) => void;
  playSelection: (startTime: number, endTime: number) => Promise<void>;
  getDuration: () => number;
  isPlaying: () => boolean;
};
