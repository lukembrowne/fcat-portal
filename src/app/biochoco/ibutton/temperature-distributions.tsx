"use client";

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { HABITAT_COLORS } from "@/app/biochoco/habitat/types";
import {
  BoxPlotChart,
  TEMP_STAT_LABEL,
  TEMP_STAT_DESCRIPTION,
  type BoxPlotGroup,
  type TempStat,
} from "./box-plot-chart";
import type { DeploymentStatPoint } from "./types";

const STATS: TempStat[] = ["tempMin", "tempMean", "tempMax"];

function groupByHabitat(points: DeploymentStatPoint[]): BoxPlotGroup[] {
  const by = new Map<string, BoxPlotGroup>();
  for (const p of points) {
    const existing = by.get(p.habitatType);
    if (existing) {
      existing.points.push(p);
    } else {
      by.set(p.habitatType, {
        key: p.habitatType,
        label: p.habitatLabel,
        color: HABITAT_COLORS[p.habitatType],
        points: [p],
      });
    }
  }
  return Array.from(by.values()).sort((a, b) =>
    a.label.localeCompare(b.label),
  );
}

export function TemperatureDistributions({
  points,
}: {
  points: DeploymentStatPoint[];
}) {
  const groups = useMemo(() => groupByHabitat(points), [points]);

  if (points.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Distribución de temperaturas por hábitat
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            No hay datos procesados todavía.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">
          Distribución de temperaturas por hábitat
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {STATS.map((stat) => (
            <BoxPlotChart
              key={stat}
              stat={stat}
              title={TEMP_STAT_LABEL[stat]}
              description={TEMP_STAT_DESCRIPTION[stat]}
              groups={groups}
            />
          ))}
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Cada punto representa un despliegue. Cuando hay varios despliegues en
          un mismo hábitat, la caja muestra los cuartiles (Q1–Q3) y la mediana,
          y los bigotes muestran el rango (Tukey, 1.5 × IQR). Pasa el cursor
          sobre un punto para ver el nombre del despliegue.
        </p>
      </CardContent>
    </Card>
  );
}
