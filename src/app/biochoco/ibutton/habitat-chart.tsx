"use client";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { HabitatSummary } from "./types";
import { HABITAT_COLORS } from "@/app/biochoco/habitat/types";

export function HabitatChart({ data }: { data: HabitatSummary[] }) {
  if (data.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Temperatura por Hábitat</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No hay datos procesados todavía.
          </p>
        </CardContent>
      </Card>
    );
  }

  const chartData = [
    { name: "Mín", ...Object.fromEntries(data.map((h) => [h.habitatLabel, h.tempMin])) },
    { name: "Prom", ...Object.fromEntries(data.map((h) => [h.habitatLabel, h.tempMean])) },
    { name: "Máx", ...Object.fromEntries(data.map((h) => [h.habitatLabel, h.tempMax])) },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Temperatura por Hábitat (°C)</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={chartData} barGap={2}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="name"
              tick={{ fontSize: 11 }}
            />
            <YAxis
              tick={{ fontSize: 11 }}
              label={{
                value: "°C",
                angle: -90,
                position: "insideLeft",
                style: { fontSize: 12 },
              }}
            />
            <Tooltip
              formatter={(value) => [`${value}°C`]}
              labelStyle={{ fontWeight: "bold" }}
            />
            <Legend />
            {data.map((h) => (
              <Bar
                key={h.habitatType}
                dataKey={h.habitatLabel}
                fill={HABITAT_COLORS[h.habitatType] ?? "#94a3b8"}
                name={h.habitatLabel}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
