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

  const chartData = data.map((h) => ({
    name: h.habitatLabel,
    Min: h.tempMin,
    Prom: h.tempMean,
    Max: h.tempMax,
    fill: HABITAT_COLORS[h.habitatType] ?? "#94a3b8",
  }));

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
              angle={-20}
              textAnchor="end"
              height={60}
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
            <Bar dataKey="Min" fill="#3b82f6" name="Mín" />
            <Bar dataKey="Prom" fill="#f97316" name="Prom" />
            <Bar dataKey="Max" fill="#ef4444" name="Máx" />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}
