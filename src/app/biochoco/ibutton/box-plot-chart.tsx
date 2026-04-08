"use client";

import { useMemo, useState } from "react";
import { boxPlotStats } from "@/lib/stats";
import type { DeploymentStatPoint } from "./types";

/**
 * Which per-deployment statistic to plot. Matches the field names on
 * DeploymentStatPoint so grouping logic can index into the point directly.
 */
export type TempStat = "tempMin" | "tempMean" | "tempMax";

export const TEMP_STAT_LABEL: Record<TempStat, string> = {
  tempMin: "Mínima",
  tempMean: "Promedio",
  tempMax: "Máxima",
};

/** Plain-language description of what each statistic represents. */
export const TEMP_STAT_DESCRIPTION: Record<TempStat, string> = {
  tempMin: "La temperatura más fría registrada en cada despliegue.",
  tempMean: "La temperatura promedio de cada despliegue.",
  tempMax: "La temperatura más caliente registrada en cada despliegue.",
};

export interface BoxPlotGroup {
  /** Key used to index the group (habitat code or site name). */
  key: string;
  /** Display label shown on the x-axis. */
  label: string;
  /** Fill color for the box. Falls back to neutral if omitted. */
  color?: string;
  /** All deployment points belonging to this group. */
  points: DeploymentStatPoint[];
}

interface BoxPlotChartProps {
  groups: BoxPlotGroup[];
  stat: TempStat;
  /** Chart title shown above the plot. */
  title: string;
  /** Optional one-line explanation shown under the title. */
  description?: string;
}

// ---------------------------------------------------------------------------
// Layout constants (pixel space; used as the SVG viewBox, so everything
// scales responsively via width="100%").
// ---------------------------------------------------------------------------
// Wide aspect ratio — each chart occupies a full row, so we stretch
// horizontally to keep the rendered height reasonable.
const VB_WIDTH = 1000;
const VB_HEIGHT = 240;
const PAD_TOP = 16;
const PAD_BOTTOM = 56; // leaves room for rotated x labels
const PAD_LEFT = 44;
const PAD_RIGHT = 16;
const PLOT_W = VB_WIDTH - PAD_LEFT - PAD_RIGHT;
const PLOT_H = VB_HEIGHT - PAD_TOP - PAD_BOTTOM;
const NEUTRAL_COLOR = "#94a3b8"; // slate-400

const TICK_COUNT = 5;
const POINT_RADIUS = 3.5;
const POINT_RADIUS_HOVER = 5;
const JITTER_SPREAD = 0.6; // fraction of box width

/** Deterministic jitter in [-0.5, 0.5], keyed by deployment id. */
function jitterFromId(id: number): number {
  const x = ((id * 9301 + 49297) % 233280) / 233280;
  return x - 0.5;
}

/** Build a "nice" set of axis ticks covering [min, max]. */
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
    // Guard against fp drift producing 24.999999
    out.push(Math.round(v * 1e6) / 1e6);
  }
  return out;
}

interface HoverPoint {
  /** SVG pixel coordinates of the circle center (for positioning tooltip). */
  cx: number;
  cy: number;
  point: DeploymentStatPoint;
  stat: TempStat;
}

export function BoxPlotChart({
  groups,
  stat,
  title,
  description,
}: BoxPlotChartProps) {
  const [hover, setHover] = useState<HoverPoint | null>(null);

  const { yMin, yMax, ticks, nonEmptyGroups } = useMemo(() => {
    const nonEmpty = groups.filter((g) => g.points.length > 0);
    if (nonEmpty.length === 0) {
      return { yMin: 0, yMax: 1, ticks: [0, 1], nonEmptyGroups: nonEmpty };
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (const g of nonEmpty) {
      for (const p of g.points) {
        const v = p[stat];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    // Pad domain a bit so points don't sit on the edges
    const pad = (hi - lo) * 0.08 || 1;
    const t = niceTicks(lo - pad, hi + pad, TICK_COUNT);
    return {
      yMin: t[0],
      yMax: t[t.length - 1],
      ticks: t,
      nonEmptyGroups: nonEmpty,
    };
  }, [groups, stat]);

  // --- scales ----
  const yScale = (v: number): number => {
    if (yMax === yMin) return PAD_TOP + PLOT_H / 2;
    return PAD_TOP + PLOT_H - ((v - yMin) / (yMax - yMin)) * PLOT_H;
  };

  const n = nonEmptyGroups.length;
  const bandWidth = n > 0 ? PLOT_W / n : PLOT_W;
  const boxWidth = Math.min(56, bandWidth * 0.5);
  const bandCenter = (i: number): number =>
    PAD_LEFT + bandWidth * (i + 0.5);

  if (n === 0) {
    return (
      <div className="rounded-md border bg-card p-4">
        <h3 className="mb-2 text-sm font-semibold">{title}</h3>
        <p className="text-sm text-muted-foreground">No hay datos.</p>
      </div>
    );
  }

  return (
    <div className="relative rounded-md border bg-card p-3">
      <h3 className="text-sm font-semibold">{title}</h3>
      {description && (
        <p className="mt-0.5 mb-1 text-xs text-muted-foreground">
          {description}
        </p>
      )}
      <svg
        viewBox={`0 0 ${VB_WIDTH} ${VB_HEIGHT}`}
        width="100%"
        role="img"
        aria-label={`Distribución de temperatura ${title.toLowerCase()} por grupo`}
        className="overflow-visible"
      >
        {/* Y-axis grid + ticks */}
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
                {t.toFixed(1)}
              </text>
            </g>
          );
        })}
        {/* Y-axis unit label */}
        <text
          x={PAD_LEFT - 32}
          y={PAD_TOP + PLOT_H / 2}
          textAnchor="middle"
          fontSize={10}
          fill="currentColor"
          className="text-muted-foreground"
          transform={`rotate(-90 ${PAD_LEFT - 32} ${PAD_TOP + PLOT_H / 2})`}
        >
          °C
        </text>

        {/* Groups */}
        {nonEmptyGroups.map((g, i) => {
          const values = g.points.map((p) => p[stat]);
          const s = boxPlotStats(values);
          if (!s) return null;
          const cx = bandCenter(i);
          const fill = g.color ?? NEUTRAL_COLOR;
          const isSingle = s.n === 1;

          return (
            <g key={g.key}>
              {/* Whiskers + box (skip for n=1) */}
              {!isSingle && (
                <>
                  {/* Vertical whisker line */}
                  <line
                    x1={cx}
                    x2={cx}
                    y1={yScale(s.whiskerHigh)}
                    y2={yScale(s.whiskerLow)}
                    stroke={fill}
                    strokeOpacity={0.6}
                  />
                  {/* Top whisker cap */}
                  <line
                    x1={cx - boxWidth / 4}
                    x2={cx + boxWidth / 4}
                    y1={yScale(s.whiskerHigh)}
                    y2={yScale(s.whiskerHigh)}
                    stroke={fill}
                    strokeOpacity={0.6}
                  />
                  {/* Bottom whisker cap */}
                  <line
                    x1={cx - boxWidth / 4}
                    x2={cx + boxWidth / 4}
                    y1={yScale(s.whiskerLow)}
                    y2={yScale(s.whiskerLow)}
                    stroke={fill}
                    strokeOpacity={0.6}
                  />
                  {/* Box */}
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
                  {/* Median line */}
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

              {/* Jittered points */}
              {g.points.map((p) => {
                const j = jitterFromId(p.deploymentId);
                const px = cx + j * boxWidth * JITTER_SPREAD;
                const py = yScale(p[stat]);
                const isHovered =
                  hover?.point.deploymentId === p.deploymentId &&
                  hover?.stat === stat;
                return (
                  <circle
                    key={p.deploymentId}
                    cx={px}
                    cy={py}
                    r={isHovered ? POINT_RADIUS_HOVER : POINT_RADIUS}
                    fill={fill}
                    fillOpacity={0.9}
                    stroke="#fff"
                    strokeWidth={1}
                    style={{ cursor: "pointer" }}
                    onMouseEnter={() =>
                      setHover({ cx: px, cy: py, point: p, stat })
                    }
                    onMouseLeave={() => setHover(null)}
                  >
                    <title>
                      {p.deploymentName}
                      {p.siteName ? ` · ${p.siteName}` : ""}
                      {` · ${TEMP_STAT_LABEL[stat]}: ${p[stat].toFixed(1)}°C`}
                    </title>
                  </circle>
                );
              })}

              {/* X-axis label */}
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
              </text>
            </g>
          );
        })}

        {/* Base X axis line */}
        <line
          x1={PAD_LEFT}
          x2={PAD_LEFT + PLOT_W}
          y1={PAD_TOP + PLOT_H}
          y2={PAD_TOP + PLOT_H}
          stroke="currentColor"
          strokeOpacity={0.25}
        />
      </svg>

      {/* Floating tooltip */}
      {hover && (
        <div
          className="pointer-events-none absolute z-10 rounded-md border bg-popover px-2 py-1 text-xs shadow-md"
          style={{
            left: `${(hover.cx / VB_WIDTH) * 100}%`,
            top: `${(hover.cy / VB_HEIGHT) * 100}%`,
            transform: "translate(-50%, calc(-100% - 8px))",
          }}
        >
          <div className="font-semibold">{hover.point.deploymentName}</div>
          {hover.point.siteName && (
            <div className="text-muted-foreground">{hover.point.siteName}</div>
          )}
          <div>
            {TEMP_STAT_LABEL[hover.stat]}:{" "}
            <span className="font-mono">
              {hover.point[hover.stat].toFixed(1)}°C
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
