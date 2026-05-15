"use client";

import { useMemo, useState, type ReactNode } from "react";
import { boxPlotStats } from "@/lib/stats";

/**
 * A single sample plotted inside a {@link BoxPlotGroup}. The `id` must be
 * stable per point (used for deterministic jitter and React keys).
 */
export interface BoxPlotPoint {
  id: number;
  value: number;
  /** Bold first line in the hover tooltip. */
  primaryLabel?: string;
  /** Smaller second line in the tooltip. */
  secondaryLabel?: string;
  /** Muted footnote line under the value. */
  footnote?: string;
}

export interface BoxPlotGroup {
  key: string;
  /** Display label on the x-axis. */
  label: string;
  /** Optional fill color (defaults to slate-400). */
  color?: string;
  points: BoxPlotPoint[];
}

export type BoxPlotDirection = "up" | "down" | "neutral";

interface BoxPlotProps {
  groups: BoxPlotGroup[];
  title: string;
  description?: string;
  /** Optional small caption with an arrow indicator (used for acoustic indices). */
  expectedDirection?: BoxPlotDirection;
  expectedDirectionLabel?: string;
  /** Rotated unit label on the y-axis (e.g. "°C", "ACI"). */
  unitLabel?: string;
  /** Label inserted into the tooltip and aria description (e.g. "ACI", "Mínima"). */
  valueLabel: string;
  /** Formats values shown in the tooltip and (by default) the y ticks. */
  formatValue?: (value: number) => string;
  /** Overrides the tick formatter when ticks need a different format than the tooltip. */
  formatTickLabel?: (value: number) => string;
  /** Groups with fewer than this many points are dimmed to signal low coverage. 0 disables. */
  lowCoverageThreshold?: number;
  /** Shown when no group has data. */
  emptyMessage?: string;
}

// Shared visual constants — kept on this side so callers can't drift apart again.
const VB_WIDTH = 1000;
const VB_HEIGHT = 240;
const PAD_TOP = 16;
const PAD_BOTTOM = 64;
const PAD_LEFT = 56;
const PAD_RIGHT = 16;
const PLOT_W = VB_WIDTH - PAD_LEFT - PAD_RIGHT;
const PLOT_H = VB_HEIGHT - PAD_TOP - PAD_BOTTOM;
const NEUTRAL_COLOR = "#94a3b8"; // slate-400
const TICK_COUNT = 5;
const POINT_RADIUS = 3.5;
const POINT_RADIUS_HOVER = 5;
const JITTER_SPREAD = 0.6;
const MAX_BOX_WIDTH = 64;

const DIRECTION_ARROW: Record<BoxPlotDirection, string> = {
  up: "↑",
  down: "↓",
  neutral: "≈",
};

function jitterFromId(id: number): number {
  const x = ((id * 9301 + 49297) % 233280) / 233280;
  return x - 0.5;
}

function defaultFormat(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1000) return v.toExponential(1);
  if (Math.abs(v) >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

function niceTicks(min: number, max: number, count: number): number[] {
  if (min === max) {
    const pad = Math.max(1, Math.abs(min) * 0.1);
    return niceTicks(min - pad, max + pad, count);
  }
  const range = max - min;
  const raw = range / Math.max(1, count - 1);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  let step: number;
  if (norm < 1.5) step = 1 * mag;
  else if (norm < 3) step = 2 * mag;
  else if (norm < 7) step = 5 * mag;
  else step = 10 * mag;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) {
    out.push(Math.round(v * 1e6) / 1e6);
  }
  return out;
}

interface HoverState {
  cx: number;
  cy: number;
  point: BoxPlotPoint;
  groupLabel: string;
}

/**
 * Unified box plot. Used by acoustic indices, temperature distributions, and
 * any future cross-habitat comparison chart. The component is intentionally
 * dumb about domain semantics — callers shape their data into
 * {@link BoxPlotGroup} / {@link BoxPlotPoint} and pick labels/colors.
 */
export function BoxPlot({
  groups,
  title,
  description,
  expectedDirection,
  expectedDirectionLabel,
  unitLabel,
  valueLabel,
  formatValue = defaultFormat,
  formatTickLabel,
  lowCoverageThreshold = 0,
  emptyMessage = "No hay datos.",
}: BoxPlotProps) {
  const [hover, setHover] = useState<HoverState | null>(null);
  const tickFormatter = formatTickLabel ?? formatValue;

  const { yMin, yMax, ticks, nonEmptyGroups } = useMemo(() => {
    const nonEmpty = groups.filter((g) => g.points.length > 0);
    if (nonEmpty.length === 0) {
      return { yMin: 0, yMax: 1, ticks: [0, 1], nonEmptyGroups: nonEmpty };
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (const g of nonEmpty) {
      for (const p of g.points) {
        if (!Number.isFinite(p.value)) continue;
        if (p.value < lo) lo = p.value;
        if (p.value > hi) hi = p.value;
      }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
      return { yMin: 0, yMax: 1, ticks: [0, 1], nonEmptyGroups: nonEmpty };
    }
    const pad = (hi - lo) * 0.08 || 1;
    const t = niceTicks(lo - pad, hi + pad, TICK_COUNT);
    return {
      yMin: t[0],
      yMax: t[t.length - 1],
      ticks: t,
      nonEmptyGroups: nonEmpty,
    };
  }, [groups]);

  const yScale = (v: number): number => {
    if (yMax === yMin) return PAD_TOP + PLOT_H / 2;
    return PAD_TOP + PLOT_H - ((v - yMin) / (yMax - yMin)) * PLOT_H;
  };

  const n = nonEmptyGroups.length;
  const bandWidth = n > 0 ? PLOT_W / n : PLOT_W;
  const boxWidth = Math.min(MAX_BOX_WIDTH, bandWidth * 0.5);
  const bandCenter = (i: number): number => PAD_LEFT + bandWidth * (i + 0.5);

  return (
    <div className="relative rounded-md border bg-card p-3">
      <div className="mb-1.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        {description && (
          <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
        )}
        {expectedDirection && expectedDirectionLabel && (
          <p className="mt-0.5 text-xs text-muted-foreground">
            <span aria-hidden className="mr-1">
              {DIRECTION_ARROW[expectedDirection]}
            </span>
            {expectedDirectionLabel}
          </p>
        )}
      </div>

      {n === 0 ? (
        <p className="text-sm text-muted-foreground">{emptyMessage}</p>
      ) : (
        <svg
          viewBox={`0 0 ${VB_WIDTH} ${VB_HEIGHT}`}
          width="100%"
          role="img"
          aria-label={`Distribución de ${valueLabel.toLowerCase()} en ${title.toLowerCase()}`}
          className="overflow-visible"
        >
          {ticks.map((t) => {
            const y = yScale(t);
            return (
              <g key={`tick-${t}`}>
                <line
                  x1={PAD_LEFT}
                  x2={PAD_LEFT + PLOT_W}
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  strokeOpacity={0.1}
                  strokeDasharray="3 3"
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
                  {tickFormatter(t)}
                </text>
              </g>
            );
          })}
          {unitLabel && (
            <text
              x={PAD_LEFT - 44}
              y={PAD_TOP + PLOT_H / 2}
              textAnchor="middle"
              fontSize={10}
              fill="currentColor"
              className="text-muted-foreground"
              transform={`rotate(-90 ${PAD_LEFT - 44} ${PAD_TOP + PLOT_H / 2})`}
            >
              {unitLabel}
            </text>
          )}

          {nonEmptyGroups.map((g, i) => {
            const values = g.points.map((p) => p.value).filter(Number.isFinite);
            const s = boxPlotStats(values);
            if (!s) return null;
            const cx = bandCenter(i);
            const fill = g.color ?? NEUTRAL_COLOR;
            const isSingle = s.n === 1;
            const isLowCoverage =
              lowCoverageThreshold > 0 && s.n < lowCoverageThreshold;
            const groupOpacity = isLowCoverage ? 0.4 : 1;

            return (
              <g key={g.key} opacity={groupOpacity}>
                {!isSingle && (
                  <>
                    <line
                      x1={cx}
                      x2={cx}
                      y1={yScale(s.whiskerHigh)}
                      y2={yScale(s.whiskerLow)}
                      stroke={fill}
                      strokeOpacity={0.6}
                    />
                    <line
                      x1={cx - boxWidth / 4}
                      x2={cx + boxWidth / 4}
                      y1={yScale(s.whiskerHigh)}
                      y2={yScale(s.whiskerHigh)}
                      stroke={fill}
                      strokeOpacity={0.6}
                    />
                    <line
                      x1={cx - boxWidth / 4}
                      x2={cx + boxWidth / 4}
                      y1={yScale(s.whiskerLow)}
                      y2={yScale(s.whiskerLow)}
                      stroke={fill}
                      strokeOpacity={0.6}
                    />
                    <rect
                      x={cx - boxWidth / 2}
                      y={yScale(s.q3)}
                      width={boxWidth}
                      height={Math.max(1, yScale(s.q1) - yScale(s.q3))}
                      fill={fill}
                      fillOpacity={0.18}
                      stroke={fill}
                      strokeWidth={1.5}
                    />
                    <line
                      x1={cx - boxWidth / 2}
                      x2={cx + boxWidth / 2}
                      y1={yScale(s.median)}
                      y2={yScale(s.median)}
                      stroke={fill}
                      strokeWidth={2}
                    />
                  </>
                )}

                {g.points.map((p) => {
                  if (!Number.isFinite(p.value)) return null;
                  const j = jitterFromId(p.id);
                  const px = cx + j * boxWidth * JITTER_SPREAD;
                  const py = yScale(p.value);
                  const isHovered = hover?.point.id === p.id;
                  return (
                    <circle
                      key={p.id}
                      cx={px}
                      cy={py}
                      r={isHovered ? POINT_RADIUS_HOVER : POINT_RADIUS}
                      fill={fill}
                      fillOpacity={0.9}
                      stroke="#fff"
                      strokeWidth={1}
                      style={{ cursor: "pointer" }}
                      onMouseEnter={() =>
                        setHover({
                          cx: px,
                          cy: py,
                          point: p,
                          groupLabel: g.label,
                        })
                      }
                      onMouseLeave={() => setHover(null)}
                    >
                      <title>
                        {`${p.primaryLabel ?? g.label}${p.secondaryLabel ? ` · ${p.secondaryLabel}` : ""} · ${valueLabel}: ${formatValue(p.value)}${p.footnote ? ` · ${p.footnote}` : ""}`}
                      </title>
                    </circle>
                  );
                })}

                <text
                  x={cx}
                  y={VB_HEIGHT - PAD_BOTTOM + 14}
                  textAnchor="end"
                  fontSize={10}
                  fill="currentColor"
                  transform={`rotate(-30 ${cx} ${VB_HEIGHT - PAD_BOTTOM + 14})`}
                >
                  {g.label}
                </text>
                <text
                  x={cx}
                  y={VB_HEIGHT - PAD_BOTTOM + 26}
                  textAnchor="end"
                  fontSize={9}
                  fill="currentColor"
                  fillOpacity={0.55}
                  transform={`rotate(-30 ${cx} ${VB_HEIGHT - PAD_BOTTOM + 26})`}
                >
                  n={s.n}
                  {isLowCoverage ? " (cobertura baja)" : ""}
                </text>
              </g>
            );
          })}

          <line
            x1={PAD_LEFT}
            x2={PAD_LEFT + PLOT_W}
            y1={PAD_TOP + PLOT_H}
            y2={PAD_TOP + PLOT_H}
            stroke="currentColor"
            strokeOpacity={0.25}
          />
        </svg>
      )}

      {hover && (
        <BoxPlotTooltip
          hover={hover}
          valueLabel={valueLabel}
          formatValue={formatValue}
        />
      )}
    </div>
  );
}

function BoxPlotTooltip({
  hover,
  valueLabel,
  formatValue,
}: {
  hover: HoverState;
  valueLabel: string;
  formatValue: (value: number) => string;
}): ReactNode {
  return (
    <div
      className="pointer-events-none absolute z-10 rounded-md border bg-popover px-2 py-1 text-xs shadow-md"
      style={{
        left: `${(hover.cx / VB_WIDTH) * 100}%`,
        top: `${(hover.cy / VB_HEIGHT) * 100}%`,
        transform: "translate(-50%, calc(-100% - 8px))",
      }}
    >
      <div className="font-semibold">
        {hover.point.primaryLabel ?? hover.groupLabel}
      </div>
      {hover.point.secondaryLabel && (
        <div className="text-muted-foreground">
          {hover.point.secondaryLabel}
        </div>
      )}
      <div>
        {valueLabel}:{" "}
        <span className="font-mono">{formatValue(hover.point.value)}</span>
      </div>
      {hover.point.footnote && (
        <div className="text-muted-foreground">{hover.point.footnote}</div>
      )}
    </div>
  );
}
