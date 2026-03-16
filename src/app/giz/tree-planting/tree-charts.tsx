"use client";

import { useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
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

const SPECIES_COLORS = [
  "#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231",
  "#911eb4", "#42d4f4", "#f032e6", "#bfef45", "#fabed4",
  "#469990", "#dcbeff", "#9A6324", "#800000", "#aaffc3",
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

function countByFarmAndSpecies(trees: TreeRecord[]) {
  const farmSpecies: Record<string, Record<string, number>> = {};
  const speciesSet = new Set<string>();

  for (const t of trees) {
    if (!t.farm || !t.species) continue;
    speciesSet.add(t.species);
    if (!farmSpecies[t.farm]) farmSpecies[t.farm] = {};
    farmSpecies[t.farm][t.species] = (farmSpecies[t.farm][t.species] ?? 0) + 1;
  }

  const allSpecies = [...speciesSet].sort();

  // Build rows sorted by total count descending
  const rows = Object.entries(farmSpecies)
    .map(([farm, speciesCounts]) => {
      const row: Record<string, string | number> = { name: farm };
      let total = 0;
      for (const sp of allSpecies) {
        const c = speciesCounts[sp] ?? 0;
        if (c > 0) row[sp] = c;
        total += c;
      }
      row._total = total;
      return row;
    })
    .sort((a, b) => (b._total as number) - (a._total as number));

  const speciesColorMap = new Map<string, string>();
  allSpecies.forEach((sp, i) => {
    speciesColorMap.set(sp, SPECIES_COLORS[i % SPECIES_COLORS.length]);
  });

  return { rows, allSpecies, speciesColorMap };
}

export function TreeCharts({ trees }: { trees: TreeRecord[] }) {
  const bySpecies = useMemo(() => countBy(trees, "species"), [trees]);
  const farmData = useMemo(() => countByFarmAndSpecies(trees), [trees]);

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
            {farmData.rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">Sin datos</p>
            ) : (
              <ResponsiveContainer width="100%" height={Math.max(250, farmData.rows.length * 32)}>
                <BarChart
                  data={farmData.rows}
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
                  <Tooltip
                    content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null;
                      const items = payload.filter((p) => (p.value as number) > 0);
                      if (items.length === 0) return null;
                      return (
                        <div className="rounded-md border bg-background p-2 shadow-sm text-xs">
                          <p className="font-medium mb-1">{label}</p>
                          {items.map((item) => (
                            <div key={item.dataKey as string} className="flex items-center gap-2">
                              <span
                                className="inline-block w-2.5 h-2.5 rounded-sm"
                                style={{ backgroundColor: item.color }}
                              />
                              <span>{item.dataKey}</span>
                              <span className="ml-auto font-medium">{item.value}</span>
                            </div>
                          ))}
                        </div>
                      );
                    }}
                  />
                  <Legend
                    wrapperStyle={{ fontSize: 11, maxHeight: 80, overflowY: "auto" }}
                  />
                  {farmData.allSpecies.map((species) => (
                    <Bar
                      key={species}
                      dataKey={species}
                      stackId="farm"
                      fill={farmData.speciesColorMap.get(species)}
                      radius={0}
                    />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  );
}
