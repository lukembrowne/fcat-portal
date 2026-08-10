/**
 * Fitted score→accuracy curve with the 95% threshold marked.
 *
 * Inline SVG rather than a chart library: the plot is one curve, one vertical
 * marker, and a band. Server-rendered, so no client bundle cost.
 */

import { curvePoints } from "./fit-summary";

const W = 520;
const H = 220;
const PAD_L = 44;
const PAD_R = 12;
const PAD_T = 12;
const PAD_B = 32;

const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;

/** Score 0.1–1.0 → pixel x. */
const sx = (conf: number) => PAD_L + ((conf - 0.1) / 0.9) * PLOT_W;
/** Probability 0–1 → pixel y (inverted). */
const sy = (p: number) => PAD_T + (1 - p) * PLOT_H;

interface FitChartProps {
  intercept: number;
  slope: number;
  thresholdConf95: number | null;
  ciLower: number | null;
  ciUpper: number | null;
  /** Reviewed observations, plotted as outcome dots along the top and bottom. */
  observations: Array<{ conf: number; correct: boolean }>;
}

export function FitChart({
  intercept,
  slope,
  thresholdConf95,
  ciLower,
  ciUpper,
  observations,
}: FitChartProps) {
  const pts = curvePoints(intercept, slope, 120);
  const path = pts
    .map((pt, i) => `${i === 0 ? "M" : "L"}${sx(pt.conf).toFixed(2)},${sy(pt.p).toFixed(2)}`)
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full max-w-full"
      role="img"
      aria-label="Curva ajustada de probabilidad frente a confianza de BirdNET"
    >
      {/* Horizontal guides at 0.5, 0.9, 0.95 */}
      {[0.5, 0.9, 0.95].map((p) => (
        <g key={p}>
          <line
            x1={PAD_L}
            x2={W - PAD_R}
            y1={sy(p)}
            y2={sy(p)}
            stroke="currentColor"
            strokeOpacity={p === 0.95 ? 0.35 : 0.12}
            strokeDasharray={p === 0.95 ? "4 3" : undefined}
          />
          <text x={4} y={sy(p) + 4} fontSize={10} fill="currentColor" fillOpacity={0.55}>
            {p.toFixed(2)}
          </text>
        </g>
      ))}

      {/* Confidence interval band on the threshold */}
      {ciLower != null && ciUpper != null ? (
        <rect
          x={sx(ciLower)}
          y={PAD_T}
          width={Math.max(1, sx(ciUpper) - sx(ciLower))}
          height={PLOT_H}
          fill="currentColor"
          fillOpacity={0.08}
        />
      ) : null}

      {/* Observation rug: correct along the top, incorrect along the bottom */}
      {observations.map((o, i) => (
        <line
          key={i}
          x1={sx(o.conf)}
          x2={sx(o.conf)}
          y1={o.correct ? PAD_T : PAD_T + PLOT_H - 8}
          y2={o.correct ? PAD_T + 8 : PAD_T + PLOT_H}
          stroke={o.correct ? "#059669" : "#e11d48"}
          strokeOpacity={0.5}
          strokeWidth={1}
        />
      ))}

      <path d={path} fill="none" stroke="currentColor" strokeWidth={2} />

      {/* The threshold itself */}
      {thresholdConf95 != null ? (
        <g>
          <line
            x1={sx(thresholdConf95)}
            x2={sx(thresholdConf95)}
            y1={PAD_T}
            y2={PAD_T + PLOT_H}
            stroke="#0284c7"
            strokeWidth={2}
          />
          <text
            x={Math.min(W - PAD_R - 60, sx(thresholdConf95) + 4)}
            y={PAD_T + 12}
            fontSize={11}
            fill="#0284c7"
          >
            {thresholdConf95.toFixed(3)}
          </text>
        </g>
      ) : null}

      {/* X axis */}
      <line
        x1={PAD_L}
        x2={W - PAD_R}
        y1={PAD_T + PLOT_H}
        y2={PAD_T + PLOT_H}
        stroke="currentColor"
        strokeOpacity={0.3}
      />
      {[0.1, 0.3, 0.5, 0.7, 0.9, 1.0].map((c) => (
        <text
          key={c}
          x={sx(c)}
          y={H - 12}
          fontSize={10}
          textAnchor="middle"
          fill="currentColor"
          fillOpacity={0.55}
        >
          {c.toFixed(1)}
        </text>
      ))}
      <text
        x={PAD_L + PLOT_W / 2}
        y={H - 1}
        fontSize={10}
        textAnchor="middle"
        fill="currentColor"
        fillOpacity={0.55}
      >
        Confianza BirdNET
      </text>
    </svg>
  );
}
