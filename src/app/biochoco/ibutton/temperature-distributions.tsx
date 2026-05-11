"use client";

import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { HABITAT_COLORS } from "@/app/biochoco/habitat/types";
import { BoxPlot, type BoxPlotGroup, type BoxPlotPoint } from "@/components/box-plot";
import type { DeploymentStatPoint } from "./types";

type TempStat = "tempMin" | "tempMean" | "tempMax";

const TEMP_STAT_LABEL: Record<TempStat, string> = {
  tempMin: "Mínima",
  tempMean: "Promedio",
  tempMax: "Máxima",
};

const TEMP_STAT_DESCRIPTION: Record<TempStat, string> = {
  tempMin: "La temperatura más fría registrada en cada despliegue.",
  tempMean: "La temperatura promedio de cada despliegue.",
  tempMax: "La temperatura más caliente registrada en cada despliegue.",
};

const STATS: TempStat[] = ["tempMin", "tempMean", "tempMax"];

function buildGroups(
  points: DeploymentStatPoint[],
  stat: TempStat,
): BoxPlotGroup[] {
  const by = new Map<string, { label: string; color?: string; points: BoxPlotPoint[] }>();
  for (const p of points) {
    const value = p[stat];
    if (value == null || !Number.isFinite(value)) continue;
    const entry = by.get(p.habitatType) ?? {
      label: p.habitatLabel,
      color: HABITAT_COLORS[p.habitatType],
      points: [],
    };
    entry.points.push({
      id: p.deploymentId,
      value,
      primaryLabel: p.deploymentName,
      secondaryLabel: p.siteName ?? undefined,
      footnote: `${TEMP_STAT_LABEL[stat]}: ${value.toFixed(1)}°C`,
    });
    by.set(p.habitatType, entry);
  }
  return Array.from(by.entries())
    .map(([key, entry]) => ({
      key,
      label: entry.label,
      color: entry.color,
      points: entry.points,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

function formatTempValue(v: number): string {
  return `${v.toFixed(1)}°C`;
}

function formatTempTick(v: number): string {
  return v.toFixed(1);
}

export function TemperatureDistributions({
  points,
}: {
  points: DeploymentStatPoint[];
}) {
  const groupsByStat = useMemo(() => {
    return STATS.reduce<Record<TempStat, BoxPlotGroup[]>>(
      (acc, stat) => {
        acc[stat] = buildGroups(points, stat);
        return acc;
      },
      { tempMin: [], tempMean: [], tempMax: [] },
    );
  }, [points]);

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
            <BoxPlot
              key={stat}
              groups={groupsByStat[stat]}
              title={TEMP_STAT_LABEL[stat]}
              description={TEMP_STAT_DESCRIPTION[stat]}
              valueLabel={TEMP_STAT_LABEL[stat]}
              unitLabel="°C"
              formatValue={formatTempValue}
              formatTickLabel={formatTempTick}
              emptyMessage="No hay datos."
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
