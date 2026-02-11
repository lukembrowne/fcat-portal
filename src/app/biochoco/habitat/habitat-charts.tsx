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
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getHabitatName } from "../overview/types";
import type { HabitatAssessment } from "./types";
import {
  HABITAT_COLORS,
  HEIGHT_CLASS_LABELS,
  UNDERSTORY_LABELS,
} from "./types";

interface HabitatChartsProps {
  assessments: HabitatAssessment[];
}

interface HabitatGroup {
  habitatType: string;
  name: string;
  color: string;
  items: HabitatAssessment[];
}

function groupByHabitat(assessments: HabitatAssessment[]): HabitatGroup[] {
  const grouped: Record<string, HabitatAssessment[]> = {};
  for (const a of assessments) {
    const ht = a.habitatType || "unknown";
    if (!grouped[ht]) grouped[ht] = [];
    grouped[ht].push(a);
  }

  return Object.entries(grouped)
    .filter(([ht]) => ht !== "unknown")
    .map(([ht, items]) => ({
      habitatType: ht,
      name: getHabitatName(ht),
      color: HABITAT_COLORS[ht] ?? "#9E9E9E",
      items,
    }))
    .sort((a, b) => b.items.length - a.items.length);
}

export function HabitatCharts({ assessments }: HabitatChartsProps) {
  const groups = useMemo(() => groupByHabitat(assessments), [assessments]);

  const canopyData = useMemo(
    () =>
      groups.map((g) => ({
        name: g.name,
        color: g.color,
        avgCover:
          Math.round(
            (g.items.reduce((s, a) => s + a.canopyCoverPercent, 0) /
              g.items.length) *
              10
          ) / 10,
      })),
    [groups]
  );

  const heightData = useMemo(
    () =>
      groups.map((g) => {
        const counts: Record<string, number> = {};
        for (const a of g.items) {
          const hc = a.canopyHeightClass;
          if (hc) counts[hc] = (counts[hc] ?? 0) + 1;
        }
        return {
          name: g.name,
          color: g.color,
          ...counts,
        };
      }),
    [groups]
  );

  const understoryData = useMemo(
    () =>
      groups.map((g) => {
        const counts: Record<string, number> = {};
        for (const a of g.items) {
          const ud = a.understoryDensity;
          if (ud) counts[ud] = (counts[ud] ?? 0) + 1;
        }
        return {
          name: g.name,
          color: g.color,
          ...counts,
        };
      }),
    [groups]
  );

  const treeData = useMemo(
    () =>
      groups.map((g) => ({
        name: g.name,
        color: g.color,
        medium:
          Math.round(
            (g.items.reduce((s, a) => s + a.treesMedium, 0) /
              g.items.length) *
              10
          ) / 10,
        large:
          Math.round(
            (g.items.reduce((s, a) => s + a.treesLarge, 0) /
              g.items.length) *
              10
          ) / 10,
      })),
    [groups]
  );

  if (groups.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">Sin datos de evaluación</p>
    );
  }

  const heightKeys = Object.keys(HEIGHT_CLASS_LABELS);
  const heightColors = ["#60a5fa", "#3b82f6", "#1d4ed8"];

  const understoryKeys = Object.keys(UNDERSTORY_LABELS);
  const understoryColors = ["#86efac", "#22c55e", "#15803d"];

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {/* Canopy Cover */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Cobertura de Dosel (%)</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer
            width="100%"
            height={Math.max(200, canopyData.length * 40)}
          >
            <BarChart
              data={canopyData}
              layout="vertical"
              margin={{ left: 8, right: 16, top: 4, bottom: 4 }}
            >
              <XAxis type="number" domain={[0, 100]} unit="%" />
              <YAxis
                type="category"
                dataKey="name"
                width={120}
                tick={{ fontSize: 11 }}
              />
              <Tooltip formatter={(value) => [`${value}%`, "Cobertura"]} />
              <Bar dataKey="avgCover" radius={[0, 4, 4, 0]}>
                {canopyData.map((entry, i) => (
                  <Cell key={i} fill={entry.color} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Canopy Height */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Altura del Dosel</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer
            width="100%"
            height={Math.max(200, heightData.length * 40)}
          >
            <BarChart
              data={heightData}
              layout="vertical"
              margin={{ left: 8, right: 16, top: 4, bottom: 4 }}
            >
              <XAxis type="number" allowDecimals={false} />
              <YAxis
                type="category"
                dataKey="name"
                width={120}
                tick={{ fontSize: 11 }}
              />
              <Tooltip />
              <Legend />
              {heightKeys.map((key, i) => (
                <Bar
                  key={key}
                  dataKey={key}
                  name={HEIGHT_CLASS_LABELS[key]}
                  fill={heightColors[i]}
                  radius={[0, 4, 4, 0]}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Understory Density */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Densidad del Sotobosque</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer
            width="100%"
            height={Math.max(200, understoryData.length * 40)}
          >
            <BarChart
              data={understoryData}
              layout="vertical"
              margin={{ left: 8, right: 16, top: 4, bottom: 4 }}
            >
              <XAxis type="number" allowDecimals={false} />
              <YAxis
                type="category"
                dataKey="name"
                width={120}
                tick={{ fontSize: 11 }}
              />
              <Tooltip />
              <Legend />
              {understoryKeys.map((key, i) => (
                <Bar
                  key={key}
                  dataKey={key}
                  name={UNDERSTORY_LABELS[key]}
                  fill={understoryColors[i]}
                  radius={[0, 4, 4, 0]}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Trees per Habitat */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Árboles por Hábitat</CardTitle>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer
            width="100%"
            height={Math.max(200, treeData.length * 40)}
          >
            <BarChart
              data={treeData}
              layout="vertical"
              margin={{ left: 8, right: 16, top: 4, bottom: 4 }}
            >
              <XAxis type="number" />
              <YAxis
                type="category"
                dataKey="name"
                width={120}
                tick={{ fontSize: 11 }}
              />
              <Tooltip />
              <Legend />
              <Bar
                dataKey="medium"
                name="Medianos (prom.)"
                fill="#f59e0b"
                radius={[0, 4, 4, 0]}
              />
              <Bar
                dataKey="large"
                name="Grandes (prom.)"
                fill="#d97706"
                radius={[0, 4, 4, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}
