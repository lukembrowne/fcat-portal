"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Brush,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Reading {
  id: number;
  timestamp: string;
  temperatureC: number;
  flagged: boolean;
}

export function TemperatureLineChart({ readings }: { readings: Reading[] }) {
  const chartData = readings.map((r) => ({
    timestamp: r.timestamp,
    temp: r.temperatureC,
    flagged: r.flagged,
  }));

  // Compute mean for reference line
  const mean =
    readings.reduce((sum, r) => sum + r.temperatureC, 0) / readings.length;

  // Show ~20 tick labels max
  const tickInterval = Math.max(1, Math.floor(chartData.length / 20));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Temperatura (°C)</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-center gap-4 text-xs text-muted-foreground mb-2">
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-5 h-0 border-t-2 border-orange-500" />
            Temperatura
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-5 h-0 border-t-2 border-dashed border-gray-400" />
            Promedio ({(Math.round(mean * 100) / 100).toFixed(1)}°C)
          </span>
        </div>
        <ResponsiveContainer width="100%" height={420}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="timestamp"
              tickFormatter={formatTickLabel}
              tick={{ fontSize: 10 }}
              interval={tickInterval}
              angle={-30}
              textAnchor="end"
              height={60}
            />
            <YAxis
              tick={{ fontSize: 11 }}
              domain={["auto", "auto"]}
              label={{
                value: "°C",
                angle: -90,
                position: "insideLeft",
                style: { fontSize: 12 },
              }}
            />
            <Tooltip
              wrapperStyle={{ zIndex: 10 }}
              content={({ active, payload }) => {
                if (!active || !payload?.[0]) return null;
                const item = payload[0].payload;
                return (
                  <div className="rounded-lg border bg-background p-2 shadow-sm text-sm whitespace-nowrap">
                    <p className="font-medium">{item.timestamp}</p>
                    <p className="text-orange-600">{item.temp}°C</p>
                    {item.flagged && (
                      <p className="text-amber-600 text-xs">Marcado</p>
                    )}
                  </div>
                );
              }}
            />
            <ReferenceLine
              y={Math.round(mean * 100) / 100}
              stroke="#9ca3af"
              strokeDasharray="5 5"
            />
            <Brush
              dataKey="timestamp"
              height={28}
              stroke="#94a3b8"
              travellerWidth={8}
              tickFormatter={formatTickLabel}
            />
            <Line
              type="monotone"
              dataKey="temp"
              stroke="var(--chart-2, #f97316)"
              dot={false}
              strokeWidth={1.5}
              connectNulls={false}
            />
          </LineChart>
        </ResponsiveContainer>
        <p className="text-xs text-muted-foreground mt-1">
          Arrastre el selector inferior para acercar un rango de fechas.
        </p>
      </CardContent>
    </Card>
  );
}

const MONTH_NAMES = [
  "", "Ene", "Feb", "Mar", "Abr", "May", "Jun",
  "Jul", "Ago", "Sep", "Oct", "Nov", "Dic",
];

function formatTickLabel(ts: string): string {
  // "2026-01-19 15:53:00" → "19 Ene 15:53"
  const [datePart, timePart] = ts.split(" ");
  if (!datePart) return ts;
  const [, month, day] = datePart.split("-");
  const m = parseInt(month ?? "0", 10);
  const hhmm = timePart ? timePart.slice(0, 5) : "";
  return `${day} ${MONTH_NAMES[m] ?? month} ${hhmm}`.trim();
}
