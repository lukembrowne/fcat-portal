"use client";

// Occupancy result charts, built on recharts to match the rest of the app
// (biochoco / finance / climate dashboards). Pure functions of their props —
// the parent Server Components pass plain serializable data.
import { useRouter } from "next/navigation";
import {
  BarChart,
  Bar,
  Cell,
  ErrorBar,
  ComposedChart,
  Area,
  Line,
  ScatterChart,
  Scatter,
  ReferenceLine,
  XAxis,
  YAxis,
  Tooltip,
  LabelList,
  ResponsiveContainer,
} from "recharts";
import type { CurvePoint, HabitatBar } from "@/lib/occupancy/curves";
import type { SpeciesSlope } from "@/lib/occupancy/meta-analysis";

const GREEN = "#059669";
const GREEN_REF = "#a7d7c1"; // reference-level bar (tenue)
const GRAY = "#cbd5e1"; // non-estimable
const WHISKER = "#334155";
const AXIS = "#94a3b8";

/** HabitatBar plus the estimability flag the page derives from the coefficients. */
export type HabitatBarView = HabitatBar & { estimable?: boolean };

const pctTick = (v: number) => `${Math.round(v * 100)}%`;

export function HabitatUseChart({ bars }: { bars: HabitatBarView[] }) {
  if (bars.length === 0) return null;
  const data = bars.map((b) => {
    const estimable = b.estimable !== false;
    const hasCI = estimable && b.lower != null && b.upper != null;
    return {
      habitat: b.habitat,
      psi: b.psi,
      estimable,
      isReference: b.isReference,
      lower: b.lower ?? null,
      upper: b.upper ?? null,
      // asymmetric error offsets for recharts ErrorBar ([minus, plus])
      ciErr: hasCI ? [b.psi - (b.lower as number), (b.upper as number) - b.psi] : [0, 0],
    };
  });
  const height = 40 + data.length * 40;

  return (
    <ResponsiveContainer width="100%" height={height} className="max-w-lg">
      <BarChart data={data} layout="vertical" margin={{ top: 4, right: 64, bottom: 4, left: 8 }}>
        <XAxis
          type="number"
          domain={[0, 1]}
          tickFormatter={pctTick}
          tick={{ fontSize: 10 }}
          stroke={AXIS}
        />
        <YAxis
          type="category"
          dataKey="habitat"
          width={120}
          tick={{ fontSize: 11 }}
          stroke={AXIS}
        />
        <Tooltip
          formatter={(_v, _n, p) => {
            const d = p.payload as (typeof data)[number];
            if (!d.estimable) return ["no estimable — datos insuficientes", "ψ"];
            const ci =
              d.lower != null && d.upper != null
                ? ` (IC 95%: ${pctTick(d.lower)}–${pctTick(d.upper)})`
                : "";
            return [`${pctTick(d.psi)}${ci}`, "ψ"];
          }}
          labelFormatter={(l) => String(l)}
        />
        <Bar dataKey="psi" radius={[0, 3, 3, 0]} isAnimationActive={false}>
          {data.map((d, i) => (
            <Cell
              key={i}
              fill={!d.estimable ? GRAY : d.isReference ? GREEN_REF : GREEN}
              fillOpacity={d.estimable ? 1 : 0.5}
            />
          ))}
          <ErrorBar dataKey="ciErr" width={4} strokeWidth={1.5} stroke={WHISKER} direction="x" />
          <LabelList
            dataKey="psi"
            position="right"
            content={(props) => {
              const { x, y, width, height: h, index } = props as {
                x: number;
                y: number;
                width: number;
                height: number;
                index: number;
              };
              const d = data[index];
              const label = d.estimable ? `${Math.round(d.psi * 100)}%` : "no estimable";
              return (
                <text
                  x={x + width + 6}
                  y={y + h / 2}
                  dominantBaseline="central"
                  fontSize={11}
                  fill={d.estimable ? "currentColor" : "#94a3b8"}
                >
                  {label}
                </text>
              );
            }}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// Serializable unit descriptor — a function prop can't cross the Server→Client
// boundary (this file is "use client"), so the parent passes a string and we
// resolve the tick formatter here.
type CurveUnit = "percent" | "meters" | "raw";
const UNIT_FORMAT: Record<CurveUnit, (v: number) => string> = {
  percent: (v) => `${(v * 100).toFixed(0)}%`,
  meters: (v) => `${v.toFixed(0)}`,
  raw: (v) => v.toFixed(2),
};

export function ResponseCurveChart({
  points,
  xLabel,
  xUnit = "raw",
}: {
  points: CurvePoint[];
  xLabel: string;
  xUnit?: CurveUnit;
}) {
  const xFormat = UNIT_FORMAT[xUnit];
  if (points.length < 2) return null;
  const hasBand = points.every((p) => p.lower != null && p.upper != null);
  const data = points.map((p) => ({
    x: p.x,
    psi: p.psi,
    band: hasBand ? [p.lower as number, p.upper as number] : undefined,
  }));
  const xs = points.map((p) => p.x);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);

  return (
    <div className="w-full max-w-lg">
      <ResponsiveContainer width="100%" height={220}>
        <ComposedChart data={data} margin={{ top: 8, right: 12, bottom: 24, left: 4 }}>
          <XAxis
            type="number"
            dataKey="x"
            domain={[xMin, xMax]}
            ticks={[xMin, xMax]}
            tickFormatter={xFormat}
            tick={{ fontSize: 10 }}
            stroke={AXIS}
            label={{ value: xLabel, position: "insideBottom", offset: -12, fontSize: 11 }}
          />
          <YAxis
            domain={[0, 1]}
            ticks={[0, 0.5, 1]}
            tick={{ fontSize: 10 }}
            stroke={AXIS}
            width={28}
          />
          <Tooltip
            formatter={(v, name) => {
              if (name === "ψ") return [`${((v as number) * 100).toFixed(0)}%`, "ψ"];
              const b = v as number[];
              return [`${(b[0] * 100).toFixed(0)}–${(b[1] * 100).toFixed(0)}%`, "IC 95%"];
            }}
            labelFormatter={(l) => `${xLabel}: ${xFormat(Number(l))}`}
          />
          {hasBand ? (
            <Area
              dataKey="band"
              stroke="none"
              fill={GREEN}
              fillOpacity={0.15}
              isAnimationActive={false}
              name="IC 95%"
            />
          ) : null}
          <Line
            dataKey="psi"
            stroke={GREEN}
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
            name="ψ"
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

const AMBER = "#b45309";

/**
 * Forest plot (point estimate + CI per species) on recharts. Two modes:
 * `effect` — slope covariate effects centered on a dashed zero line, colored by
 * sign; `probability` — occupancy on a fixed 0–1 domain, single accent color.
 * Species labels are clickable and navigate to that species' page.
 */
export function ForestPlotChart({
  rows,
  unitLabel,
  mode = "effect",
}: {
  rows: SpeciesSlope[];
  unitLabel: string;
  mode?: "effect" | "probability";
}) {
  const router = useRouter();
  if (rows.length === 0) return null;

  const isProb = mode === "probability";
  const data = rows.map((r) => ({
    y: r.species,
    stream: r.stream,
    x: r.estimate,
    lower: r.lower,
    upper: r.upper,
    positive: r.estimate >= 0,
    ciErr:
      r.lower != null && r.upper != null
        ? [r.estimate - r.lower, r.upper - r.estimate]
        : [0, 0],
  }));
  // Disambiguate the clickable label → species/stream (labels are species names).
  const bySpecies = new Map(rows.map((r) => [r.species, { species: r.species, stream: r.stream }]));

  const lo = isProb ? 0 : Math.min(0, ...rows.map((r) => r.lower ?? r.estimate));
  const hi = isProb ? 1 : Math.max(0, ...rows.map((r) => r.upper ?? r.estimate));
  const fmt = (v: number) => (isProb ? `${Math.round(v * 100)}%` : v.toFixed(2));
  const rowH = 26;
  const height = 44 + rows.length * rowH;

  const renderTick = (props: {
    x?: number | string;
    y?: number | string;
    payload?: { value?: string };
  }) => {
    const value = props.payload?.value ?? "";
    const info = bySpecies.get(value);
    const label = value.length > 24 ? value.slice(0, 23) + "…" : value;
    return (
      <text
        x={props.x}
        y={props.y}
        dy={4}
        textAnchor="end"
        fontSize={11}
        fontStyle="italic"
        fill="currentColor"
        style={{ cursor: "pointer" }}
        onClick={() =>
          info && router.push(`/ocupacion/${encodeURIComponent(info.species)}?stream=${info.stream}`)
        }
      >
        {label}
      </text>
    );
  };

  return (
    <div className="w-full max-w-2xl">
      <ResponsiveContainer width="100%" height={height}>
        <ScatterChart data={data} layout="vertical" margin={{ top: 8, right: 24, bottom: 8, left: 8 }}>
          <XAxis
            type="number"
            dataKey="x"
            domain={[lo, hi]}
            tickFormatter={fmt}
            tick={{ fontSize: 10 }}
            stroke={AXIS}
          />
          <YAxis
            type="category"
            dataKey="y"
            width={160}
            interval={0}
            tick={renderTick}
            stroke={AXIS}
          />
          <Tooltip
            cursor={{ strokeDasharray: "3 3" }}
            formatter={(_v, _n, p) => {
              const d = p.payload as (typeof data)[number];
              const ci =
                d.lower != null && d.upper != null ? ` (IC 95%: ${fmt(d.lower)}, ${fmt(d.upper)})` : "";
              return [`${fmt(d.x)}${ci}`, isProb ? "ψ" : unitLabel];
            }}
            labelFormatter={(l) => String(l)}
          />
          {!isProb ? (
            <ReferenceLine x={0} stroke="#94a3b8" strokeDasharray="3 3" />
          ) : null}
          <Scatter dataKey="x" isAnimationActive={false}>
            {data.map((d, i) => (
              <Cell key={i} fill={isProb ? GREEN : d.positive ? GREEN : AMBER} />
            ))}
            <ErrorBar
              dataKey="ciErr"
              width={4}
              strokeWidth={1.5}
              stroke={WHISKER}
              direction="x"
            />
          </Scatter>
        </ScatterChart>
      </ResponsiveContainer>
      {!isProb ? (
        <div className="flex justify-between text-[9px] text-muted-foreground px-2">
          <span>← menos {unitLabel}</span>
          <span>más {unitLabel} →</span>
        </div>
      ) : null}
    </div>
  );
}
