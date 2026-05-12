"use client";

import { memo, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  isCellUnscanned,
  metricToFill,
  RASTER_METRIC_LABELS,
  type RasterCell,
  type RasterMetricKey,
  type ScaleDomain,
} from "@/lib/recordings-raster";

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const PAD_TOP = 24;
const PAD_BOTTOM = 8;
const PAD_LEFT = 56;
const PAD_RIGHT = 8;
const PLOT_H = 1200;
const DAY_COL_W = 32;
const CELL_H = PLOT_H / 288;            // 5-min-worth of plot height
const HOUR_TICKS = [0, 3, 6, 9, 12, 15, 18, 21] as const;

// Civil twilight bands in Ecuador (no DST). Minutes since midnight, local UTC-5.
const DAWN_START = 5 * 60 + 30;
const DAWN_END = 6 * 60 + 15;
const DUSK_START = 17 * 60 + 45;
const DUSK_END = 18 * 60 + 30;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  cells: RasterCell[];
  dates: string[];
  domain: ScaleDomain;
  metricKey: RasterMetricKey;
  onClickCell: (cell: RasterCell) => void;
}

interface HoverState {
  cell: RasterCell;
  clientX: number;
  clientY: number;
}

export function RecordingsRaster({
  cells,
  dates,
  domain,
  metricKey,
  onClickCell,
}: Props) {
  const [hover, setHover] = useState<HoverState | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const cellsById = useMemo(
    () => new Map(cells.map((c) => [c.fileId, c])),
    [cells]
  );

  // Land the viewport on the newest day (right edge) on mount and whenever the
  // deployment's date range changes.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [dates.length]);

  function findCell(e: MouseEvent): RasterCell | null {
    const rect = (e.target as Element).closest("rect[data-id]");
    if (!rect) return null;
    const id = Number((rect as SVGRectElement).dataset.id);
    return cellsById.get(id) ?? null;
  }

  function handleMouseMove(e: MouseEvent) {
    const cell = findCell(e);
    if (!cell) {
      if (hover) setHover(null);
      return;
    }
    setHover({ cell, clientX: e.clientX, clientY: e.clientY });
  }

  function handleClick(e: MouseEvent) {
    const cell = findCell(e);
    if (cell) onClickCell(cell);
  }

  const plotW = Math.max(1, dates.length) * DAY_COL_W;
  const width = PAD_LEFT + plotW + PAD_RIGHT;
  const height = PAD_TOP + PLOT_H + PAD_BOTTOM;

  return (
    <div className="relative">
      <div ref={scrollRef} className="overflow-x-auto rounded-md border bg-card">
        <svg
          width={width}
          height={height}
          role="img"
          aria-label="Mapa de grabaciones por día y hora del día"
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHover(null)}
          onClick={handleClick}
          className="block select-none"
        >
          {/* Plot background */}
          <rect
            x={PAD_LEFT}
            y={PAD_TOP}
            width={plotW}
            height={PLOT_H}
            fill="var(--background)"
            stroke="var(--border)"
            strokeWidth={0.5}
            pointerEvents="none"
          />

          {/* Dawn & dusk bands */}
          <rect
            x={PAD_LEFT}
            y={PAD_TOP + (DAWN_START / 1440) * PLOT_H}
            width={plotW}
            height={((DAWN_END - DAWN_START) / 1440) * PLOT_H}
            fill="oklch(0.92 0.08 80)"
            fillOpacity={0.25}
            pointerEvents="none"
          />
          <rect
            x={PAD_LEFT}
            y={PAD_TOP + (DUSK_START / 1440) * PLOT_H}
            width={plotW}
            height={((DUSK_END - DUSK_START) / 1440) * PLOT_H}
            fill="oklch(0.92 0.08 80)"
            fillOpacity={0.25}
            pointerEvents="none"
          />

          {/* Hour grid + labels */}
          {HOUR_TICKS.map((h) => {
            const y = PAD_TOP + (h / 24) * PLOT_H;
            return (
              <g key={`h-${h}`} pointerEvents="none">
                <line
                  x1={PAD_LEFT}
                  x2={PAD_LEFT + plotW}
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  strokeOpacity={0.08}
                />
                <text
                  x={PAD_LEFT - 6}
                  y={y}
                  textAnchor="end"
                  dominantBaseline="middle"
                  fontSize={10}
                  fill="currentColor"
                  className="text-muted-foreground"
                >
                  {h.toString().padStart(2, "0")}:00
                </text>
              </g>
            );
          })}

          {/* Day labels (top) */}
          {dates.map((d, i) => (
            <text
              key={d}
              x={PAD_LEFT + i * DAY_COL_W + DAY_COL_W / 2}
              y={PAD_TOP - 6}
              textAnchor="middle"
              fontSize={9}
              fill="currentColor"
              className="text-muted-foreground"
              pointerEvents="none"
            >
              {d.slice(8, 10)}/{d.slice(5, 7)}
            </text>
          ))}

          {/* Cell layer (memoized — never re-renders on hover) */}
          <CellLayer cells={cells} domain={domain} />
        </svg>
      </div>

      {/* Tooltip */}
      {hover && (
        <Tooltip hover={hover} metricKey={metricKey} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Memoized cell layer
// ---------------------------------------------------------------------------

const CELL_W = DAY_COL_W - 0.5;

const CellLayer = memo(function CellLayer({
  cells,
  domain,
}: {
  cells: RasterCell[];
  domain: ScaleDomain;
}) {
  return (
    <g>
      {cells.map((cell) => {
        const x = PAD_LEFT + cell.dayIndex * DAY_COL_W;
        const y = PAD_TOP + (cell.minuteOfDay / 1440) * PLOT_H;
        const unscanned = isCellUnscanned(cell.metricValue, domain);
        return (
          <rect
            key={cell.fileId}
            data-id={cell.fileId}
            x={x}
            y={y}
            width={CELL_W}
            height={CELL_H}
            fill={metricToFill(cell.metricValue, domain)}
            stroke={unscanned ? "var(--border)" : "none"}
            strokeWidth={unscanned ? 0.5 : 0}
            style={{ cursor: "pointer" }}
          />
        );
      })}
    </g>
  );
});

// ---------------------------------------------------------------------------
// Tooltip (positioned at the cursor)
// ---------------------------------------------------------------------------

function Tooltip({
  hover,
  metricKey,
}: {
  hover: HoverState;
  metricKey: RasterMetricKey;
}) {
  return (
    <div
      className="pointer-events-none fixed z-50 rounded-md border bg-popover px-2 py-1 text-xs shadow-md"
      style={{
        left: hover.clientX + 12,
        top: hover.clientY + 12,
        maxWidth: 320,
      }}
    >
      <div className="font-mono text-[11px] truncate">{hover.cell.filename}</div>
      <div className="text-muted-foreground">
        {hover.cell.recordedDate} {hover.cell.recordedTime}
      </div>
      <div>
        {RASTER_METRIC_LABELS[metricKey]}:{" "}
        {hover.cell.metricValue === null ? (
          <span className="text-muted-foreground italic">Sin escanear</span>
        ) : (
          <span className="font-mono tabular-nums">
            {formatMetric(metricKey, hover.cell.metricValue)}
          </span>
        )}
      </div>
      {hover.cell.detectionCount > 0 && metricKey !== "detectionCount" && (
        <div className="text-muted-foreground">
          {hover.cell.detectionCount} detecciones
        </div>
      )}
    </div>
  );
}

function formatMetric(key: RasterMetricKey, value: number): string {
  if (key === "detectionCount") return value.toLocaleString();
  return value.toFixed(3);
}
