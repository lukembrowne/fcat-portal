"use client";

import { useEffect, useRef, useState, useCallback } from "react";

export interface BBoxData {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  detectionConfidence: number;
  detectionClass: number;
  species?: string | null;
  displayLabel?: string | null;
  speciesConfidence?: number | null;
  verificationStatus?: string;
}

interface BBoxOverlayProps {
  src: string;
  alt: string;
  boxes: BBoxData[];
  selectedBoxId?: number | null;
  onBoxClick?: (box: BBoxData) => void;
  editable?: boolean;
  onDrawComplete?: (bbox: { x: number; y: number; width: number; height: number }) => void;
  /** Fires whenever the rendered image's pixel dimensions change. Lets
   *  parents position absolute overlays against the same coordinate space. */
  onResize?: (size: { width: number; height: number }) => void;
  /** Optional CSS filter applied only to the underlying <img>. The SVG
   *  overlay (boxes, labels) is intentionally unfiltered so selection
   *  colors stay readable when the user dims the image. */
  imageFilter?: string;
}

// Bbox stroke/badge color encodes verification status, not species.
//   verified  → emerald (human-confirmed)
//   corrected → blue    (human-corrected species)
//   rejected  → red
//   unverified (or any other) → amber (needs review)
//   no species/identification → gray (raw detection or manual draw)
function verificationColor(box: BBoxData): string {
  if (!box.species) return "#9ca3af";
  switch (box.verificationStatus) {
    case "verified":
      return "#10b981";
    case "corrected":
      return "#3b82f6";
    case "rejected":
      return "#ef4444";
    default:
      return "#f59e0b";
  }
}

const DRAG_THRESHOLD = 5;
const MIN_BOX_PX = 10;

interface DragState {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  hasDragged: boolean;
}

function normalizeRect(
  startX: number,
  startY: number,
  endX: number,
  endY: number
) {
  return {
    x: Math.min(startX, endX),
    y: Math.min(startY, endY),
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY),
  };
}

export function BBoxOverlay({
  src,
  alt,
  boxes,
  selectedBoxId,
  onBoxClick,
  editable = false,
  onDrawComplete,
  onResize,
  imageFilter,
}: BBoxOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [imgSize, setImgSize] = useState({ width: 0, height: 0 });
  const [hoveredId, setHoveredId] = useState<number | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const [preview, setPreview] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const onResizeRef = useRef(onResize);
  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);

  useEffect(() => {
    function updateSize() {
      if (imgRef.current) {
        const next = {
          width: imgRef.current.clientWidth,
          height: imgRef.current.clientHeight,
        };
        setImgSize(next);
        onResizeRef.current?.(next);
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
  }, [src]);

  const toNormalized = useCallback(
    (clientX: number, clientY: number) => {
      const svg = svgRef.current;
      if (!svg || imgSize.width === 0) return { nx: 0, ny: 0 };
      const rect = svg.getBoundingClientRect();
      const nx = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const ny = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
      return { nx, ny };
    },
    [imgSize]
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!editable || !onDrawComplete) return;
      // Only start drawing if clicking on the SVG background, not on a box
      if ((e.target as SVGElement).closest("[data-bbox]")) return;

      const { nx, ny } = toNormalized(e.clientX, e.clientY);
      dragRef.current = {
        startX: nx,
        startY: ny,
        currentX: nx,
        currentY: ny,
        hasDragged: false,
      };

      (e.target as SVGElement).setPointerCapture(e.pointerId);
    },
    [editable, onDrawComplete, toNormalized]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<SVGSVGElement>) => {
      if (!dragRef.current) return;

      const { nx, ny } = toNormalized(e.clientX, e.clientY);
      dragRef.current.currentX = nx;
      dragRef.current.currentY = ny;

      const dx = Math.abs(nx - dragRef.current.startX) * imgSize.width;
      const dy = Math.abs(ny - dragRef.current.startY) * imgSize.height;

      if (!dragRef.current.hasDragged && Math.sqrt(dx * dx + dy * dy) > DRAG_THRESHOLD) {
        dragRef.current.hasDragged = true;
      }

      if (dragRef.current.hasDragged) {
        setPreview(
          normalizeRect(
            dragRef.current.startX,
            dragRef.current.startY,
            nx,
            ny
          )
        );
      }
    },
    [toNormalized, imgSize]
  );

  const handlePointerUp = useCallback(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    (_e: React.PointerEvent<SVGSVGElement>) => {
      const drag = dragRef.current;
      dragRef.current = null;
      setPreview(null);

      if (!drag || !drag.hasDragged || !onDrawComplete) return;

      const rect = normalizeRect(
        drag.startX,
        drag.startY,
        drag.currentX,
        drag.currentY
      );

      // Check minimum size in pixels
      if (
        rect.width * imgSize.width < MIN_BOX_PX ||
        rect.height * imgSize.height < MIN_BOX_PX
      ) {
        return;
      }

      onDrawComplete(rect);
    },
    [onDrawComplete, imgSize]
  );

  return (
    <div ref={containerRef} className="relative inline-block max-w-full max-h-full">
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        className="max-w-full max-h-full h-auto w-auto block"
        draggable={false}
        style={imageFilter ? { filter: imageFilter } : undefined}
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
          {boxes.map((box, index) => {
            const color = verificationColor(box);

            const isSelected = selectedBoxId === box.id;
            const isHovered = hoveredId === box.id;
            const highlight = isSelected || isHovered;

            const px = box.x * imgSize.width;
            const py = box.y * imgSize.height;
            const pw = box.width * imgSize.width;
            const ph = box.height * imgSize.height;

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
                  x={px} y={py} width={pw} height={ph}
                  fill="none" stroke={color}
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

                {/* Species label — always visible when species is assigned */}
                {box.species && box.species !== "unknown" && (() => {
                  const isHumanVerified =
                    box.verificationStatus === "verified" ||
                    box.verificationStatus === "corrected";
                  // Flip label inside the box when there's no room above
                  const labelAbove = py >= 20;
                  const labelRectY = labelAbove ? py - 20 : py;
                  const labelTextY = labelAbove ? py - 6 : py + 14;
                  // When flipped inside, shift text to avoid the number badge
                  const textX = labelAbove ? px + 4 : px + 22;
                  return (
                    <>
                      <rect
                        x={px} y={labelRectY}
                        width={Math.max(pw, 100)} height={20}
                        fill={color} fillOpacity={highlight ? 0.9 : 0.75} rx={2}
                      />
                      <text
                        x={textX} y={labelTextY}
                        fill="white" fontSize={12}
                        fontFamily="system-ui, sans-serif" fontWeight={500}
                      >
                        {box.displayLabel || box.species}{" "}
                        {isHumanVerified
                          ? "✓"
                          : box.speciesConfidence != null &&
                            `${(box.speciesConfidence * 100).toFixed(0)}%`}
                      </text>
                    </>
                  );
                })()}

                {/* Confidence badge — show when no species label or not highlighted */}
                {(!box.species || box.species === "unknown") && !highlight && (
                  <>
                    <rect
                      x={px + 22} y={py} width={36} height={16}
                      fill={color} fillOpacity={0.85} rx={2}
                    />
                    <text
                      x={px + 25} y={py + 12}
                      fill="white" fontSize={10}
                      fontFamily="system-ui, sans-serif"
                    >
                      {(box.detectionConfidence * 100).toFixed(0)}%
                    </text>
                  </>
                )}
              </g>
            );
          })}

          {/* Drawing preview */}
          {preview && (
            <rect
              x={preview.x * imgSize.width}
              y={preview.y * imgSize.height}
              width={preview.width * imgSize.width}
              height={preview.height * imgSize.height}
              fill="rgba(59, 130, 246, 0.15)"
              stroke="#3b82f6"
              strokeWidth={2}
              strokeDasharray="6 3"
            />
          )}
        </svg>
      )}
    </div>
  );
}
