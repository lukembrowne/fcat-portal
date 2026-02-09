"use client";

import { useEffect, useRef, useState } from "react";

export interface BBoxData {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  detectionConfidence: number;
  detectionClass: number;
  species?: string | null;
  speciesConfidence?: number | null;
  verificationStatus?: string;
}

interface BBoxOverlayProps {
  src: string;
  alt: string;
  boxes: BBoxData[];
  selectedBoxId?: number | null;
  onBoxClick?: (box: BBoxData) => void;
}

const SPECIES_COLORS: Record<string, string> = {};
const COLOR_PALETTE = [
  "#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#a855f7",
  "#06b6d4", "#f97316", "#ec4899", "#14b8a6", "#8b5cf6",
];

function getSpeciesColor(species: string | null | undefined): string {
  if (!species) return "#22c55e";
  if (!SPECIES_COLORS[species]) {
    const idx = Object.keys(SPECIES_COLORS).length % COLOR_PALETTE.length;
    SPECIES_COLORS[species] = COLOR_PALETTE[idx];
  }
  return SPECIES_COLORS[species];
}

const CLASS_COLORS: Record<number, string> = {
  0: "#22c55e",
  1: "#ef4444",
  2: "#3b82f6",
};

export function BBoxOverlay({
  src,
  alt,
  boxes,
  selectedBoxId,
  onBoxClick,
}: BBoxOverlayProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const [imgSize, setImgSize] = useState({ width: 0, height: 0 });
  const [hoveredId, setHoveredId] = useState<number | null>(null);

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

    window.addEventListener("resize", updateSize);
    return () => {
      if (img) img.removeEventListener("load", updateSize);
      window.removeEventListener("resize", updateSize);
    };
  }, [src]);

  return (
    <div className="relative inline-block w-full">
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        className="w-full h-auto block"
      />

      {imgSize.width > 0 && (
        <svg
          className="absolute inset-0 w-full h-full pointer-events-none"
          viewBox={`0 0 ${imgSize.width} ${imgSize.height}`}
          preserveAspectRatio="none"
        >
          {boxes.map((box) => {
            const color = box.species
              ? getSpeciesColor(box.species)
              : CLASS_COLORS[box.detectionClass] || "#22c55e";

            const isSelected = selectedBoxId === box.id;
            const isHovered = hoveredId === box.id;
            const highlight = isSelected || isHovered;

            const px = box.x * imgSize.width;
            const py = box.y * imgSize.height;
            const pw = box.width * imgSize.width;
            const ph = box.height * imgSize.height;

            return (
              <g
                key={box.id}
                className="pointer-events-auto cursor-pointer"
                onMouseEnter={() => setHoveredId(box.id)}
                onMouseLeave={() => setHoveredId(null)}
                onClick={() => onBoxClick?.(box)}
              >
                <rect
                  x={px} y={py} width={pw} height={ph}
                  fill="none" stroke={color}
                  strokeWidth={highlight ? 3 : 2}
                  strokeOpacity={highlight ? 1 : 0.8}
                />

                {(highlight || isSelected) && box.species && (
                  <>
                    <rect
                      x={px} y={py - 20}
                      width={Math.max(pw, 100)} height={20}
                      fill={color} fillOpacity={0.85} rx={2}
                    />
                    <text
                      x={px + 4} y={py - 6}
                      fill="white" fontSize={12}
                      fontFamily="system-ui, sans-serif" fontWeight={500}
                    >
                      {box.species}{" "}
                      {box.speciesConfidence != null &&
                        `${(box.speciesConfidence * 100).toFixed(0)}%`}
                    </text>
                  </>
                )}

                {!highlight && (
                  <>
                    <rect
                      x={px} y={py} width={36} height={16}
                      fill={color} fillOpacity={0.85} rx={2}
                    />
                    <text
                      x={px + 3} y={py + 12}
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
        </svg>
      )}
    </div>
  );
}
