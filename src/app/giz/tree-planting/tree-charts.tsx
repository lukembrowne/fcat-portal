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
import type { TreeRecord } from "@/lib/odk-types";

const COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];

function countBy(trees: TreeRecord[], key: "species" | "farm") {
  const counts: Record<string, number> = {};
  for (const t of trees) {
    const val = t[key];
    if (val) counts[val] = (counts[val] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
}

export function TreeCharts({ trees }: { trees: TreeRecord[] }) {
  const bySpecies = useMemo(() => countBy(trees, "species"), [trees]);
  const byFarm = useMemo(() => countBy(trees, "farm"), [trees]);

  return (
    <Tabs defaultValue="species">
      <TabsList>
        <TabsTrigger value="species">Por Especie</TabsTrigger>
        <TabsTrigger value="farm">Por Finca</TabsTrigger>
      </TabsList>

      <TabsContent value="species">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Árboles por Especie</CardTitle>
          </CardHeader>
          <CardContent>
            {bySpecies.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin datos</p>
            ) : (
              <ResponsiveContainer width="100%" height={Math.max(250, bySpecies.length * 32)}>
                <BarChart
                  data={bySpecies}
                  layout="vertical"
                  margin={{ left: 8, right: 16, top: 4, bottom: 4 }}
                >
                  <XAxis type="number" />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={140}
                    tick={{ fontSize: 12 }}
                  />
                  <Tooltip />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                    {bySpecies.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="farm">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Árboles por Finca</CardTitle>
          </CardHeader>
          <CardContent>
            {byFarm.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin datos</p>
            ) : (
              <ResponsiveContainer width="100%" height={Math.max(250, byFarm.length * 32)}>
                <BarChart
                  data={byFarm}
                  layout="vertical"
                  margin={{ left: 8, right: 16, top: 4, bottom: 4 }}
                >
                  <XAxis type="number" />
                  <YAxis
                    type="category"
                    dataKey="name"
                    width={140}
                    tick={{ fontSize: 12 }}
                  />
                  <Tooltip />
                  <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                    {byFarm.map((_, i) => (
                      <Cell key={i} fill={COLORS[i % COLORS.length]} />
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
