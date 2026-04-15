"use client";

import { useMemo } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CumulativePrecipRow } from "./actions";

interface CumulativePrecipChartProps {
  rows: CumulativePrecipRow[];
  years: number[];
}

// Curated categorical palette — distinct, harmonious hues that step around the color wheel.
// Years are assigned in order; current year is emphasized with a thicker stroke rather than color.
const YEAR_PALETTE = [
  "#f59e0b", // amber
  "#10b981", // emerald
  "#0ea5e9", // sky
  "#8b5cf6", // violet
  "#ef4444", // red
  "#14b8a6", // teal
  "#ec4899", // pink
  "#84cc16", // lime
];
const TODAY_MARKER_COLOR = "#111827";

function formatTodayLabel(): { label: string; mmdd: string } {
  const now = new Date();
  const months = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return {
    label: `${dd} ${months[now.getMonth()]}`,
    mmdd: `${mm}-${dd}`,
  };
}

export function CumulativePrecipChart({ rows, years }: CumulativePrecipChartProps) {
  const currentYear = new Date().getFullYear();

  // Flatten values into top-level keys for Recharts
  const chartData = useMemo(
    () =>
      rows.map((r) => ({
        label: r.label,
        mmdd: r.mmdd,
        ...r.values,
      })),
    [rows]
  );

  // Month-start ticks so the x-axis stays readable
  const monthTicks = useMemo(() => {
    const seen = new Set<string>();
    const ticks: string[] = [];
    for (const r of rows) {
      const month = r.mmdd.slice(0, 2);
      if (!seen.has(month) && r.mmdd.slice(3, 5) === "01") {
        seen.add(month);
        ticks.push(r.label);
      }
    }
    return ticks;
  }, [rows]);

  const today = formatTodayLabel();
  const todayInData = rows.some((r) => r.mmdd === today.mmdd);

  const colorForYear = (year: number) => {
    const idx = years.indexOf(year);
    return YEAR_PALETTE[idx % YEAR_PALETTE.length];
  };

  if (rows.length === 0) {
    return (
      <div className="flex items-center justify-center rounded-lg border border-dashed p-12 text-muted-foreground">
        No hay datos de precipitación desde 2022
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Precipitación acumulada desde el 1 de enero de cada año. Compare a la misma fecha para identificar años anómalamente secos o lluviosos. Esta vista siempre muestra años completos desde 2022 e ignora el filtro de fechas.
      </p>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Precipitación Acumulada Anual (mm)</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={420}>
            <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis
                dataKey="label"
                ticks={monthTicks}
                tick={{ fontSize: 11 }}
                interval={0}
              />
              <YAxis
                tick={{ fontSize: 11 }}
                label={{ value: "mm acumulados", angle: -90, position: "insideLeft", style: { fontSize: 11 } }}
              />
              <Tooltip
                formatter={(value) =>
                  typeof value === "number" ? `${value.toFixed(1)} mm` : "—"
                }
              />
              <Legend />
              {todayInData && (
                <ReferenceLine
                  x={today.label}
                  stroke={TODAY_MARKER_COLOR}
                  strokeDasharray="3 3"
                  label={{ value: "Hoy", position: "top", fill: TODAY_MARKER_COLOR, fontSize: 11 }}
                />
              )}
              {years.map((year) => {
                const isCurrent = year === currentYear;
                return (
                  <Line
                    key={year}
                    type="monotone"
                    dataKey={String(year)}
                    name={String(year)}
                    stroke={colorForYear(year)}
                    strokeWidth={isCurrent ? 3 : 1.75}
                    dot={false}
                    connectNulls
                    isAnimationActive={false}
                  />
                );
              })}
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}
