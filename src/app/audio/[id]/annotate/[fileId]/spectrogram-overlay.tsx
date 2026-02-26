"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import type { SpectrogramMetadata } from "@/lib/audio-cache";
import type { AudioDetectionData } from "./annotation-client";

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

interface SpectrogramOverlayProps {
  spectrogramUrl: string;
  metadata: SpectrogramMetadata;
  boxes: AudioBoxData[];
  selectedBoxId: number | null;
  editable: boolean;
  currentTime?: number;
  onBoxClick?: (box: AudioBoxData) => void;
  onDrawComplete?: (box: {
    startTime: number;
    endTime: number;
    minFreq: number;
    maxFreq: number;
  }) => void;
  onSeekClick?: (timeSeconds: number) => void;
  onImageError?: () => void;
}

const SPECIES_COLORS: Record<string, string> = {};
const COLOR_PALETTE = [
  "#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#a855f7",
  "#06b6d4", "#f97316", "#ec4899", "#14b8a6", "#8b5cf6",
];

function getSpeciesColor(species: string | null | undefined): string {
  if (!species || species === "unknown") return "#22c55e";
  if (!SPECIES_COLORS[species]) {
    const idx = Object.keys(SPECIES_COLORS).length % COLOR_PALETTE.length;
    SPECIES_COLORS[species] = COLOR_PALETTE[idx];
  }
  return SPECIES_COLORS[species];
}

const DRAG_THRESHOLD = 5;
const MIN_TIME_S = 0.05;
const MIN_FREQ_HZ = 100;
const Y_AXIS_WIDTH = 48;

const FREQ_TICKS = [1000, 4000, 8000, 12000, 16000, 20000, 24000];

interface DragState {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  hasDragged: boolean;
}

/**
 * Convert pixel X to seconds
 */
function pxToTime(px: number, imgWidth: number, duration: number): number {
  return (px / imgWidth) * duration;
}

/**
 * Convert pixel Y to Hz (top = fmax, bottom = fmin)
 */
function pxToFreq(
  py: number,
  imgHeight: number,
  fmin: number,
  fmax: number
): number {
  return fmax - (py / imgHeight) * (fmax - fmin);
}

/**
 * Convert seconds to pixel X
 */
function timeToPx(time: number, imgWidth: number, duration: number): number {
  return (time / duration) * imgWidth;
}

/**
 * Convert Hz to pixel Y (top = fmax, bottom = fmin)
 */
function freqToPx(
  freq: number,
  imgHeight: number,
  fmin: number,
  fmax: number
): number {
  return ((fmax - freq) / (fmax - fmin)) * imgHeight;
}

function getTimeInterval(duration: number): number {
  if (duration <= 60) return 5;
  if (duration <= 300) return 10;
  return 30;
}

function formatFreqLabel(freq: number): string {
  return freq >= 1000 ? `${freq / 1000}k` : String(freq);
}

export function SpectrogramOverlay({
  spectrogramUrl,
  metadata,
  boxes,
  selectedBoxId,
  editable,
  currentTime,
  onBoxClick,
  onDrawComplete,
  onSeekClick,
  onImageError,
}: SpectrogramOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [imgSize, setImgSize] = useState({ width: 0, height: 0 });
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const [zoomLevel, setZoomLevel] = useState<1 | 2 | 3>(1);
  const dragRef = useRef<DragState | null>(null);
  const [preview, setPreview] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);

  useEffect(() => {
    function updateSize() {
      if (imgRef.current) {
        setImgSize({
          width: imgRef.current.clientWidth,
          height: imgRef.current.clientHeight,
        });
      }
    }

    const img = imgRef.current;
    if (img) {
      if (img.complete) updateSize();
      img.addEventListener("load", updateSize);
    }

    const container = containerRef.current;
    let observer: ResizeObserver | undefined;
    if (container) {
      observer = new ResizeObserver(updateSize);
      observer.observe(container);
    }

    return () => {
      if (img) img.removeEventListener("load", updateSize);
      observer?.disconnect();
    };
  }, [spectrogramUrl, zoomLevel]);

  const toPixelCoords = useCallback(
    (clientX: number, clientY: number) => {
      const svg = svgRef.current;
      if (!svg || imgSize.width === 0) return { px: 0, py: 0 };
      const rect = svg.getBoundingClientRect();
      const px = Math.max(
        0,
        Math.min(imgSize.width, ((clientX - rect.left) / rect.width) * imgSize.width)
      );
      const py = Math.max(
        0,
        Math.min(imgSize.height, ((clientY - rect.top) / rect.height) * imgSize.height)
      );
      return { px, py };
    },
    [imgSize]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!editable || !onDrawComplete) return;
      if ((e.target as SVGElement).closest("[data-bbox]")) return;

      const { px, py } = toPixelCoords(e.clientX, e.clientY);
      dragRef.current = {
        startX: px,
        startY: py,
        currentX: px,
        currentY: py,
        hasDragged: false,
      };

      (e.target as SVGElement).setPointerCapture(e.pointerId);
    },
    [editable, onDrawComplete, toPixelCoords]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!dragRef.current) return;

      const { px, py } = toPixelCoords(e.clientX, e.clientY);
      dragRef.current.currentX = px;
      dragRef.current.currentY = py;

      const dx = Math.abs(px - dragRef.current.startX);
      const dy = Math.abs(py - dragRef.current.startY);

      if (!dragRef.current.hasDragged && Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
        dragRef.current.hasDragged = true;
      }

      if (dragRef.current.hasDragged) {
        const x = Math.min(dragRef.current.startX, px);
        const y = Math.min(dragRef.current.startY, py);
        const width = Math.abs(px - dragRef.current.startX);
        const height = Math.abs(py - dragRef.current.startY);
        setPreview({ x, y, width, height });
      }
    },
    [toPixelCoords]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      const drag = dragRef.current;
      dragRef.current = null;
      setPreview(null);

      if (!drag || !onDrawComplete) return;

      if (!drag.hasDragged) {
        // Single click -> seek
        if (onSeekClick && imgSize.width > 0) {
          const { px } = toPixelCoords(e.clientX, e.clientY);
          const time = pxToTime(px, imgSize.width, metadata.duration);
          onSeekClick(time);
        }
        return;
      }

      const x1 = Math.min(drag.startX, drag.currentX);
      const y1 = Math.min(drag.startY, drag.currentY);
      const x2 = Math.max(drag.startX, drag.currentX);
      const y2 = Math.max(drag.startY, drag.currentY);

      // Convert to real units
      const startTime = pxToTime(x1, imgSize.width, metadata.duration);
      const endTime = pxToTime(x2, imgSize.width, metadata.duration);
      const maxFreq = pxToFreq(y1, imgSize.height, metadata.fmin, metadata.fmax);
      const minFreq = pxToFreq(y2, imgSize.height, metadata.fmin, metadata.fmax);

      // Check minimum size
      if (endTime - startTime < MIN_TIME_S || maxFreq - minFreq < MIN_FREQ_HZ) {
        return;
      }

      onDrawComplete({ startTime, endTime, minFreq, maxFreq });
    },
    [onDrawComplete, onSeekClick, imgSize, metadata, toPixelCoords]
  );

  // Auto-scroll to keep playback cursor visible when zoomed
  useEffect(() => {
    const el = scrollRef.current;
    if (zoomLevel === 1 || !el || !currentTime || !imgSize.width || !metadata.duration) return;
    if (dragRef.current) return;

    const cursorX = timeToPx(currentTime, imgSize.width, metadata.duration);
    const viewLeft = el.scrollLeft;
    const viewRight = viewLeft + el.clientWidth;
    const margin = el.clientWidth * 0.15;

    if (cursorX > viewRight - margin || cursorX < viewLeft + margin) {
      el.scrollLeft = cursorX - el.clientWidth * 0.3;
    }
  }, [zoomLevel, currentTime, imgSize.width, metadata.duration]);

  // Compute frequency ticks filtered to metadata range
  const visibleFreqTicks = FREQ_TICKS.filter(
    (f) => f >= metadata.fmin && f <= metadata.fmax
  );

  // Compute time ticks
  const timeInterval = getTimeInterval(metadata.duration);
  const timeTicks: number[] = [];
  if (metadata.duration > 0) {
    for (let t = 0; t <= metadata.duration; t += timeInterval) {
      timeTicks.push(t);
    }
  }

  return (
    <div ref={containerRef}>
      <div className="flex">
        {/* Y-axis — outside the spectrogram, always visible */}
        <div
          className="shrink-0 relative"
          style={{ width: Y_AXIS_WIDTH, height: imgSize.height || undefined }}
        >
          {imgSize.height > 0 && visibleFreqTicks.map((freq) => {
            const top = Math.max(6, Math.min(
              imgSize.height - 6,
              freqToPx(freq, imgSize.height, metadata.fmin, metadata.fmax)
            ));
            return (
              <div
                key={freq}
                className="absolute right-0 flex items-center"
                style={{ top }}
              >
                <span className="text-xs text-muted-foreground pr-1 leading-none"
                      style={{ transform: "translateY(-50%)" }}>
                  {formatFreqLabel(freq)}
                </span>
                <span className="block w-1 h-px bg-border" />
              </div>
            );
          })}
        </div>

        {/* Spectrogram — 1x fits viewport, 2x scrolls horizontally */}
        <div ref={scrollRef} className={`flex-1 min-w-0 ${zoomLevel > 1 ? "overflow-x-auto" : ""}`}>
          <div className="relative bg-black" style={zoomLevel > 1 ? { width: `${zoomLevel * 100}%` } : undefined}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              ref={imgRef}
              src={spectrogramUrl}
              alt="Espectrograma"
              className={`block h-[300px] w-full ${zoomLevel > 1 ? "max-w-none" : ""}`}
              draggable={false}
              style={{ imageRendering: "auto" }}
              onError={onImageError}
            />

            {imgSize.width > 0 && (
              <svg
                ref={svgRef}
                className={`absolute inset-0 w-full h-full ${
                  editable ? "pointer-events-auto cursor-crosshair" : "pointer-events-none"
                }`}
                viewBox={`0 0 ${imgSize.width} ${imgSize.height}`}
                preserveAspectRatio="none"
                onPointerDown={editable ? handlePointerDown : undefined}
                onPointerMove={editable ? handlePointerMove : undefined}
                onPointerUp={editable ? handlePointerUp : undefined}
              >
                {/* Boxes */}
                {boxes.map((box, index) => {
                  const color = getSpeciesColor(box.species);
                  const isSelected = selectedBoxId === box.id;
                  const isHovered = hoveredId === box.id;
                  const highlight = isSelected || isHovered;

                  const px = timeToPx(box.startTime, imgSize.width, metadata.duration);
                  const py = freqToPx(box.maxFreq, imgSize.height, metadata.fmin, metadata.fmax);
                  const pw = timeToPx(box.endTime, imgSize.width, metadata.duration) - px;
                  const ph = freqToPx(box.minFreq, imgSize.height, metadata.fmin, metadata.fmax) - py;

                  const num = index + 1;

                  return (
                    <g
                      key={box.id}
                      data-bbox
                      className="pointer-events-auto cursor-pointer"
                      onMouseEnter={() => setHoveredId(box.id)}
                      onMouseLeave={() => setHoveredId(null)}
                      onClick={(e) => {
                        e.stopPropagation();
                        onBoxClick?.(box);
                      }}
                    >
                      <rect
                        x={px}
                        y={py}
                        width={pw}
                        height={ph}
                        fill="none"
                        stroke={color}
                        strokeWidth={highlight ? 3 : 2}
                        strokeOpacity={highlight ? 1 : 0.8}
                      />

                      {/* Number badge */}
                      <circle
                        cx={px + 10}
                        cy={py + 10}
                        r={9}
                        fill={isSelected ? color : "rgba(0,0,0,0.7)"}
                        stroke={color}
                        strokeWidth={1.5}
                      />
                      <text
                        x={px + 10}
                        y={py + 14}
                        fill="white"
                        fontSize={11}
                        fontFamily="system-ui, sans-serif"
                        fontWeight={600}
                        textAnchor="middle"
                      >
                        {num}
                      </text>

                      {/* Species label */}
                      {box.species && box.species !== "unknown" && (
                        <>
                          <rect
                            x={px}
                            y={py - 18}
                            width={Math.max(pw, 80)}
                            height={18}
                            fill={color}
                            fillOpacity={highlight ? 0.9 : 0.75}
                            rx={2}
                          />
                          <text
                            x={px + 4}
                            y={py - 5}
                            fill="white"
                            fontSize={11}
                            fontFamily="system-ui, sans-serif"
                            fontWeight={500}
                          >
                            {box.displayLabel || box.species}
                          </text>
                        </>
                      )}
                    </g>
                  );
                })}

                {/* Drawing preview */}
                {preview && (
                  <rect
                    x={preview.x}
                    y={preview.y}
                    width={preview.width}
                    height={preview.height}
                    fill="rgba(59, 130, 246, 0.15)"
                    stroke="#3b82f6"
                    strokeWidth={2}
                    strokeDasharray="6 3"
                  />
                )}

                {/* Playback cursor */}
                {currentTime != null &&
                  currentTime > 0 &&
                  metadata.duration > 0 && (
                    <line
                      x1={timeToPx(currentTime, imgSize.width, metadata.duration)}
                      y1={0}
                      x2={timeToPx(currentTime, imgSize.width, metadata.duration)}
                      y2={imgSize.height}
                      stroke="white"
                      strokeWidth={1.5}
                      strokeOpacity={0.8}
                    />
                  )}
              </svg>
            )}
          </div>

          {/* X-axis */}
          <div className="relative h-5" style={zoomLevel > 1 ? { width: imgSize.width || undefined } : undefined}>
            {imgSize.width > 0 && timeTicks.map((t) => {
              const left = timeToPx(t, imgSize.width, metadata.duration);
              const isFirst = t === 0;
              return (
                <span
                  key={t}
                  className="absolute text-xs text-muted-foreground leading-none"
                  style={{
                    left,
                    transform: isFirst ? undefined : "translateX(-50%)",
                    top: 2,
                  }}
                >
                  {t}s
                </span>
              );
            })}
          </div>
        </div>
      </div>

      {/* kHz label + zoom control */}
      <div className="flex items-center gap-3">
        <div className="shrink-0 flex items-center justify-center" style={{ width: Y_AXIS_WIDTH }}>
          <span className="text-[10px] text-muted-foreground">kHz</span>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-muted-foreground">Zoom</span>
          <div className="inline-flex rounded border border-border text-[11px] overflow-hidden">
            {([1, 2, 3] as const).map((level) => (
              <button
                key={level}
                type="button"
                onClick={() => setZoomLevel(level)}
                className={`px-2 py-0.5 transition-colors ${
                  level > 1 ? "border-l border-border" : ""
                } ${
                  zoomLevel === level
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted"
                }`}
              >
                {level}x
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
