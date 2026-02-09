"use client";

import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CacaoRecord } from "@/lib/odk-types";

function getSurvivalColor(rate: number): string {
  if (rate >= 80) return "#22c55e";
  if (rate >= 50) return "#f97316";
  return "#ef4444";
}

export function CacaoCharts({ records }: { records: CacaoRecord[] }) {
  const byFarm = useMemo(() => {
    return records
      .filter((r) => r.farmCode && r.survivalRate != null)
      .map((r) => ({
        name: r.farmCode,
        rate: r.survivalRate!,
      }))
      .sort((a, b) => a.rate - b.rate);
  }, [records]);

  const byCommunity = useMemo(() => {
    const groups: Record<string, { total: number; count: number }> = {};
    for (const r of records) {
      if (!r.community || r.survivalRate == null) continue;
      if (!groups[r.community]) groups[r.community] = { total: 0, count: 0 };
      groups[r.community].total += r.survivalRate;
      groups[r.community].count++;
    }
    return Object.entries(groups)
      .map(([name, { total, count }]) => ({
        name,
        rate: Math.round((total / count) * 10) / 10,
      }))
      .sort((a, b) => b.rate - a.rate);
  }, [records]);

  return (
    <Tabs defaultValue="farm">
      <TabsList>
        <TabsTrigger value="farm">Por Finca</TabsTrigger>
        <TabsTrigger value="community">Por Comunidad</TabsTrigger>
      </TabsList>

      <TabsContent value="farm">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Tasa de Supervivencia por Finca</CardTitle>
          </CardHeader>
          <CardContent>
            {byFarm.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin datos</p>
            ) : (
              <ResponsiveContainer width="100%" height={Math.max(300, byFarm.length * 28)}>
                <BarChart
                  data={byFarm}
                  layout="vertical"
                  margin={{ left: 8, right: 16, top: 4, bottom: 4 }}
                >
                  <XAxis type="number" domain={[0, 100]} unit="%" />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={100}
                    tick={{ fontSize: 11 }}
                  />
                  <Tooltip formatter={(value) => [`${value}%`, "Supervivencia"]} />
                  <Bar dataKey="rate" radius={[0, 4, 4, 0]}>
                    {byFarm.map((entry, i) => (
                      <Cell key={i} fill={getSurvivalColor(entry.rate)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="community">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Supervivencia Promedio por Comunidad</CardTitle>
          </CardHeader>
          <CardContent>
            {byCommunity.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin datos</p>
            ) : (
              <ResponsiveContainer width="100%" height={Math.max(300, byCommunity.length * 40)}>
                <BarChart
                  data={byCommunity}
                  margin={{ left: 8, right: 16, top: 4, bottom: 4 }}
                >
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 11 }}
                    height={60}
                  />
                  <YAxis domain={[0, 100]} unit="%" />
                  <Tooltip formatter={(value) => [`${value}%`, "Supervivencia Prom."]} />
                  <Bar dataKey="rate" radius={[4, 4, 0, 0]}>
                    {byCommunity.map((entry, i) => (
                      <Cell key={i} fill={getSurvivalColor(entry.rate)} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  );
}
