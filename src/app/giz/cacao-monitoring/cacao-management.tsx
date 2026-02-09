"use client";

import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  Cell,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CacaoRecord } from "@/lib/odk-types";

const COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

export function CacaoManagement({ records }: { records: CacaoRecord[] }) {
  const byFertilization = useMemo(() => {
    const groups: Record<string, { total: number; count: number }> = {};
    for (const r of records) {
      if (!r.fertilized || r.survivalRate == null) continue;
      if (!groups[r.fertilized]) groups[r.fertilized] = { total: 0, count: 0 };
      groups[r.fertilized].total += r.survivalRate;
      groups[r.fertilized].count++;
    }
    return Object.entries(groups).map(([name, { total, count }]) => ({
      name,
      rate: Math.round((total / count) * 10) / 10,
    }));
  }, [records]);

  const cleaningsVsSurvival = useMemo(() => {
    return records
      .filter((r) => r.numCleanings != null && r.survivalRate != null)
      .map((r) => ({
        cleanings: r.numCleanings!,
        survival: r.survivalRate!,
        farm: r.farmCode,
      }));
  }, [records]);

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Supervivencia por Fertilización</CardTitle>
        </CardHeader>
        <CardContent>
          {byFertilization.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sin datos</p>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={byFertilization}>
                <XAxis dataKey="name" />
                <YAxis domain={[0, 100]} unit="%" />
                <Tooltip formatter={(value) => [`${value}%`, "Supervivencia Prom."]} />
                <Bar dataKey="rate" radius={[4, 4, 0, 0]}>
                  {byFertilization.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Limpiezas vs Supervivencia</CardTitle>
        </CardHeader>
        <CardContent>
          {cleaningsVsSurvival.length === 0 ? (
            <p className="text-sm text-muted-foreground">Sin datos</p>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <ScatterChart margin={{ left: 8, right: 16, top: 4, bottom: 4 }}>
                <XAxis
                  dataKey="cleanings"
                  name="Limpiezas"
                  type="number"
                  label={{ value: "Número de Limpiezas", position: "bottom", offset: -5, fontSize: 12 }}
                />
                <YAxis
                  dataKey="survival"
                  name="Supervivencia"
                  unit="%"
                  domain={[0, 100]}
                />
                <Tooltip
                  formatter={(value, name) => [
                    name === "Limpiezas" ? value : `${value}%`,
                    name,
                  ]}
                />
                <Scatter data={cleaningsVsSurvival} fill="var(--chart-1)">
                  {cleaningsVsSurvival.map((_, i) => (
                    <Cell key={i} fill="var(--chart-1)" opacity={0.7} />
                  ))}
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
